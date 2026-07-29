import { reasonFor } from "../failure.ts";
import type { Clock } from "../ports/clock.ts";
import type { Engine } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import { rootForPrompt, ROOT_NOTE_FILENAME, type RootNote } from "./root.ts";
import { SKILLS_DIRNAME } from "./skills.ts";

/**
 * The Librarian: the closing pass that decides whether anything was worth remembering.
 *
 * Four properties, and each of them is a decision made elsewhere that this module has to
 * keep:
 *
 * - **It is a separate call, not a second Turn in the Thread's Session.** Curation
 *   degrades when it competes with the task for attention, and a pass living in the
 *   Thread's Session would leave its bookkeeping in the context every future Job there
 *   resumes into. That is why it is handed the transcript rather than sharing one.
 * - **Writing nothing is a success.** Most Jobs — a question answered, a thread
 *   summarised — should leave the Vault untouched, and returning "nothing noteworthy" is
 *   the expected outcome rather than a failure to try. A fixed rule in either direction
 *   would fill the Vault with query residue or miss the interesting Jobs.
 * - **It never fails the Job.** The work is done and already reported by the time this
 *   runs. Every error here is swallowed, logged, and left behind.
 * - **It looks before it writes.** The pass searches the Vault first and updates what is
 *   already there by preference, because a Note is the *current belief* about its topic —
 *   there is no way to rewrite one in place without first finding it — and because
 *   filing blind is what makes placement drift between runs.
 *
 * It is not a trust boundary and must not be described as one. It is the same agent
 * lineage that just read whatever untrusted content the Job read; what makes a poisoned
 * Note survivable is the echoed diff, the bounded credential, and a human who can delete
 * a file.
 */

/**
 * The pass's opening line, and the marker that identifies it.
 *
 * Exported so that tests can tell the two kinds of call apart without matching on
 * incidental wording — the distinction is real and worth naming once.
 */
export const LIBRARIAN_HEADING = "You are the Librarian for this Vault.";

export interface LibrarianDeps {
  engine: Engine;
  clock: Clock;
  log: Logger;
  /** How long the pass may take before it is abandoned. Curation is best-effort. */
  timeoutMs: number;
  /**
   * The Job's own bound, so a person who stops a Job stops its curation too.
   *
   * Aborted from the outside when the Job is stopped; this module adds its own deadline
   * on top rather than replacing it.
   */
  signal: AbortSignal;
}

export interface LibrarianJob {
  notesDir: string;
  /** The Job's workspace, so the pass runs on the same desk with the same manual. */
  workingDirectory: string;
  root: RootNote;
  /** What the human asked for, verbatim. */
  request: string;
  /** What the Job did, from `jobs/transcript.ts`. */
  transcript: string;
  /** What it answered — the claim a Note would be making durable. */
  answer: string;
}

export interface LibrarianOutcome {
  /** What the pass said it did. Kept for the log, never posted into the Thread. */
  said: string;
  /** Why it did not finish, when it did not. */
  failure: string | undefined;
}

/**
 * Run the closing pass. Never throws, never rejects.
 *
 * What it *did* is not returned, because the Vault is the answer: whatever the pass
 * wrote is picked up by the snapshot diff and echoed into the Thread like any other
 * Write. This function's own result is for the instance's log.
 */
export async function runLibrarianPass(
  deps: LibrarianDeps,
  job: LibrarianJob,
): Promise<LibrarianOutcome> {
  const deadline = new AbortController();
  let tookTooLong = false;
  const expired = deps.clock.after(deps.timeoutMs, () => {
    tookTooLong = true;
    deadline.abort();
  });
  // The Job's own bound reaches the pass too, deliberately: "stop" should mean the whole
  // Job, and someone watching their Notes be rewritten after saying stop has not been
  // listened to.
  const stopped = (): void => deadline.abort();
  deps.signal.addEventListener("abort", stopped, { once: true });

  let said = "";
  try {
    const session = deps.engine.startOneOffSession({
      workingDirectory: job.workingDirectory,
      writableDirectories: [job.notesDir],
    });
    for await (const event of session.run(librarianPrompt(job), { signal: deadline.signal })) {
      if (event.type === "message") said = event.text;
      if (event.type === "turn-failed" || event.type === "engine-error") {
        return { said, failure: event.message };
      }
    }
    return { said, failure: undefined };
  } catch (error) {
    return { said, failure: abandonedBecause(deps, tookTooLong, error) };
  } finally {
    expired.stop();
    deps.signal.removeEventListener("abort", stopped);
  }
}

/**
 * Why the pass ended early, said in the terms of whichever thing ended it.
 *
 * The two causes abort the same signal and would otherwise be indistinguishable in the
 * log — and they are not the same event at all. One says the pass was too slow, which is
 * about the pass; the other says a person stopped the Job it belonged to, which is not a
 * fault of the pass and should never read as one.
 */
function abandonedBecause(deps: LibrarianDeps, tookTooLong: boolean, error: unknown): string {
  // Checked first: a Job that was stopped stops its curation too, and that is the
  // interesting fact rather than the timeout it also tripped on the way out.
  if (deps.signal.aborted) return "the Job it belonged to was stopped";
  if (tookTooLong) return `it ran past the ${Math.round(deps.timeoutMs / 1000)}s it is allowed`;
  return reasonFor(error);
}

