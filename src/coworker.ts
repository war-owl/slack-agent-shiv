import type { Config } from "./config.ts";
import { reasonFor } from "./failure.ts";
import { boundJob, type JobBounds } from "./jobs/bounds.ts";
import { trackTurnDurability } from "./jobs/interruption.ts";
import { buildJobPrompt } from "./jobs/prompt.ts";
import { createJobQueue, type JobQueue, type Place, type WaitReason } from "./jobs/queue.ts";
import { droppedReceipt, queueReceipt, stopReply } from "./jobs/replies.ts";
import { reportFor, stopSentence, type JobReport } from "./jobs/report.ts";
import { isStopRequest } from "./jobs/request.ts";
import type { Clock } from "./ports/clock.ts";
import type { Engine, EngineSession, PlanStep, SessionOptions } from "./ports/engine.ts";
import type { Logger } from "./ports/log.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";
import type { SessionStore } from "./ports/sessions.ts";
import type { SlackClient } from "./ports/slack.ts";
import { runPreflight } from "./preflight.ts";
import { startAuditTrail, type AuditTrail } from "./reporter/audit.ts";
import { startJobStatus, type JobStatus } from "./reporter/status.ts";
import { threadKey, type Thread } from "./thread.ts";
import { prepareWorkspace } from "./workspace.ts";
import { writeScope } from "./writes/classify.ts";

/** A human addressing the coworker with a task, in the wrapper's own terms. */
export interface Mention {
  /** Slack's `event_id`. This is the Job's identity, and how a redelivery is caught. */
  eventId: string;
  thread: Thread;
  userId: string;
  text: string;
}

/** A Job that has started. It runs long after the mention has been acknowledged. */
export interface StartedJob {
  jobId: string;
  /** Resolves when the Job has reported back into the Thread. */
  completed: Promise<void>;
}

export interface CoworkerDeps {
  config: Config;
  slack: SlackClient;
  engine: Engine;
  clock: Clock;
  /** The `thread_ts → session id` mapping. The wrapper's only durable state. */
  sessions: SessionStore;
  inventoryProber: McpInventoryProber;
  log: Logger;
}

export interface Coworker {
  /** Checked before the first mention is accepted, so surprises surface at startup. */
  preflight(): Promise<void>;
  /**
   * Acknowledge a mention and start its Job. Returns once the acknowledgement is in
   * the Thread — the Job itself is still running.
   */
  handleMention(mention: Mention): Promise<StartedJob>;
}

export function createCoworker(deps: CoworkerDeps): Coworker {
  /**
   * The Jobs running right now, by Thread — the whole of what a hard-stop needs.
   *
   * Held in memory rather than on disk on purpose: a Job cannot outlive the process
   * that is streaming its subprocess, so an entry here that survived a restart would
   * name a Job that is already dead. The Session mapping is the only thing that
   * genuinely has to persist.
   *
   * At most one per Thread, and the queue is what makes that true.
   */
  const running = new Map<string, JobBounds>();
  const queue = createJobQueue({ maxConcurrentJobs: deps.config.bounds.maxConcurrentJobs });

  return {
    preflight: () => runPreflight(deps),

    async handleMention(mention: Mention): Promise<StartedJob> {
      // Checked before anything else is posted, and before any place in the queue is
      // taken: a stop is not a task, it must not wait behind the Job it is meant to
      // kill, and giving it a status message would leave an "On it" hanging over a
      // Thread where the answer is that something has ended.
      if (isStopRequest(mention.text)) {
        return { jobId: mention.eventId, completed: hardStop(deps, running, queue, mention) };
      }

      // Taken before the acknowledgement is posted, and synchronously: the promise is
      // that queued mentions are answered in the order they arrived, and a place taken
      // after an `await` would be a place in the order Slack's replies came back.
      const place = queue.join(mention.thread);

      // Acknowledged before any work starts. Bolt has already ack'd the socket event,
      // but the human needs to see their request land in the Thread — that is what
      // makes closing the laptop reasonable, and it is the whole difference between a
      // queued message and a dropped one.
      //
      // Either way it is **one** message, which the Job then owns. A Job starting now
      // gets its status message, which starts as "on it" and is edited in place from
      // then on. A Job that has to wait gets a receipt saying so, which its status
      // message takes over when it finally starts.
      let acknowledgement: Acknowledgement;
      try {
        acknowledgement = place.waiting
          ? { receipt: await postReceipt(deps, mention, place.waiting), waited: place.waiting }
          : { started: await statusFor(deps, mention.thread) };
      } catch (error) {
        // Nothing was said in the Thread, so this Job is not happening — and its place
        // has to go with it, or the Thread queues forever behind a Job that never runs.
        place.abandon();
        throw error;
      }

      return {
        jobId: mention.eventId,
        completed: runInTurn(deps, running, place, mention, acknowledgement),
      };
    },
  };
}

/**
 * How this Job's mention was acknowledged, and therefore what its status message does
 * when the work starts: it is either already posted, or a receipt waiting to become one.
 */
