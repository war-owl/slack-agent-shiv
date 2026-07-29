import { reasonFor } from "../failure.ts";
import type { EngineEvent } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { Thread } from "../thread.ts";
import { writesIn, type Write, type WriteScope } from "../writes/classify.ts";
import { code, link, mrkdwn } from "./mrkdwn.ts";

/**
 * Audit: every Write appended, permanently.
 *
 * The coworker acts unattended — it runs commands, calls APIs and opens pull requests
 * without stopping to confirm — so the Thread is the only account anyone ever sees of
 * what it did. Each Write it makes lands here as its own new message, and nothing
 * later touches it. Someone scrolling back a week afterwards can reconstruct exactly
 * what happened.
 *
 * The Reporter's other channel is Progress (`./status.ts`), and the two are opposite in
 * every respect on purpose. Progress is one message revised in place and is
 * provisional; a Write record is appended and is final. Confusing the two loses the
 * audit record, which is why they are separate words, separate modules, and never share
 * a message.
 *
 * One more difference, and it is deliberate: **a failed record complains every time**,
 * where progress complains once per Job. A stale status message is a courtesy lost; a
 * missing record is a hole in the only account there is — so each one is logged with
 * everything it knew, the log standing in as the fallback trail, and the Job's own
 * answer says how many are missing rather than letting the gap pass unnoticed.
 */

/**
 * The record's mark, and the whole of what makes it recognisable as one.
 *
 * A receipt: a permanent note of an action taken. Deliberately not the hourglass or
 * tick the status message uses — a reader skimming the Thread should be able to tell
 * the three kinds of message apart without reading any of them.
 */
const WRITE_RECORD_ICON = ":receipt:";

export interface AuditTrail {
  /**
   * Fold in what the engine just did, appending a record for anything that was a Write.
   *
   * Cheap and synchronous: the Slack call is queued rather than awaited, so an engine
   * emitting a hundred events does not stall on the network. {@link drain} is what
   * waits for the queue.
   */
  observe(event: EngineEvent): void;
  /** Wait for every queued record to have landed. Never rejects. */
  drain(): Promise<void>;
  /**
   * Records that landed. What is known to have happened out in the world — which is
   * what a Job that dies has to tell the human about before they ask it again.
   */
  readonly recorded: number;
  /** Records Slack refused. Non-zero means the trail has a hole in it. */
  readonly unrecorded: number;
}

export interface AuditDeps {
  slack: SlackClient;
  log: Logger;
  thread: Thread;
  /** What counts as a Write for this Job. */
  scope: WriteScope;
}

export function startAuditTrail(deps: AuditDeps): AuditTrail {
  /**
   * Records are chained rather than posted concurrently: they have to appear in the
   * order the Writes happened, and two overlapping `chat.postMessage` calls do not.
   */
  let pending: Promise<void> = Promise.resolve();
  let recorded = 0;
  let unrecorded = 0;

  /** Never rejects: a Slack refusal is a lost record, not a failed Job. */
  const append = async (write: Write): Promise<void> => {
    try {
      await deps.slack.postMessage({ thread: deps.thread, text: render(write) });
      recorded++;
    } catch (error) {
      unrecorded++;
      // Logged from the Write itself rather than from the rendered message: the log is
      // the only copy left of an action that has already happened out in the world, and
      // a record shortened to fit a Slack line is the wrong thing to keep it in.
      deps.log.warn(
        `Could not append a Write record to thread ${deps.thread.ts}: ${reasonFor(error)}. ` +
          `The action still happened, and this is what it was: ${plainly(write)}`,
      );
    }
  };

  return {
    observe(event: EngineEvent): void {
      for (const write of writesIn(event, deps.scope)) {
        pending = pending.then(() => append(write));
      }
    },

    drain: () => pending,

    get recorded() {
      return recorded;
    },

    get unrecorded() {
      return unrecorded;
    },
  };
}

/**
 * One Write, as Slack mrkdwn.
 *
 * The headline names what was done and the subject names what it was done to, linked
 * where there is somewhere to look. Everything in it is machine or model output, so
 * all of it is escaped.
 */
function render(write: Write): string {
  const headline = `${WRITE_RECORD_ICON} *${mrkdwn(write.action)}*`;
  const outcome = write.failure === undefined ? "" : ` — ${mrkdwn(write.failure)}`;
  const subject = write.url === undefined ? code(write.subject) : link(write.url, write.subject);

  const lines = [`${headline}${outcome} · ${subject}`];
  // How it was done, under what was done — and only when the subject is the thing
  // written rather than the doing, or this would say the same thing twice.
  if (write.via !== undefined) lines.push(`_via_ ${code(write.via)}`);
  if (write.detail !== undefined) lines.push(`_${mrkdwn(write.detail)}_`);
  return lines.join("\n");
}

/** The same Write for a log file: everything it knew, nothing shortened. */
function plainly(write: Write): string {
  return [
    write.action,
    write.failure === undefined ? "" : ` (${write.failure})`,
    `: ${write.subject}`,
    write.url === undefined ? "" : ` <${write.url}>`,
    write.via === undefined ? "" : ` via ${write.via}`,
    write.detail === undefined ? "" : ` — ${write.detail}`,
  ].join("");
}
