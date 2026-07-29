import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Thread } from "../thread.ts";
import type { VaultChange } from "./snapshot.ts";

/**
 * A Note's frontmatter: reading it, and stamping provenance into it.
 *
 * `CONTEXT.md` has frontmatter carrying when a Note was last modified and which Thread
 * and Job wrote it, so both a human and the coworker can judge staleness and origin.
 *
 * **The wrapper stamps it; the model never writes it.** Asking the coworker to record its
 * own provenance would make the one field that says "this came from the coworker" the one
 * field the coworker could forget or fake. It is stamped onto exactly the Notes that
 * changed while a Job ran, so a hand-edit made between Jobs is never re-attributed and
 * never overwritten.
 *
 * Both readers of a frontmatter block live here for one reason: the block is parsed by a
 * fiddly walk — a `---` that never closes is a horizontal rule and not an unterminated
 * block — and two copies of that walk would eventually disagree with each other about the
 * same file.
 */

export interface NoteProvenance {
  thread: Thread;
  /** Slack's `event_id` for the mention. The Job's identity everywhere else too. */
  jobId: string;
  /** From the injected clock, so a test can assert the stamp rather than tolerate it. */
  at: number;
  /**
   * Whether this Job can claim these changes as its own.
   *
   * False when more than one Job was writing to the Vault during the window they were seen
   * in: the filesystem cannot say which of them wrote what. `modified` is true either way;
   * `thread` and `job` would be a guess, so they are left off, and an absent field reads
   * as unknown where a wrong one reads as fact.
   */
  attributable: boolean;
}

/** The frontmatter keys the wrapper owns. Anything else in the block is left alone. */
const MODIFIED = "modified";
const THREAD = "thread";
const JOB = "job";

/**
 * A file's frontmatter lines and its body.
 *
 * Blank lines inside the block are dropped — they carry nothing in YAML, and keeping them
 * would mean reasoning about where a stamped key goes relative to a gap.
 */
export function splitFrontmatter(contents: string): { lines: string[]; body: string } {
  if (!contents.startsWith("---\n")) return { lines: [], body: contents };
  const closing = contents.indexOf("\n---", 3);
  if (closing === -1) return { lines: [], body: contents };
  const afterClosing = contents.indexOf("\n", closing + 1);
  return {
    lines: contents
      .slice(4, closing)
      .split("\n")
      .filter((line) => line.trim() !== ""),
    // A file that is nothing but frontmatter has no body, rather than having its own
    // frontmatter as a body.
    body: afterClosing === -1 ? "" : contents.slice(afterClosing + 1),
  };
}

/**
 * Stamp provenance onto every Note this Job changed. Returns how many were stamped.
 *
 * Only Markdown, and only additions and edits: a deleted Note has nowhere to put a stamp,
 * and a spreadsheet the coworker dropped into the Vault has no frontmatter to carry one.
 *
 * Failures are collected rather than thrown. This runs after the work is done and
 * reported — a Note that could not be stamped is still a Note, and losing the Job over its
 * frontmatter would be losing the thing for the label on it.
 */
export async function stampChangedNotes(
  notesDir: string,
  changes: readonly VaultChange[],
  provenance: NoteProvenance,
): Promise<{ stamped: number; failures: { path: string; error: unknown }[] }> {
  let stamped = 0;
  const failures: { path: string; error: unknown }[] = [];

  for (const change of changes) {
    if (change.kind === "delete" || !change.path.endsWith(".md")) continue;
    const file = path.join(notesDir, ...change.path.split("/"));
    try {
      const contents = await readFile(file, "utf8");
      const updated = withProvenance(contents, provenance);
      if (updated !== contents) {
        await writeFile(file, updated, "utf8");
        stamped++;
      }
    } catch (error) {
      failures.push({ path: change.path, error });
    }
  }

  return { stamped, failures };
}

/**
 * The Note's contents with its provenance brought up to date.
 *
 * A block that is already there is edited **in place**: a key the wrapper owns is replaced
 * where it sits, a missing one is appended, and everything else survives in its own
 * order — because a human's `tags:` or `aliases:` are theirs, Obsidian reads them, and
 * reordering someone's file to stamp a timestamp into it is not an edit they asked for.
 */
function withProvenance(contents: string, provenance: NoteProvenance): string {
  const stamps: [string, string][] = [
    [MODIFIED, new Date(provenance.at).toISOString()],
    // One value rather than a channel and a timestamp, because a Thread *is* one thing and
    // this is the same pair Slack puts in a permalink.
    ...(provenance.attributable
      ? ([
          [THREAD, `${provenance.thread.channel}/${provenance.thread.ts}`],
          [JOB, provenance.jobId],
        ] satisfies [string, string][])
      : []),
  ];

  const { lines, body } = splitFrontmatter(contents);
  const block = lines.filter(
    // A stale attribution is dropped when this Job cannot replace it: it named the last
    // Job known to have written the Note, and that is no longer what happened to it.
    (line) => provenance.attributable || !(starts(line, THREAD) || starts(line, JOB)),
  );

  for (const [key, value] of stamps) {
    const at = block.findIndex((line) => starts(line, key));
    if (at === -1) block.push(`${key}: ${value}`);
    else block[at] = `${key}: ${value}`;
  }

  return ["---", ...block, "---", body].join("\n");
}

function starts(line: string, key: string): boolean {
  return line.startsWith(`${key}:`);
}