type Acknowledgement =
  | { started: JobStatus }
  /** The receipt's `ts`, and what it was waiting for — which the Job's prompt needs. */
  | { receipt: string; waited: WaitReason };

/**
 * Wait for this Job's place in its Thread, then run it — or clean up after it if the
 * Thread was stopped first.
 *
 * A dropped Job leaves a receipt behind promising to pick the message up, which is now
 * untrue. Correcting it matters more than it sounds: the stop reply says *how many* were
 * dropped, and leaving the messages themselves untouched asks the reader to work out
 * which ones from a count.
 */
async function runInTurn(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  place: Place,
  mention: Mention,
  acknowledgement: Acknowledgement,
): Promise<void> {
  const outcome = await place.take(() => runJob(deps, running, mention, acknowledgement));
  if (outcome === "ran" || !("receipt" in acknowledgement)) return;

  deps.log.info(`Dropped queued ${mention.eventId} in thread ${mention.thread.ts}`);
  try {
    await deps.slack.updateMessage({
      thread: mention.thread,
      ts: acknowledgement.receipt,
      text: droppedReceipt(),
    });
  } catch (error) {
    // The Job is already not happening and the stop reply has already said so. Failing
    // the delivery over a tidying edit would turn a cosmetic problem into a logged one.
    deps.log.warn(
      `Could not mark the queued message in thread ${mention.thread.ts} as dropped: ` +
        `${reasonFor(error)}`,
    );
  }
}

/** Tell the Thread its mention landed and will have to wait. Returns the receipt's ts. */
async function postReceipt(
  deps: CoworkerDeps,
  mention: Mention,
  wait: WaitReason,
): Promise<string> {
  const posted = await deps.slack.postMessage({
    thread: mention.thread,
    text: queueReceipt(wait),
  });
  deps.log.info(`Queued ${mention.eventId} in thread ${mention.thread.ts} (${wait.kind})`);
  return posted.ts;
}

/** The Job's one message, whether it is being posted now or taken over from a receipt. */
function statusFor(deps: CoworkerDeps, thread: Thread, adopt?: string): Promise<JobStatus> {
  return startJobStatus({
    slack: deps.slack,
    clock: deps.clock,
    log: deps.log,
    thread,
    adopt,
  });
}

/**
 * "Stop" from the Thread, which is the only interruption primitive there is.
 *
 * `exec` has no mid-turn steering, so there is nothing to send the agent — the wrapper
 * owns the subprocess and killing it is the whole mechanism. Both answers are posted
 * rather than left implicit: a person who typed "stop" and saw nothing would not know
 * whether it was heard, and if there was nothing running they should find that out
 * from the Thread rather than by waiting.
 *
 * **It empties the Thread's queue too.** Whatever is waiting was almost always written
 * about the work being abandoned, and a person who says stop and then watches the next
 * queued Job start immediately has every reason to conclude that stopping does not
 * work. What was dropped is said out loud, because those are messages that are now not
 * going to be answered.
 */
async function hardStop(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  queue: JobQueue,
  mention: Mention,
): Promise<void> {
  const bounds = running.get(threadKey(mention.thread));
  const stopped = bounds?.stop({ kind: "asked-to-stop", byUserId: mention.userId }) ?? false;
  const dropped = queue.dropWaiting(mention.thread);

  deps.log.info(
    (stopped
      ? `Hard-stopping the Job in thread ${mention.thread.ts} at ${mention.userId}'s request`
      : `Asked to stop thread ${mention.thread.ts}, where nothing is running`) +
      (dropped === 0 ? "" : `, dropping ${dropped} queued mention(s)`),
  );

  await deps.slack.postMessage({
    thread: mention.thread,
    text: stopReply({ stopped, dropped }),
  });
}

