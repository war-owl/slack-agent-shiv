import type { Config } from "./config.ts";
import { reasonFor } from "./failure.ts";
import { buildJobPrompt } from "./jobs/prompt.ts";
import type { Clock } from "./ports/clock.ts";
import type { Engine, EngineSession, SessionOptions } from "./ports/engine.ts";
import type { Logger } from "./ports/log.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";
import type { SessionStore } from "./ports/sessions.ts";
import type { SlackClient } from "./ports/slack.ts";
import { runPreflight } from "./preflight.ts";
import { startAuditTrail, type AuditTrail } from "./reporter/audit.ts";
import { startJobStatus, type JobOutcome, type JobStatus } from "./reporter/status.ts";
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
  return {
    preflight: () => runPreflight(deps),

    async handleMention(mention: Mention): Promise<StartedJob> {
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

      return { jobId: mention.eventId, completed: runJob(deps, mention, status) };
    },
  };
}

async function runJob(deps: CoworkerDeps, mention: Mention, status: JobStatus): Promise<void> {
  const startedAt = deps.clock.now();
  let report: JobReport;
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
    const session = await openSession(deps, mention.thread, {
      workingDirectory,
      writableDirectories: [deps.config.vaultDir],
    });

    let answer = "";
    let failure: string | undefined;
    for await (const event of session.run(buildJobPrompt(mention))) {
      // Everything the engine does reaches the status message, which shows the plan
      // and the step it is on. Nothing is announced as its own message: individual
      // tool calls belong in the one message a glance can read.
      status.observe(event);
      // And anything that was a Write — an action against something outside itself —
      // is appended to the Thread permanently. The two channels see the same events
      // and are opposite in what they do with them.
      audit.observe(event);

      switch (event.type) {
        case "session-started":
          // Recorded now rather than at the end of the Job: this is the first moment
          // the Session has an identity, and a crash after it would otherwise orphan
          // the Session on the engine's disk and start this Thread over from nothing.
          await deps.sessions.set(mention.thread, event.sessionId);
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
          // Everything else both output channels have already taken.
          break;
      }
    }
    report = finalReport(answer, failure);
  } catch (error) {
    report = stoppedShort(reasonFor(error));
  }

  deps.log.info(
    `Job ${mention.eventId} finished in ${deps.clock.now() - startedAt}ms ` +
      `(thread ${mention.thread.ts})`,
  );

  // Every Write record lands before the answer: the Thread has to read in the order
  // things happened, and the answer is the last word on the Job.
  await audit?.drain();
  report = withMissingRecords(report, audit?.unrecorded ?? 0);

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
async function openSession(
  deps: CoworkerDeps,
  thread: Thread,
  options: SessionOptions,
): Promise<EngineSession> {
  const recorded = await deps.sessions.get(thread);
  if (recorded === undefined) {
    deps.log.info(`Starting a new Session for thread ${thread.ts}`);
    return deps.engine.startSession(options);
  }
  deps.log.info(`Resuming Session ${recorded} for thread ${thread.ts}`);
  return deps.engine.resumeSession(recorded, options);
}

/**
 * How the Job ended, said two ways: the message that goes into the Thread, and the
 * state the status message settles into.
 *
 * They are one value because they are one judgement. Deciding "did this finish?" twice
 * — once to write the prose and once to pick the icon — is how a Thread ends up with
 * an apology under a green tick.
 */
interface JobReport {
  text: string;
  outcome: JobOutcome;
}

function finalReport(answer: string, failure: string | undefined): JobReport {
  if (answer.trim() === "") {
    return failure === undefined
      ? {
          text:
            "I finished without producing an answer. That is not a result — ask me " +
            "again, and if it keeps happening the instance logs will say why.",
          outcome: "stopped",
        }
      : stoppedShort(failure);
  }
  // An answer that arrived before a failure is still the answer. Losing it and
  // reporting only the error would throw away work the human can use.
  if (failure === undefined) return { text: answer, outcome: "finished" };
  return { text: `${answer}\n\n---\n${stoppedShort(failure).text}`, outcome: "stopped" };
}

/**
 * A Job that could not record everything it did says so where the human is reading.
 *
 * The Job itself still succeeded — a Slack refusal does not undo the work, and the
 * outcome is left alone. But the Thread is the accountability record, and a record
 * with a silent hole in it is worse than one that admits to the hole.
 */
function withMissingRecords(report: JobReport, missing: number): JobReport {
  if (missing === 0) return report;
  const what =
    missing === 1
      ? "One action I took could not be recorded"
      : `${missing} of the actions I took could not be recorded`;
  return {
    outcome: report.outcome,
    text:
      `${report.text}\n\n---\n${what} in this thread — Slack refused the message. ` +
      "What I did still happened; the instance's own log has the records.",
  };
}

/**
 * An honest failure, not a silent one. Ticket 05 expands this into what completed,
 * what did not, and which bound stopped it; the skeleton at least never swallows.
 */
function stoppedShort(reason: string): JobReport {
  return {
    text:
      `I stopped before finishing this: ${reason}\n\n` +
      "Anything I had already done out in the world has not been undone, so it is " +
      "worth checking before you ask me again.",
    outcome: "stopped",
  };
}
