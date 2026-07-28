import type { Config } from "./config.ts";
import { buildJobPrompt } from "./jobs/prompt.ts";
import type { Clock } from "./ports/clock.ts";
import type { Engine, EngineSession, SessionOptions } from "./ports/engine.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";
import type { SessionStore } from "./ports/sessions.ts";
import type { SlackClient } from "./ports/slack.ts";
import { runPreflight } from "./preflight.ts";
import type { Thread } from "./thread.ts";
import { prepareWorkspace } from "./workspace.ts";

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

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
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

const ACKNOWLEDGEMENT = "On it — I'll report back in this thread when I'm done.";

export function createCoworker(deps: CoworkerDeps): Coworker {
  return {
    preflight: () => runPreflight(deps),

    async handleMention(mention: Mention): Promise<StartedJob> {
      // Acknowledged before any work starts. Bolt has already ack'd the socket
      // event, but the human needs to see their request land in the Thread — that
      // is what makes closing the laptop reasonable.
      await deps.slack.postMessage({ thread: mention.thread, text: ACKNOWLEDGEMENT });

      return { jobId: mention.eventId, completed: runJob(deps, mention) };
    },
  };
}

async function runJob(deps: CoworkerDeps, mention: Mention): Promise<void> {
  const startedAt = deps.clock.now();
  let text: string;

  try {
    const workingDirectory = await prepareWorkspace(deps.config, mention.thread, deps.log);
    const session = await openSession(deps, mention.thread, {
      workingDirectory,
      writableDirectories: [deps.config.vaultDir],
    });

    let answer = "";
    let failure: string | undefined;
    for await (const event of session.run(buildJobPrompt(mention))) {
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
          // Everything else is progress and audit, which tickets 03 and 04 own.
          break;
      }
    }
    text = finalReport(answer, failure);
  } catch (error) {
    text = stoppedShort(error instanceof Error ? error.message : String(error));
  }

  deps.log.info(
    `Job ${mention.eventId} finished in ${deps.clock.now() - startedAt}ms ` +
      `(thread ${mention.thread.ts})`,
  );

  await deps.slack.postMessage({ thread: mention.thread, text });
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

function finalReport(answer: string, failure: string | undefined): string {
  if (answer.trim() === "") {
    return failure === undefined
      ? "I finished without producing an answer. That is not a result — ask me again, " +
          "and if it keeps happening the instance logs will say why."
      : stoppedShort(failure);
  }
  // An answer that arrived before a failure is still the answer. Losing it and
  // reporting only the error would throw away work the human can use.
  return failure === undefined ? answer : `${answer}\n\n---\n${stoppedShort(failure)}`;
}

/**
 * An honest failure, not a silent one. Ticket 05 expands this into what completed,
 * what did not, and which bound stopped it; the skeleton at least never swallows.
 */
function stoppedShort(reason: string): string {
  return (
    `I stopped before finishing this: ${reason}\n\n` +
    "Anything I had already done out in the world has not been undone, so it is worth " +
    "checking before you ask me again."
  );
}
