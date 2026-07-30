import { realpath } from "node:fs/promises";
import path from "node:path";
import type { EngineEvent, FileChange } from "../ports/engine.ts";

/**
 * What counts as a Write, and what to call it.
 *
 * A Write is an action the coworker takes against something outside itself: opening a
 * pull request, updating a ticket, or uploading a result. The coworker acts
 * unattended, so each external one is appended to its Thread as a permanent record — which
 * makes "is this a Write?" a question with consequences, and this module is where it
 * is answered.
 *
 * Three sources, in descending order of how well the answer is known:
 *
 * - **A file change.** Known exactly: the Job's workspace is the coworker's own desk
 *   and changes inside it are Progress, while anything it writes *outside* the
 *   workspace has left itself. **The Vault is the exception, and it is recorded
 *   separately elsewhere** — `vault/snapshot.ts` reads the directory itself and the
 *   result goes to the server-side Vault change log, not the Thread.
 * - **An MCP tool call.** Not posted as a separate Slack receipt. Connector activity
 *   belongs in the Job's final answer when it matters; emitting one message per call
 *   makes ordinary reads look like writes and clutters the conversation.
 * - **A shell command.** *Not* known, and this is the honest weak point. The table
 *   below recognises the few shapes a coworker plausibly reaches for; a command it
 *   does not recognise leaves no record, and no amount of lengthening the table fixes
 *   that. It is why the operating manual asks
 *   the coworker to say in its answer what it did through the shell. Skills
 *   (build/15) are where shell-shaped Writes stop being rare, and are the right place
 *   to revisit this.
 */

export interface Write {
  /** What was done, in a colleague's words: "Opened a pull request", "Edited a Note". */
  action: string;
  /** The thing that was written, named the way someone would go and check it. */
  subject: string;
  /** Where to go and check it, when the Write handed back somewhere to look. */
  url?: string | undefined;
  /** What did it: the command run, or the tool called. */
  via?: string | undefined;
  /** One more line — why it failed, usually. */
  detail?: string | undefined;
  /**
   * Why this record cannot claim success, in the reader's own words — and absent when
   * it can.
   *
   * A phrase rather than a flag, because the honest thing to say differs by source and
   * one of them is genuinely uncertain. A refused tool call did not happen. But a shell
   * command is a whole script, so a non-zero exit says *the script* failed and not
   * which part of it did: measured against a real `codex exec`, a push that plainly
   * succeeded — the remote moved — came back inside a chain that ended non-zero. "The
   * attempt failed" would have been a false statement in the one message that exists to
   * be true, so the record says what is actually known and leaves the reader the
   * command to judge it by.
   *
   * Either way the Write is still recorded: a failed attempt may have landed something,
   * and a trail that only shows successes is the wrong half of the story.
   */
  failure?: string | undefined;
}

/** One directory, under every name it answers to. */
interface ScopedDirectory {
  /** As configured. What a relative path from the engine is relative to. */
  given: string;
  /** Every name the filesystem gives it, `given` included. */
  names: readonly string[];
}

export interface WriteScope {
  /** This Job's workspace. Changes inside it are the coworker's own desk, not Writes. */
  workspace: ScopedDirectory;
  /** The Vault, so engine file events are ignored and its snapshot owns the record. */
  vault: ScopedDirectory;
}

/**
 * The scope for one Job.
 *
 * Asynchronous because each directory is resolved through its symlinks as well as kept
 * as configured: the engine reports whichever it happens to see, and a macOS temporary
 * directory is `/var/…` to whoever created it and `/private/var/…` to whoever walks it.
 * That difference decides whether a scratch file on the coworker's own desk is mistaken
 * for an action against the world, so it is settled once per Job rather than per event.
 */
export async function writeScope(input: {
  workspaceDir: string;
  notesDir: string;
}): Promise<WriteScope> {
  return {
    workspace: await scopedDirectory(input.workspaceDir),
    vault: await scopedDirectory(input.notesDir),
  };
}

