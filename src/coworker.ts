import type { Config } from "./config.ts";
import { reasonFor } from "./failure.ts";
import { boundJob, type JobBounds } from "./jobs/bounds.ts";
import { trackTurnDurability } from "./jobs/interruption.ts";
import { buildJobPrompt } from "./jobs/prompt.ts";
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
import type { Thread } from "./thread.ts";
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
   * Build/06 replaces this with a per-Thread queue, which needs the same index.
   */
  const running = new Map<string, JobBounds>();

  return {
    preflight: () => runPreflight(deps),

    async handleMention(mention: Mention): Promise<StartedJob> {
      // Checked before anything else is posted: a stop is not a task, and giving it a
      // status message would leave an "On it" hanging over a Thread where the answer
      // is that something has ended.
      if (isStopRequest(mention.text)) {
        return { jobId: mention.eventId, completed: hardStop(deps, running, mention) };
      }

      // Acknowledged before any work starts. Bolt has already ack'd the socket
      // event, but the human needs to see their request land in the Thread — that
      // is what makes closing the laptop reasonable.
      //
      // The acknowledgement *is* the status message. One message that starts as "on
      // it" and is edited in place from then on is one fewer thing in the Thread than
      // an acknowledgement followed by a separate progress message.
      const status = await startJobStatus({
        slack: deps.slack,
        clock: deps.clock,
        log: deps.log,
        thread: mention.thread,
      });

      return { jobId: mention.eventId, completed: runJob(deps, running, mention, status) };
    },
  };
}

/**
 * "Stop" from the Thread, which is the only interruption primitive there is.
 *
 * `exec` has no mid-turn steering, so there is nothing to send the agent — the wrapper
 * owns the subprocess and killing it is the whole mechanism. Both answers are posted
 * rather than left implicit: a person who typed "stop" and saw nothing would not know
 * whether it was heard, and if there was nothing running they should find that out
 * from the Thread rather than by waiting.
 */
async function hardStop(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  mention: Mention,
): Promise<void> {
  const bounds = running.get(threadKey(mention.thread));
  const stopped = bounds?.stop({ kind: "asked-to-stop", byUserId: mention.userId }) ?? false;

  deps.log.info(
    stopped
      ? `Hard-stopping the Job in thread ${mention.thread.ts} at ${mention.userId}'s request`
      : `Asked to stop thread ${mention.thread.ts}, where nothing is running`,
  );

  await deps.slack.postMessage({
    thread: mention.thread,
    text: stopped
      ? "Stopping now. I'll say where I had got to in a moment."
      : "Nothing of mine is running in this thread, so there was nothing to stop.",
  });
}

async function runJob(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  mention: Mention,
  status: JobStatus,
): Promise<void> {
  const startedAt = deps.clock.now();
  // Armed before the workspace exists, because the wall clock is there to catch a Job
  // that is stuck and preparing a workspace is not exempt from being stuck.
  const bounds = boundJob({ bounds: deps.config.bounds, clock: deps.clock });
  running.set(threadKey(mention.thread), bounds);

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
    // Only if it is still this Job's. Nothing yet stops two Jobs overlapping in one
    // Thread — build/06's queue is what does — and until then the finishing one must
    // not take a running one's place in the index out with it.
    if (running.get(threadKey(mention.thread)) === bounds) {
      running.delete(threadKey(mention.thread));
    }
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

/** One Thread, named the way this process indexes the Jobs running inside it. */
function threadKey(thread: Thread): string {
  return `${thread.channel} ${thread.ts}`;
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
