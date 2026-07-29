import type { EngineEvent } from "../ports/engine.ts";

/**
 * What happened during a Job, in enough detail for someone else to judge it.
 *
 * Written for one reader: the Librarian's closing pass, which runs as a separate call
 * with none of the Job's context (`ports/engine.ts`, `startOneOffSession`). It has to
 * decide whether anything durable was learned, and it can only decide that from what it
 * is handed — so this is deliberately the *working*, not the answer. A summary would beg
 * the question, because "what was worth learning here" is exactly the judgement being
 * delegated.
 *
 * Bounded, because a Job can run for an hour: entries are trimmed individually and the
 * **middle** is dropped when the whole is too long. The middle rather than the tail —
 * a Job's shape is that it starts by looking around and ends by concluding something,
 * and both ends carry more than the twentieth `rg` in between.
 */

/** How much of one entry survives. Enough for a command and the head of its output. */
const MAX_ENTRY_CHARS = 400;

/**
 * How much transcript is handed over in total.
 *
 * Generous next to a Note and small next to a context window: the pass also gets the
 * Root note and its own instructions, and a transcript that crowds those out would be
 * curation deciding without knowing what the Vault already holds.
 */
const MAX_TRANSCRIPT_CHARS = 16 * 1024;

export interface JobTranscript {
  /** Fold in what the engine just did. Cheap and synchronous, like the other observers. */
  observe(event: EngineEvent): void;
  /** The transcript as text, bounded. Empty when the Job did nothing worth relaying. */
  text(): string;
}

export function recordTranscript(): JobTranscript {
  const entries: string[] = [];
  const add = (line: string): void => {
    entries.push(trimmed(line.replace(/\s*\n\s*/g, " ").trim()));
  };

  return {
    observe(event: EngineEvent): void {
      switch (event.type) {
        case "message":
          add(`Said: ${event.text}`);
          break;
        case "command":
          // Only the ending. A command that has merely started says nothing about what
          // it found, and the pass is being asked what was *learned*.
          if (event.status === "in-progress") break;
          add(
            `Ran: ${event.command}${event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`}` +
              (event.output.trim() === "" ? "" : ` → ${event.output.trim()}`),
          );
          break;
        case "tool-call":
          if (event.status === "in-progress") break;
          add(
            `Called ${event.server}.${event.tool}` +
              (event.status === "failed" ? ` (refused: ${event.error ?? "no reason"})` : "") +
              (event.result === undefined ? "" : ` → ${event.result}`),
          );
          break;
        case "file-change":
          if (event.status !== "completed") break;
          add(`Changed files: ${event.changes.map((change) => change.path).join(", ")}`);
          break;
        case "web-search":
          add(`Searched the web: ${event.query}`);
          break;
        case "turn-failed":
        case "engine-error":
          // Kept, because the pass runs after a failed Job as well as a finished one and
          // would otherwise read a transcript that stops mid-sentence as one that
          // concluded. A Job that broke may still have learned something before it broke;
          // what it must not do is file a confident Note about work that never landed.
          add(`The job then failed: ${event.message}`);
          break;
        case "plan":
          // Only the last plan is worth keeping — it is a revision of the same list, and
          // a transcript of every revision is a transcript of the coworker changing its
          // mind about ordering.
          if (entries.at(-1)?.startsWith("Plan: ") === true) entries.pop();
          add(
            `Plan: ${event.steps
              .map((step) => `${step.text} (${step.completed ? "done" : "not done"})`)
              .join("; ")}`,
          );
          break;
        default:
          // Reasoning is left out on purpose: it is the coworker talking to itself, it is
          // the largest thing in the stream by far, and a belief that only ever appeared
          // in reasoning is not one the Vault should be recording.
          break;
      }
    },

    text(): string {
      return bounded(entries);
    },
  };
}

function trimmed(entry: string): string {
  return entry.length <= MAX_ENTRY_CHARS ? entry : `${entry.slice(0, MAX_ENTRY_CHARS)}…`;
}

/**
 * The entries as one block, with the middle dropped if it does not fit.
 *
 * What was dropped is said, because a pass that reads a gap as "nothing happened there"
 * would file a confident Note about a Job it only saw half of.
 */
function bounded(entries: readonly string[]): string {
  const whole = entries.join("\n");
  if (whole.length <= MAX_TRANSCRIPT_CHARS) return whole;

  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;

  for (const entry of entries) {
    if (headChars + entry.length > half) break;
    head.push(entry);
    headChars += entry.length + 1;
  }
  for (const entry of [...entries].reverse()) {
    if (tailChars + entry.length > half) break;
    tail.unshift(entry);
    tailChars += entry.length + 1;
  }

  const skipped = entries.length - head.length - tail.length;
  if (skipped <= 0) return whole;
  return [...head, `… ${skipped} steps omitted from the middle of a long job …`, ...tail].join("\n");
}