/** Every Write in one engine event — usually none, occasionally one, rarely several. */
export function writesIn(event: EngineEvent, scope: WriteScope): Write[] {
  switch (event.type) {
    case "file-change":
      // A patch that failed wrote nothing: Codex applies one atomically or not at all.
      if (event.status !== "completed") return [];
      return event.changes.flatMap((change) => {
        const write = fileWrite(change, scope);
        return write === undefined ? [] : [write];
      });

    case "command": {
      // The same command arrives when it starts and again when it ends. Only the
      // ending says whether anything happened.
      if (event.status === "in-progress") return [];
      const failed = event.status === "failed" || (event.exitCode ?? 0) !== 0;
      // Every matching rule, not just the first: one command item is routinely a whole
      // shell script — `git add … && git commit … && git push …` arrives as one event —
      // so a command that did two consequential things gets a record for each.
      return COMMAND_WRITES.filter((rule) => rule.pattern.test(event.command)).map((rule) => ({
        action: rule.action,
        ...thingWritten(
          rule.linksOutput === true && !failed ? urlsIn(event.output).at(-1) : undefined,
          event.command,
        ),
        failure: failed ? "the command it ran in failed" : undefined,
      }));
    }

    case "tool-call":
      return [];

    default:
      // Plans, messages, reasoning, searches and Turn boundaries change nothing
      // outside the coworker. The status message is where those belong.
      return [];
  }
}

/**
 * Where a command begins inside the string the engine hands over.
 *
 * Measured rather than assumed, and the measurement decided the shape of it. `codex
 * exec` reports a shell call as
 * `/bin/zsh -lc "git add -- README.md && git commit -m 'x' && git push -u origin main"`,
 * so what is being matched is a shell script read from outside: the interesting program
 * is almost never at the start of the string and usually sits behind a quote.
 *
 * Hence a boundary this loose, and hence its accepted cost — `echo 'do not git push
 * yet'` is recorded as a push. **Over-recording is the right way to be wrong here.** A
 * spurious record is visible and a reader can dismiss it; a missing one is a silent
 * hole in the only account there is of what the coworker did unattended.
 */
const STARTS_A_COMMAND = String.raw`(?:^|[\s;&|('"])`;

/** The `gh` verbs that change something. Everything else it does is a read. */
const GH_MUTATIONS =
  "create|edit|comment|close|reopen|merge|delete|rename|transfer|lock|unlock|pin|unpin|" +
  "ready|review|add|remove|set|restore|upload|dispatch|cancel|rerun|sync|enable|disable";

/** The `gh` commands with a record of their own, which the catch-all must not repeat. */
const GH_NAMED = String.raw`(?:pr|issue|release)\s+create`;

/**
 * A request carrying something to the other end: a mutating method, a body, or a file.
 *
 * Case-sensitive on purpose. `-d` sends data and `-D` dumps response headers, `-T`
 * uploads and `-t` sets telnet options — so folding case here would record reading a
 * URL as writing to it. HTTP methods are uppercase by convention and curl passes them
 * through verbatim, so requiring uppercase costs nothing real.
 */
const SENDS_A_BODY = String.raw`(?:-X|--request)\s*"?(?:POST|PUT|PATCH|DELETE)|--data|--form|--upload-file|\s-[dTF](?:\s|$)`;

interface CommandRule {
  pattern: RegExp;
  action: string;
  /**
   * Whether a URL the command printed is the thing it created.
   *
   * Off by default, and the reason is `git push`: GitHub answers a pushed branch with a
   * "create a pull request" suggestion URL, and linking a record to something that was
   * *not* written is worse than not linking it at all.
   */
  linksOutput?: boolean;
}

/**
 * The commands recognised as Writes.
 *
 * Rules must not overlap: every one that matches becomes its own record, so the
 * catch-all for `gh` excludes what the rules above it already name.
 */