/**
 * The pass's prompt.
 *
 * Long, and every paragraph in it is load-bearing. Read it as three things in order:
 * what the Vault currently looks like, what happened in the Job, and what to do about it
 * — with the invariants stated instead of a folder taxonomy, because the structure is the
 * Librarian's and it evolves.
 */
function librarianPrompt(job: LibrarianJob): string {
  return [
    LIBRARIAN_HEADING,
    "",
    "A job has just finished. Your only question is whether anything durable was learned",
    "— something that will still be true and still be useful next week, in a different",
    "thread. If so, write it down where it belongs. If not, write nothing and say so.",
    "",
    `Your Vault is the directory \`${job.notesDir}\`. You can read and write it.`,
    "",
    rootForPrompt(job.root),
    "",
    "## What happened",
    "",
    "They asked:",
    "",
    job.request,
    "",
    "What you did:",
    "",
    job.transcript === "" ? "(nothing was recorded)" : job.transcript,
    "",
    "What you told them:",
    "",
    job.answer === "" ? "(no answer was produced)" : job.answer,
    "",
    "## Look before you write",
    "",
    LOOK_FIRST,
    "",
    "## Then decide",
    "",
    DECIDE,
    "",
    "## How the Vault is kept",
    "",
    INVARIANTS,
    "",
    "Reply with one short paragraph saying what you looked at and what you did — or that",
    "you wrote nothing, and why not. Nobody sees this reply; it goes to the instance's log.",
  ].join("\n");
}

/**
 * The search step, first and separate because it is a prerequisite rather than a
 * courtesy: a Note is the current belief about its topic, so learning something
 * contradictory means rewriting *that* Note, and there is no rewriting in place without
 * first finding it.
 */
const LOOK_FIRST = [
  "Search the Vault before you write anything. Start from the Root note's links and",
  "follow the ones that could be about this. Then grep the Vault for the names, systems",
  "and people involved — filenames lie about their contents and Notes get filed by a",
  "person as easily as by you.",
  "",
  "You are looking for two things: a Note that already covers this topic, and the place",
  "where a Note about this topic would sit if there is not one. If you create something,",
  "say in your reply what you searched for and what you found — a claim that nothing",
  "similar exists is worth more when it names what was looked at.",
].join("\n");

/**
 * The decision, with the default made explicit in both directions: update rather than
 * create, and write nothing rather than write something thin.
 */
const DECIDE = [
  "**Update an existing Note** wherever anything close exists. This is the usual answer.",
  "A Note is what you currently believe about its topic, not a log of what you have",
  "believed — so if what you learned contradicts what it says, rewrite the part that is",
  "now wrong rather than appending a correction underneath. Two near-duplicate Notes is",
  "the failure mode to avoid: the next job reads one of them and does not know the other",
  "exists.",
  "",
  "**Create a Note** when the topic is genuinely new, and link it from whichever existing",
  "Note is its natural parent, so it is reachable by following links rather than only by",
  "searching.",
  "",
  "**Write nothing** when the job taught you nothing durable, which is most jobs. A",
  "question answered from data that will be different tomorrow, a summary, a one-off",
  "lookup, a calculation — none of those are things to remember. Writing nothing is a",
  "complete and correct outcome, and a Vault full of query residue is worse than a small",
  "one. Do not stretch for something to record.",
].join("\n");

/**
 * The invariants, standing in for a folder taxonomy that deliberately does not exist.
 *
 * The structure is the Librarian's and evolves; what is fixed is the shape a Note has to
 * hold to, and the Root note's grammar, which the wrapper enforces on the way in whatever
 * is written here.
 */
const INVARIANTS = [
  "- **One topic per Note**, named for the topic. The filename is the title.",
  "- **Reachable.** Every Note is linked from another Note with `[[wikilinks]]`. A Note",
  "  nothing links to is a Note the next job will never find.",
  `- **Follow the structure that is already there.** There is no prescribed set of`,
  "  folders — look at how the Vault is currently arranged and file alongside it. If a",
  "  person has moved things, their arrangement is now the right one.",
  `- **The Root note (\`${ROOT_NOTE_FILENAME}\`) is hubs only**, and it changes rarely.`,
  "  Add a line to it only when this Note belongs to no hub that is already on it. Its",
  "  grammar is a wikilink and a short label per line, nothing else — no headings, no",
  "  sentences, no explanation. Anything else there is stripped before it reaches you, so",
  "  prose written into it is prose thrown away. Why a hub matters goes in the hub's Note.",
  "- **Do not write frontmatter.** When a Note was last changed, and by which thread and",
  "  job, is stamped automatically after you finish.",
  "- **Never copy a credential, token or key into a Note.** The Vault is human-readable",
  "  by design and will plausibly be committed to git. Name the environment variable.",
  `- **You cannot write Skills.** The \`${SKILLS_DIRNAME}\` directory beside your Notes holds`,
  "  procedures people wrote for you, and it is read-only to you — the filesystem will",
  "  refuse the write, so do not spend a turn discovering that. If the job showed that one",
  "  of them is wrong or has drifted, write an ordinary Note saying what you found and",
  "  where, and link it from the topic it concerns. That is how the fix reaches the person",
  "  who can make it.",
  "- **Do not reorganise the Vault.** You are filing one thing, not tidying the library.",
].join("\n");
