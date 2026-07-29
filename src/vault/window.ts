import { reasonFor } from "../failure.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/log.ts";
import type { AuditTrail } from "../reporter/audit.ts";
import type { Thread } from "../thread.ts";
import { changeVerb, type Write } from "../writes/classify.ts";
import { stampChangedNotes } from "./frontmatter.ts";
import {
  changesBetween,
  ensureVault,
  snapshotVault,
  type VaultChange,
  type VaultSnapshot,
} from "./snapshot.ts";

/**
 * One Job's view of the Vault, and everything that happens to it while that Job runs.
 *
 * A Job opens a window before the engine starts and settles up against it afterwards.
 * Settling up means: read the Vault, compare it against what was there last time, stamp
 * provenance onto the Notes that changed, and append a Write record — carrying the diff —
 * for each one. That is the whole account of what the coworker did to the human's memory,
 * and it is taken from the directory rather than from the engine's events, which is what
 * catches a Note written with `cp` or removed with `rm`.
 *
 * **It settles up more than once**, and the reason is the Librarian. A Note written while
 * the work was happening happened before the answer; a Note the Librarian files happens
 * after it. Accounting at each of those points is what keeps the Thread readable in the
 * order things actually occurred — and it means a slow closing pass delays nobody, because
 * the answer has already gone out.
 *
 * ## What it cannot know, and says so instead
 *
 * There is **one Vault and up to four concurrent Jobs** (`bounds.maxConcurrentJobs`), so
 * two Jobs in two Threads can be writing Notes inside each other's windows. Nothing in the
 * filesystem says which Job wrote a file: the change is real and visible, and its author
 * is not. That is why {@link trackVaultWindows} exists — a window that overlapped another
 * knows it did, and then the record says the change may not be this Job's and the
 * provenance stamp leaves the Thread and Job off rather than guessing at them.
 *
 * Saying so is the smallest honest answer. Attributing it anyway would put a false line in
 * the one message that exists to be true and a false `job:` in the file; dropping the
 * record would be a silent hole in the account, which build/04 is emphatic is the worse
 * failure. A real fix needs per-writer information the filesystem does not carry — a Vault
 * lock across each Job, which serialises the Jobs build/06 deliberately runs at once, or a
 * per-Job view of the directory, which stops the Vault being one directory a human owns.
 *
 * One consequence is worth stating plainly, because it looks like an audience leak and is
 * not quite one: an unattributable change is recorded in **every** Thread whose window it
 * fell inside, so a Note written from one Thread can be shown in another. What makes that
 * survivable is that the Vault is deliberately not private to a Thread — ADR-0003 makes it
 * the *only* channel between Sessions and says outright that there is no agent-private
 * knowledge — so any Job in that Thread could already have read the Note by following a
 * link. The record discloses nothing the Vault was not already sharing; it just says it
 * out loud, hedged.
 */

/**
 * The Vault windows open across the instance right now.
 *
 * Its only job is to answer "did this Job have the Vault to itself?", and it answers by
 * marking **every** open window the moment a second one opens — which is what catches a
 * Job that starts and finishes entirely inside another one's window, where comparing
 * counts at the two ends would not.
 */
export interface VaultWindows {
  open(): OpenWindow;
}

interface OpenWindow {
  /** True once any other window was open at the same time as this one. */
  readonly shared: boolean;
  close(): void;
}

export function trackVaultWindows(): VaultWindows {
  const windows = new Set<{ shared: boolean }>();

  return {
    open(): OpenWindow {
      const window = { shared: false };
      windows.add(window);
      if (windows.size > 1) for (const other of windows) other.shared = true;
      return {
        get shared() {
          return window.shared;
        },
        close: () => void windows.delete(window),
      };
    },
  };
}

export interface VaultWindowDeps {
  notesDir: string;
  log: Logger;
  clock: Clock;
  thread: Thread;
  /** Slack's `event_id` for the mention — the Job's identity in the frontmatter too. */
  jobId: string;
  windows: VaultWindows;
}

export interface VaultWindow {
  /**
   * Record everything that has changed since this window opened or was last settled.
   *
   * Never throws and never rejects. It runs after the work is done — a Vault that cannot
   * be read is a hole in the record, which is said in the log and left there, because
   * failing a finished Job over its own bookkeeping would lose the work to the label.
   */
  settle(audit: AuditTrail): Promise<void>;
  /** The Job is over. Releases this window's claim on the instance-wide overlap check. */
  close(): void;
}