const COMMAND_WRITES: readonly CommandRule[] = [
  { pattern: at(String.raw`git\s+(?:-\S+\s+)*push\b`), action: "Pushed to a git remote" },
  { pattern: at(String.raw`gh\s+pr\s+create\b`), action: "Opened a pull request", linksOutput: true },
  { pattern: at(String.raw`gh\s+issue\s+create\b`), action: "Opened an issue", linksOutput: true },
  {
    pattern: at(String.raw`gh\s+release\s+create\b`),
    action: "Published a release",
    linksOutput: true,
  },
  {
    pattern: at(String.raw`gh\s+api\b(?=.*(?:-X|--method)\s+"?(?:POST|PUT|PATCH|DELETE))`),
    action: "Called the GitHub API",
  },
  {
    pattern: at(String.raw`gh\s+(?!${GH_NAMED})\S+\s+(?:${GH_MUTATIONS})\b`),
    action: "Changed something on GitHub",
  },
  {
    pattern: at(String.raw`(?:curl|wget)\b(?=.*(?:${SENDS_A_BODY}))`),
    action: "Sent a request to a remote service",
  },
  { pattern: at(String.raw`(?:npm|pnpm|yarn)\s+publish\b`), action: "Published a package" },
];

/** A rule's pattern, anchored where a command can begin. */
function at(command: string): RegExp {
  return new RegExp(STARTS_A_COMMAND + command);
}

/**
 * What a change of each kind is called, in a colleague's words.
 *
 * Exported because the Vault answers for its own changes (`vault/window.ts`) and reaches
 * the same three verbs from the same three kinds. One map, so a fourth kind of change
 * cannot end up named here and unnamed there.
 */
export function changeVerb(kind: FileChange["kind"]): string {
  return VERBS[kind];
}

const VERBS: Record<FileChange["kind"], string> = {
  add: "Created",
  update: "Edited",
  delete: "Deleted",
};

function fileWrite(change: FileChange, scope: WriteScope): Write | undefined {
  // Relative paths are relative to where the engine was started, which is the Job's
  // workspace — so an unqualified path is by definition on the coworker's own desk.
  const file = path.resolve(scope.workspace.given, change.path);
  if (containing(scope.workspace, file) !== undefined) return undefined;

  // The Vault is answered for by the filesystem, not by this event.
  //
  // `vault/snapshot.ts` compares the directory's contents before and after the Job, which
  // sees a Note written with `cp` or removed with `rm` — neither of which appears here —
  // and can say what the Note now says, which this cannot. Recording it from both places
  // would put two permanent messages in the Thread for one Write; recording it from here
  // would be recording the half that misses things and carries no diff.
  if (containing(scope.vault, file) !== undefined) return undefined;

  return { action: `${changeVerb(change.kind)} a file`, subject: file };
}

/**
 * The thing written, and how it was written.
 *
 * The link is the subject where there is one: a record whose subject is
 * `gh pr create --fill` names the act, where one whose subject is the pull request
 * names the thing — which is what someone checking up on it came for. The doing moves
 * underneath rather than being dropped, because how it happened is still evidence.
 */
function thingWritten(
  url: string | undefined,
  doing: string,
): Pick<Write, "subject" | "url" | "via"> {
  return url === undefined ? { subject: doing } : { subject: displayed(url), url, via: doing };
}

const A_URL = /https?:\/\/[^\s"'<>)\]}]+/g;

/** Every URL in some text, in the order they appear. */
function urlsIn(text: string): string[] {
  // Trailing punctuation is prose, not part of the address.
  return [...text.matchAll(A_URL)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

/** A URL as a label: what it points at, without the ceremony. */
function displayed(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Which name of this directory the file is under, if it is under any of them. */
function containing(directory: ScopedDirectory, file: string): string | undefined {
  return directory.names.find((name) => {
    const relative = path.relative(name, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

async function scopedDirectory(directory: string): Promise<ScopedDirectory> {
  const given = path.resolve(directory);
  try {
    const real = await realpath(given);
    return { given, names: real === given ? [given] : [given, real] };
  } catch {
    // It does not exist yet — the Vault, before anything has been written to it.
    return { given, names: [given] };
  }
}
