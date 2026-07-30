import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * What the Vault contained, before and after a Job.
 *
 * This module exists because of a gap [build/04](../../.scratch/slack-coworker/build/04-audit-writes.md)
 * left open on purpose. Write records are classified from the engine's event stream,
 * which sees a file-editing tool exactly and a shell command only by guessing at its
 * text — so `cp note.md $VAULT/`, `echo … > $VAULT/note.md`, `sed -i` and
 * `rm $VAULT/old.md` are all real Writes to the human's own Vault that left no record,
 * and lengthening a table of command patterns does not change the shape of that problem.
 *
 * Asking the filesystem does. A snapshot before and after answers both questions at
 * once: **what changed**, whatever tool changed it, and **what it changed to**, which is
 * the diff the server log needs to retain. Nothing can hide from it, because nothing is being
 * inferred — the Vault either has different bytes in it afterwards or it does not.
 *
 * A Vault record cannot be appended until a settlement point because its diff only exists
 * after the work or Librarian pass. Full content is more useful than an earlier record
 * saying only that a file was touched.
 */

/**
 * Directories a Vault has that are not the Vault.
 *
 * `.obsidian` is the app's own workspace state, rewritten every time a human so much as
 * scrolls, and reporting it as a change the coworker made would be a lie told several
 * times a session. `.git` and `.trash` are the same story: real files, none of them a
 * belief.
 */
export const NOT_CONTENT = new Set([".git", ".obsidian", ".trash", "node_modules"]);

/**
 * How much of a file is read for diffing.
 *
 * A Note is prose and nowhere near this. Something in the Vault that is larger is data
 * the coworker was given rather than something it believes, and holding two copies of it
 * in memory to build a diff is the wrong use of the machine — so its change is
 * still recorded, just without a diff body.
 */
const MAX_DIFFED_BYTES = 256 * 1024;

/** How many changed lines a diff shows before it stops and says how many are left. */
const DIFF_MAX_LINES = 24;

/** And how many characters, because one changed line can be a whole minified file. */
const DIFF_MAX_CHARS = 1_400;

/**
 * The point past which diffing two files is not worth the arithmetic.
 *
 * The line matcher is quadratic in the number of changed lines. For Notes that is
 * nothing; for a large generated file it is a Job stalling on bookkeeping, so past
 * this the diff degrades to "all of it went, all of this arrived" rather than getting
 * cleverer.
 */
const MAX_DIFF_CELLS = 400_000;

interface FileState {
  /** The file's text, or undefined when it is binary or too large to hold. */
  text: string | undefined;
  bytes: number;
  /**
   * How a file with no readable text is told apart from itself, and undefined when
   * {@link text} already does that job.
   *
   * Size alone is not enough — a binary rewritten to the same length would compare equal
   * and go unrecorded, which is the one thing this module exists to prevent. Small enough
   * to hash, and it is hashed; too large to read at all, and it is size and modification
   * time instead, which over-records a file rewritten identically. That is the direction
   * to be wrong in: a spurious record is visible and a reader can dismiss it.
   */
  mark: string | undefined;
}

export interface VaultSnapshot {
  /** Vault-relative path → what was in it. Relative because that is how a human says it. */
  readonly files: ReadonlyMap<string, FileState>;
}

export interface VaultChange {
  /** Vault-relative, with forward slashes — the name a wikilink and a human both use. */
  path: string;
  kind: "add" | "update" | "delete";
  /** What changed, as `+`/`-` lines. Undefined when there is nothing readable to show. */
  diff: string | undefined;
}

/**
 * Make sure the Vault directory exists.
 *
 * A fresh install points at `./vault` and nothing has created it, and the engine is
 * handed the Vault as a writable directory before the coworker writes its first Note —
 * so a first Job would otherwise be a Job whose memory has no home. Creating an empty
 * directory is not writing in it: the Vault stays the human's, and this is the same
 * courtesy as creating the workspace.
 */
export async function ensureVault(notesDir: string): Promise<void> {
  await mkdir(notesDir, { recursive: true });
}

/**
 * Read the Vault as it stands.
 *
 * A Vault that does not exist yet snapshots as empty rather than throwing: the first Job
 * against a fresh instance is the ordinary case, and it is also the one that creates the
 * directory.
 */
export async function snapshotVault(notesDir: string): Promise<VaultSnapshot> {
  const files = new Map<string, FileState>();
  await walk(notesDir, notesDir, files);
  return { files };
}

/**
 * What happened to the Vault between two snapshots.
 *
 * Sorted by path rather than by anything about the change, because a reader scanning
 * several records wants them in the order the same files appear in Obsidian.
 */