/** Open a window on the Vault, reading it as it stands before the Job touches it. */
export async function openVaultWindow(deps: VaultWindowDeps): Promise<VaultWindow> {
  // A fresh install points at `./vault` and nothing has created it, and the engine is
  // handed the Vault as a writable directory before the first Note is written — so this
  // would otherwise be a Job whose memory has no home. Creating an empty directory is not
  // writing in it: the Vault stays the human's.
  await ensureVault(deps.notesDir);

  const claim = deps.windows.open();
  let baseline: VaultSnapshot = await snapshotVault(deps.notesDir);

  return {
    async settle(audit: AuditTrail): Promise<void> {
      const before = baseline;
      try {
        const seen = await snapshotVault(deps.notesDir);
        const changes = changesBetween(before, seen).filter(isNotBookkeeping);
        // The baseline advances even when nothing changed, so that the next accounting
        // reports what happened *since here* rather than repeating this window's findings.
        baseline = seen;
        if (changes.length === 0) return;

        const attributable = !claim.shared;
        if (!attributable) {
          deps.log.warn(
            `Another Job was writing to the Vault while Job ${deps.jobId} ran, so ` +
              `${changes.length} change(s) cannot be attributed: ` +
              `${changes.map((change) => change.path).join(", ")}. They are recorded in ` +
              "thread " +
              `${deps.thread.ts} as possibly another Job's, and left without a thread or ` +
              "job in their frontmatter.",
          );
        }

        const stamping = await stampChangedNotes(deps.notesDir, changes, {
          thread: deps.thread,
          jobId: deps.jobId,
          at: deps.clock.now(),
          attributable,
        });
        for (const failed of stamping.failures) {
          deps.log.warn(
            `Could not stamp provenance onto ${failed.path}: ${reasonFor(failed.error)}. ` +
              "The Note itself is fine; it just does not say which Job last wrote it.",
          );
        }

        // Re-read only if stamping actually changed something, and then it must be: what
        // the Thread shows has to be what the file now holds, frontmatter included, or a
        // human comparing the record against Obsidian finds two different files. Diffed
        // from the *original* baseline, so each record is one change — the Note as it now
        // stands — rather than the coworker's write followed by the wrapper's stamp.
        let recorded = changes;
        if (stamping.stamped > 0) {
          const stamped = await snapshotVault(deps.notesDir);
          // Narrowed to the files already decided on. Re-diffing can otherwise pick up
          // something that changed in the moment since — another Job's stamp landing, most
          // likely — and report it here as though this accounting had found it.
          const decided = new Set(changes.map((change) => change.path));
          recorded = changesBetween(before, stamped).filter((change) => decided.has(change.path));
          baseline = stamped;
        }
        for (const write of vaultWrites(recorded, attributable)) audit.append(write);
      } catch (error) {
        deps.log.warn(
          `Could not read the Vault at ${deps.notesDir} to see what changed: ` +
            `${reasonFor(error)}. Any Notes written during Job ${deps.jobId} are ` +
            "unrecorded in the thread.",
        );
      }
    },

    close: () => claim.close(),
  };
}

/**
 * Whether a change is a change to what the coworker *believes*, rather than the wrapper's
 * own bookkeeping about it.
 *
 * An edit whose every changed line is a frontmatter key the wrapper owns is a provenance
 * stamp and nothing else, and recording it would be recording the audit trail's own
 * footprints. Two ways that happens, and the second is what forced this: a Job that touches
 * a Note it wrote in an earlier Turn, and — with several Jobs sharing one Vault — a Job
 * seeing *another* Job's stamp land inside its window, which would otherwise put two
 * records in the Thread for one Note.
 *
 * Only edits, never additions: a new Note is always worth recording, even one whose whole
 * content is frontmatter. And a diff that was truncated is treated as a real change, since
 * what was cut cannot be shown to be harmless.
 */
function isNotBookkeeping(change: VaultChange): boolean {
  if (change.kind !== "update" || change.diff === undefined) return true;
  return !change.diff.split("\n").every(isStampLine);
}

/**
 * A diff line that is part of a provenance stamp and nothing else.
 *
 * The `---` fences count, and they have to: stamping a Note that had no frontmatter adds a
 * whole block, so the change is three lines of which only the middle one is a key. Leaving
 * the fences out was a bug that showed up as one Note recorded twice.
 */
function isStampLine(diffLine: string): boolean {
  const line = diffLine.replace(/^[+-] /, "");
  return line === "---" || STAMPED_KEYS.some((key) => line.startsWith(`${key}:`));
}

const STAMPED_KEYS = ["modified", "thread", "job"] as const;

/**
 * Every Vault change, as a Write the Thread will carry permanently.
 *
 * A Note in the Vault is a Write because the Vault is the human's — the line is what the
 * coworker was given versus what it went out and touched, and its own workspace is the
 * former. Anything that changed here changed something a person owns and reads, whether a
 * file-editing tool did it or a shell redirection nothing could see.
 */
function vaultWrites(changes: readonly VaultChange[], attributable: boolean): Write[] {
  return changes.map((change) => ({
    action: `${changeVerb(change.kind)} a ${change.path.endsWith(".md") ? "Note" : "file"} ${
      change.kind === "delete" ? "from the Vault" : "in the Vault"
    }`,
    subject: change.path,
    diff: change.diff,
    detail: attributable
      ? undefined
      : "another job was writing to the Vault at the same time, so this may be its change",
  }));
}