async function runJob(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  mention: Mention,
  acknowledgement: Acknowledgement,
): Promise<void> {
  // Armed and put in the index **before this function awaits anything**, and that is
  // load-bearing. The queue stops treating this Job as interruptible the moment it
  // hands it the Thread, so a stop arriving in the gap between there and here would
  // find nothing in either place and be answered with "nothing was running" — while
  // the Job it was aimed at carried on. The wall clock wants to start here too: a Job
  // that wedges before its first action is still wedged.
  const bounds = boundJob({ bounds: deps.config.bounds, clock: deps.clock });
  running.set(threadKey(mention.thread), bounds);
  const startedAt = deps.clock.now();

  // A Job that waited takes over the receipt it was acknowledged with, so the Thread
  // gets one message per Job either way. Its elapsed time starts here, at the work,
  // rather than at the mention: how long it queued is not how long it took.
  const status =
    "started" in acknowledgement
      ? acknowledgement.started
      : await statusFor(deps, mention.thread, acknowledgement.receipt);

  let answer = "";
  let failure: string | undefined;
  let plan: readonly PlanStep[] = [];
  /**
   * Undefined only until the workspace exists, because what counts as a Write depends
   * on where this Job's own desk is. Nothing has been written before that point.
   */
  let audit: AuditTrail | undefined;

  try {
    const workingDirectory = await prepareWorkspace(deps.config, mention.thread, deps.log);
    audit = startAuditTrail({
      slack: deps.slack,
      log: deps.log,
      thread: mention.thread,
      scope: await writeScope({
        workspaceDir: workingDirectory,
        vaultDir: deps.config.vaultDir,
        servers: deps.config.mcpServers,
      }),
    });

    const recorded = await deps.sessions.get(mention.thread);
    const session = openSession(deps, mention.thread, recorded?.id, {
      workingDirectory,
      writableDirectories: [deps.config.vaultDir],
    });
    const turns = trackTurnDurability({
      sessions: deps.sessions,
      thread: mention.thread,
      known: recorded,
    });
    // Decided before the first event, because it changes how the whole Turn should be
    // approached: a Session whose last Turn was interrupted has to be *told* so.
    const prompt = buildJobPrompt(mention, {
      resumingAfterInterruption: recorded?.interrupted ?? false,
      // Only when it waited behind a Job *in this Thread*. A Job held back by the
      // instance ceiling waited too, but nothing was said in this Thread meanwhile, so
      // telling it that it interrupted something would be telling it a false thing.
      queuedDuringPreviousJob:
        "waited" in acknowledgement && acknowledgement.waited.kind === "job-ahead",
    });

    try {
      for await (const event of session.run(prompt, { signal: bounds.signal })) {
        // Everything the engine does reaches the status message, which shows the plan
        // and the step it is on. Nothing is announced as its own message: individual
        // tool calls belong in the one message a glance can read.
        status.observe(event);
        // And anything that was a Write — an action against something outside itself —
        // is appended to the Thread permanently. The two channels see the same events
        // and are opposite in what they do with them.
        audit.observe(event);
        // And the bounds count it. None of the three exists in the engine.
        bounds.observe(event);
        // And the Turn boundaries are written down, so that a Job which stops here
        // leaves the next one able to tell that it did.
        await turns.observe(event);

        switch (event.type) {
          case "plan":
            // Kept for the report: if this Job dies, its plan is the only account of
            // what it meant to do and how far it got.
            plan = event.steps;
            break;
          case "message":
            // The last agent message is the answer; earlier ones are working notes.
            answer = event.text;
            break;
          case "turn-failed":
          case "engine-error":
            failure = event.message;
            break;
          default:
            // Session and Turn boundaries are the observers' above; everything else
            // the two output channels have already taken.
            break;
        }

        // A bound that tripped on this event has already killed the subprocess. Leaving
        // the loop closes the stream too, which is the belt to that braces.
        if (bounds.stoppedBy !== undefined) break;
      }
    } catch (error) {
      // The abort we asked for arrives here as a failure. It is not one, and the reason
      // the bound holds is a better account of what happened than the abort's own.
      if (bounds.stoppedBy === undefined) throw error;
    }
  } catch (error) {
    failure = reasonFor(error);
  } finally {
    bounds.release();
    // Unconditionally: the queue holds this Thread's next Job until this function's
    // promise settles, so nothing else can have taken this entry in the meantime.
    running.delete(threadKey(mention.thread));
  }

  if (bounds.stoppedBy !== undefined) {
    deps.log.warn(
      `Job ${mention.eventId} in thread ${mention.thread.ts} was stopped — ` +
        `${stopSentence(bounds.stoppedBy)} Tokens spent: ${bounds.tokensSpent}.`,
    );
  }
  deps.log.info(
    `Job ${mention.eventId} finished in ${deps.clock.now() - startedAt}ms ` +
      `(thread ${mention.thread.ts})`,
  );

  // Every Write record lands before the answer: the Thread has to read in the order
  // things happened, and the answer is the last word on the Job.
  await audit?.drain();
  const report: JobReport = reportFor({
    answer,
    stoppedBy: bounds.stoppedBy,
    failure,
    plan,
    recorded: audit?.recorded ?? 0,
    unrecorded: audit?.unrecorded ?? 0,
  });

  // Settled before the answer is posted, so the Thread reads in the order it happened
  // and the status has stopped moving by the time anyone reads the result.
  await status.settle(report.outcome);
  await deps.slack.postMessage({ thread: mention.thread, text: report.text });
}

/**
 * The Thread's Session: resumed if it has one, started if this is its first Job.
 *
 * Exactly one Session per Thread for the life of the Thread, so a follow-up three
 * days later remembers what was said. Sessions are never shared between Threads —
 * Threads have different audiences, and a Session that could see another Thread's
 * conversation would put a private channel one question from a public answer. The
 * only channel between them is the Vault (ADR-0003).
 */
function openSession(
  deps: CoworkerDeps,
  thread: Thread,
  sessionId: string | undefined,
  options: SessionOptions,
): EngineSession {
  if (sessionId === undefined) {
    deps.log.info(`Starting a new Session for thread ${thread.ts}`);
    return deps.engine.startSession(options);
  }
  deps.log.info(`Resuming Session ${sessionId} for thread ${thread.ts}`);
  return deps.engine.resumeSession(sessionId, options);
}