export function changesBetween(before: VaultSnapshot, after: VaultSnapshot): VaultChange[] {
  const changes: VaultChange[] = [];

  for (const [file, state] of after.files) {
    const previous = before.files.get(file);
    if (previous === undefined) {
      changes.push({ path: file, kind: "add", diff: diffOf(undefined, state) });
    } else if (
      previous.text !== state.text ||
      previous.bytes !== state.bytes ||
      previous.mark !== state.mark
    ) {
      changes.push({ path: file, kind: "update", diff: diffOf(previous, state) });
    }
  }

  for (const [file, state] of before.files) {
    if (!after.files.has(file)) {
      // What a deleted Note said is shown, not just that it went. Deleting a Note
      // removes a belief completely, and the diff is the only remaining trace of what
      // the coworker used to think — which is exactly what someone reviewing an
      // unexpected deletion has come to read.
      changes.push({ path: file, kind: "delete", diff: diffOf(state, undefined) });
    }
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(
  notesDir: string,
  directory: string,
  into: Map<string, FileState>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // Absent or unreadable. An absent Vault is the fresh-instance case; an unreadable
    // one is a configuration problem that the Job's own failure will describe better
    // than a half-read snapshot would.
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (NOT_CONTENT.has(entry.name)) continue;

    if (entry.isDirectory()) {
      await walk(notesDir, full, into);
      continue;
    }

    if (entry.isFile()) {
      into.set(relative(notesDir, full), await stateOf(full));
      continue;
    }

    // A symlink is read as a file if it points at one, and **not walked** if it points at
    // a directory. `readdir` does not resolve links, so this is the only place either can
    // be decided. Reading a linked Note is right — a human who symlinks a file into their
    // vault sees it in Obsidian, so the coworker's record should see it too. Walking a
    // linked *directory* is not: it can leave the Vault, and it can point at its own
    // parent, which is a snapshot that never finishes.
    if (entry.isSymbolicLink() && (await pointsAtAFile(full))) {
      into.set(relative(notesDir, full), await stateOf(full));
    }
  }
}

/** Whether a link resolves to a file. A broken link resolves to nothing and is skipped. */
async function pointsAtAFile(link: string): Promise<boolean> {
  try {
    return (await stat(link)).isFile();
  } catch {
    return false;
  }
}

async function stateOf(file: string): Promise<FileState> {
  try {
    // Sized before it is read. A Vault may have a dataset dropped in it, and reading
    // that three times a Job to build a change-log diff is the wrong use of the machine.
    const info = await stat(file);
    if (info.size > MAX_DIFFED_BYTES) {
      return { text: undefined, bytes: info.size, mark: `${info.size}:${info.mtimeMs}` };
    }

    const contents = await readFile(file);
    const bytes = contents.byteLength;
    // A NUL byte means this is not text, whatever its extension says. Deciding by
    // content rather than by suffix is what keeps a `.md` file with an image pasted into
    // it from becoming a diff nobody can read.
    if (contents.includes(0)) {
      return { text: undefined, bytes, mark: createHash("sha256").update(contents).digest("hex") };
    }
    return { text: contents.toString("utf8"), bytes, mark: undefined };
  } catch {
    // Read between the walk and here — the coworker deleting its own scratch file, say.
    // Absent is what it is now, and the next snapshot agrees.
    return { text: undefined, bytes: 0, mark: undefined };
  }
}

function relative(notesDir: string, file: string): string {
  return path.relative(notesDir, file).split(path.sep).join("/");
}

/**
 * The diff between two states of one file, or undefined when there is nothing to show.
 *
 * Nothing to show is a real answer: a change to a file with no readable text — an image,
 * a spreadsheet, something too large to hold — is still recorded, and inventing a diff
 * for it would be worse than the record saying only that it changed.
 */
function diffOf(before: FileState | undefined, after: FileState | undefined): string | undefined {
  const from = before?.text;
  const to = after?.text;
  if (from === undefined && to === undefined) return undefined;

  const changed = changedLines(lines(from), lines(to));
  if (changed.length === 0) return undefined;

  const shown: string[] = [];
  let characters = 0;
  for (const line of changed) {
    if (shown.length >= DIFF_MAX_LINES || characters + line.length > DIFF_MAX_CHARS) break;
    shown.push(line);
    characters += line.length + 1;
  }

  const hidden = changed.length - shown.length;
  // Said out loud rather than trailing off, because a diff that was cut is a diff a
  // reviewer should not trust as the whole of what happened.
  if (hidden > 0) shown.push(`… ${hidden} more changed line${hidden === 1 ? "" : "s"}`);
  return shown.join("\n");
}

function lines(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  // A trailing newline is a line terminator rather than an empty last line.
  return text.replace(/\n$/, "").split("\n");
}

/**
 * The lines that differ, as `-` for gone and `+` for arrived.
 *
 * No context lines. A Note's diff is read in Slack by someone checking what the coworker
 * decided to believe, and the changed lines are the whole of that — surrounding lines
 * they already agreed with cost the message its glanceability.
 */
function changedLines(before: readonly string[], after: readonly string[]): string[] {
  // Identical heads and tails are the common shape by far: one paragraph rewritten in a
  // file of twenty. Trimming them first is what keeps the matcher below off most files.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }

  const gone = before.slice(start, before.length - end);
  const arrived = after.slice(start, after.length - end);

  if (gone.length * arrived.length > MAX_DIFF_CELLS) {
    return [...gone.map(minus), ...arrived.map(plus)];
  }
  return align(gone, arrived);
}

/**
 * Longest common subsequence over lines, walked back into a diff.
 *
 * The textbook table, and deliberately the textbook one: this runs on Markdown Notes,
 * where the honest input size is tens of lines, and a hand-rolled heuristic that is
 * wrong on a real file would put a misleading diff in the one message that exists to be
 * checked.
 */
function align(before: readonly string[], after: readonly string[]): string[] {
  const rows = before.length;
  const columns = after.length;
  const common: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      const here = common[row] ?? [];
      const below = common[row + 1] ?? [];
      here[column] =
        before[row] === after[column]
          ? (below[column + 1] ?? 0) + 1
          : Math.max(below[column] ?? 0, here[column + 1] ?? 0);
    }
  }

  const diff: string[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      row++;
      column++;
    } else if ((common[row + 1]?.[column] ?? 0) >= (common[row]?.[column + 1] ?? 0)) {
      diff.push(minus(before[row] ?? ""));
      row++;
    } else {
      diff.push(plus(after[column] ?? ""));
      column++;
    }
  }
  while (row < rows) diff.push(minus(before[row++] ?? ""));
  while (column < columns) diff.push(plus(after[column++] ?? ""));
  return diff;
}

function minus(line: string): string {
  return `- ${line}`;
}

function plus(line: string): string {
  return `+ ${line}`;
}
