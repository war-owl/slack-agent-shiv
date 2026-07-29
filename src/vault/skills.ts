import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NOT_CONTENT } from "./snapshot.ts";

/**
 * Skills: procedures a human wrote down for the coworker to follow, and the one part
 * of the Vault it cannot write.
 *
 * A Skill is prompt rather than data — it directs behaviour instead of describing the
 * world — which puts it in the same category as the Root note and under the same
 * requirement from [ADR-0004 as amended](../../docs/adr/0004-root-note-is-links-only.md):
 * the constraint has to be structural, not a rule the wrapper asks the agent to keep.
 *
 * **The Root note's constraint is grammar; a Skill's is authorship**, and the two need
 * different machinery. The Root is *injected*, so the wrapper reads it and strips
 * non-link lines on the way past — a chokepoint a compromised writer cannot route
 * around. Skills have no such chokepoint: they are traversed on demand from the
 * filesystem, so there is no moment at which the wrapper is holding one and could
 * refuse it. A "please do not write here" rule would be advice to the thing it is
 * defending against.
 *
 * So the enforcement is the **sandbox**, and the whole mechanism is a directory that is
 * not on the writable list:
 *
 *     <Obsidian vault>/
 *       Notes/     ← config.notesDir, passed to the engine as writable
 *       Skills/    ← config.skillsDir, passed to nothing
 *
 * Under `workspace-write` the engine may write its workspace and whatever
 * `additionalDirectories` names, and reads are unrestricted. A sibling of the Notes
 * directory is therefore readable and not writable, which is exactly the guarantee
 * wanted — and because both halves sit under one directory, a human opens *that* in
 * Obsidian and sees Notes and Skills in one vault with wikilinks resolving across both.
 *
 * **Measured, not assumed** (build/15's verify-first block, against Codex 0.145.0). A Job
 * told to edit a Skill outside the writable roots is refused twice over: the
 * file-editing tool answers `patch rejected: writing outside of the project`, and the
 * shell answers `operation not permitted` with exit 1 — the second is the kernel, not an
 * advisory check the agent could talk its way past. Reads succeed. Pinned by a contract
 * test, because it is the load-bearing fact here and no fake can attest to it.
 *
 * The measurement also found the trap that makes {@link skillsLocationProblems} fatal
 * rather than advisory: `$TMPDIR` is writable no matter what the writable list says, so a
 * Skills directory sited there voids all of the above while leaving an instance that looks
 * like it works.
 */

/**
 * The two halves of the Vault, as directory names.
 *
 * Fixed here rather than left to configuration because they are a *layout* — the point
 * is that one is inside the other's parent, and a self-hoster who moves one without the
 * other gets the problems in {@link skillsLocationProblems}. Both paths remain
 * independently configurable for anyone who needs it; these are what the defaults build.
 */
export const NOTES_DIRNAME = "Notes";
export const SKILLS_DIRNAME = "Skills";

/**
 * The file at the Skills location that explains the rules to whoever writes the next one.
 *
 * Listed as a Skill to the credential scan — it is a file in the directory and its
 * examples should be held to the same rule as everything else — and **not** listed to the
 * coworker, because it is documentation for humans and advertising it as a procedure is
 * how a Job ends up reading the instructions for writing Skills instead of the Skill.
 */
export const SKILLS_README_FILENAME = "README.md";

/**
 * How much of a Skill is read when scanning it for a credential, and the size past which
 * the scan **says it did not finish**.
 *
 * A procedure is prose and nowhere near this. Something larger is not a Skill in any
 * useful sense, and holding all of it to grep for a token is a startup that waits on
 * somebody's dataset. But a file that was only partly scanned is reported as such rather
 * than passing quietly — the same reason `root.ts` warns about an oversized Root note
 * instead of truncating it. A clean bill of health on a file nobody finished reading is
 * the one outcome a lint must not produce.
 */
const MAX_SCANNED_BYTES = 128 * 1024;

/**
 * A Skill, as the coworker is told about it.
 *
 * Deliberately **no contents.** They are read once at startup by the credential scan and
 * never by a Job: `skillsForPrompt` sends titles and paths, because a Skill is read when
 * it is relevant. Carrying the text on this type would mean every Job read every
 * procedure off disk to build a prompt that never mentions them.
 */
export interface Skill {
  /** Relative to the Skills directory, with forward slashes — how a human says it. */
  path: string;
  /** The filename without its extension. The title, exactly as for a Note. */
  title: string;
}

/**
 * Read the Skills as they stand — names only, no file contents.
 *
 * A Skills directory that does not exist reads as empty rather than throwing, and that
 * is the ordinary starting state: the coworker has every capability it had before, and
 * the human has not written a procedure down yet.
 *
 * Only Markdown, because a Skill is a Note in form — the acceptance criterion is that a
 * human edits one in Obsidian with no bespoke format.
 */
export async function readSkills(skillsDir: string): Promise<Skill[]> {
  const found: Skill[] = [];
  await walk(skillsDir, skillsDir, found);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The Skills a Job is told about: everything except the README.
 *
 * Separate from {@link readSkills} rather than filtered there, because the credential scan
 * wants the README included — its examples are exactly where a well-meaning author pastes
 * a real connection string — and the prompt does not.
 */
export function proceduresIn(skills: readonly Skill[]): Skill[] {
  return skills.filter((skill) => skill.path !== SKILLS_README_FILENAME);
}

/**
 * Walk the Skills directory.
 *
 * Shares `NOT_CONTENT` with the Vault snapshot rather than restating the list, because
 * "which directories in a human's vault are not content" is one question with one answer,
 * and the two drifting apart would mean Obsidian's own state showing up as a procedure in
 * a prompt while going unrecorded as a change.
 *
 * **Symlinks are not followed at all**, which is stricter than the snapshot's rule
 * (`snapshot.ts` reads a link that points at a file). The asymmetry is deliberate: the
 * snapshot is reporting what a human would see in Obsidian, where a symlinked Note is
 * genuinely theirs. Here, a symlink is a way to make something outside the read-only
 * directory look like it is inside it, and the whole value of this directory is that its
 * contents are known to be human-authored.
 */
async function walk(skillsDir: string, directory: string, into: Skill[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (NOT_CONTENT.has(entry.name)) continue;

    if (entry.isDirectory()) {
      await walk(skillsDir, path.join(directory, entry.name), into);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;

    into.push({
      path: path.relative(skillsDir, path.join(directory, entry.name)).split(path.sep).join("/"),
      title: entry.name.replace(/\.md$/i, ""),
    });
  }
}

/**
 * What to tell the coworker about its Skills.
 *
 * The *location* is what has to be in the prompt, for the same reason the Vault's is:
 * discovery is agent-initiated traversal, and a directory nobody named is a directory
 * nobody visits. The titles come too — a bare path is something to remember to look in,
 * whereas a list of titles is a reason to look now, and the list is short by nature.
 *
 * The contents deliberately do **not** come. A Skill is read when it is relevant, which
 * is the whole design: preloading every procedure into every Job would put a database
 * connection recipe in front of a Job about a pull request, and at that point the Skills
 * directory has become a second operating manual competing with the first.
 *
 * **It is told the directory is read-only, in one sentence and no more.** Not as
 * reassurance — the sandbox does not care whether the coworker knows — but because a Job
 * that finds a procedure wrong will otherwise spend a Turn failing to save an edit and
 * report that as the work. What to *do* about a wrong Skill is in the operating manual,
 * which is in the workspace of every Job; repeating the argument here would be the second
 * operating manual this function exists to avoid.
 */
export function skillsForPrompt(skillsDir: string, skills: readonly Skill[]): string {
  const procedures = proceduresIn(skills);
  if (procedures.length === 0) {
    return [
      `Skills — procedures a human has written down for you — would be in \`${skillsDir}\`,`,
      "and there are none there yet. Nothing about this request depends on one; work the",
      "way you otherwise would.",
    ].join("\n");
  }

  return [
    `Skills are procedures a human wrote down for you, in \`${skillsDir}\`. Each one says how`,
    "to do a particular thing — reach a system, run a query, read the result. Read the one",
    "that bears on this request before working out your own way to do it; they exist because",
    "someone already worked it out and their way is the supported one.",
    "",
    ...procedures.map((skill) => `- [[${skill.title}]] — \`${skill.path}\``),
    "",
    "That directory is read-only to you: Skills are written by people, so if one of them is",
    "wrong, report it rather than trying to edit it — your operating manual says how.",
  ].join("\n");
}

/**
 * Whether the Skills location can actually keep its promise — checked at startup, and
 * fatal when it cannot.
 *
 * Every problem below has the same consequence: the directory is writable by the engine,
 * so Skills are agent-authored, so ADR-0004's amendment is not in force. That is a
 * different instance from the one the documentation describes, and the failure mode is
 * silent — everything works, and the constraint everyone believes is holding is not. A
 * warning would be read once and scrolled past.
 *
 * Returned rather than thrown so the caller can report all of them at once. A
 * self-hoster fixing paths wants the whole list, not the first one.
 */
export async function skillsLocationProblems(location: {
  skillsDir: string;
  notesDir: string;
  workspaceRoot: string;
}): Promise<string[]> {
  const skills = await resolved(location.skillsDir);
  const notes = await resolved(location.notesDir);
  const workspace = await resolved(location.workspaceRoot);
  const problems: string[] = [];

  // Checked with realpaths on both sides, because `/tmp` is a symlink to `/private/tmp`
  // on macOS and a lexical comparison would miss a Skills directory reached through it.
  const temporary = await temporaryRoots();
  const inTemporary = temporary.find((root) => root === skills || within(root, skills));
  if (inTemporary !== undefined) {
    problems.push(
      `The Skills directory ${location.skillsDir} is inside ${inTemporary}, which the ` +
        "engine's sandbox grants write access to unconditionally — temporary directories " +
        "are writable under `workspace-write` whatever the writable list says. So Skills " +
        "there are editable by the coworker, and the authorship rule that keeps one " +
        "thread's job from putting commands in front of another's is not in force. " +
        "Move them somewhere permanent, next to your Notes.",
    );
  }

  if (skills === notes) {
    problems.push(
      `The Skills directory and the Notes directory are the same directory (${location.skillsDir}). ` +
        "The Notes directory is handed to the engine as writable, so this makes every Skill " +
        `agent-writable. Put Skills in a sibling: Notes in \`<vault>/${NOTES_DIRNAME}\`, ` +
        `Skills in \`<vault>/${SKILLS_DIRNAME}\`, and open \`<vault>\` in Obsidian to see both.`,
    );
  } else if (within(notes, skills)) {
    problems.push(
      `The Skills directory ${location.skillsDir} is inside the Notes directory ` +
        `${location.notesDir}, which is handed to the engine as writable — so the coworker ` +
        "can edit its own Skills, and the authorship rule is not in force. They have to be " +
        `siblings, not nested: Notes in \`<vault>/${NOTES_DIRNAME}\`, Skills in ` +
        `\`<vault>/${SKILLS_DIRNAME}\`.`,
    );
  } else if (within(skills, notes)) {
    problems.push(
      `The Notes directory ${location.notesDir} is inside the Skills directory ` +
        `${location.skillsDir}. Notes are writable, so this makes part of the Skills tree ` +
        "writable too, and it also means every Note the coworker files lands among the " +
        "procedures it is supposed to be following. They have to be siblings.",
    );
  }

  // Both directions and equality, because all three are the same mistake: a Job's
  // workspace is fully writable, so any overlap at all between the two trees means some
  // Skill sits in a directory the coworker was invited to scribble in.
  if (skills === workspace || within(workspace, skills) || within(skills, workspace)) {
    problems.push(
      `The Skills directory ${location.skillsDir} and the workspace root ` +
        `${location.workspaceRoot} overlap. A Job's workspace is its own desk and is fully ` +
        "writable, so Skills anywhere inside one are agent-writable. Keep the Skills in " +
        "your Obsidian vault and the workspaces somewhere else entirely.",
    );
  }

  return problems;
}

/**
 * Skills that appear to have a credential written into them.
 *
 * A Skill names an environment variable; the value lives in the sandbox environment
 * (ADR-0004). The Vault is human-readable by design, opens in Obsidian, and will
 * plausibly be committed to git — so a token in a Skill is a token in a repository.
 *
 * **A warning rather than a refusal**, and the asymmetry with
 * {@link skillsLocationProblems} is deliberate. A mis-sited Skills directory means the
 * project's own guarantee is not working, which nobody can consent to. A secret in a file
 * is the self-hoster's own credential in the self-hoster's own vault: telling them
 * plainly is right, and refusing to start their instance over a regex that also has false
 * positives is not.
 *
 * **This is a lint, not a boundary, and should not be described as one.** It matches
 * shapes it has been taught, so it catches the accident and would not catch someone
 * determined; and it reads only the first {@link MAX_SCANNED_BYTES} of a file, saying so
 * when that was not all of it. What actually keeps credentials out of Skills is that a
 * scoped credential is the whole boundary for anything reached this way, which is a thing
 * to get right rather than to scan for.
 */
export async function credentialConcerns(skillsDir: string): Promise<string[]> {
  const concerns: string[] = [];

  for (const skill of await readSkills(skillsDir)) {
    const file = path.join(skillsDir, skill.path);
    let text: string;
    let complete: boolean;
    try {
      const info = await stat(file);
      complete = info.size <= MAX_SCANNED_BYTES;
      text = (await readFile(file, "utf8")).slice(0, MAX_SCANNED_BYTES);
    } catch {
      // Read between the listing and here. Nothing useful to say that a Job's own failure
      // to read the same file would not say better.
      continue;
    }

    const found = credentialShapesIn(text);
    if (found.length > 0) {
      concerns.push(
        `The Skill \`${skill.path}\` looks like it contains ${found.join(" and ")}. ` +
          "A Skill names the environment variable a credential lives in; it never carries " +
          "the value. The Vault opens in Obsidian and will plausibly end up in git, so " +
          "treat this as leaked: rotate it, then replace it in the file with the name of " +
          "the variable. If this is a false positive — an example, or a placeholder — it is " +
          "worth rewording so the next person is not told to rotate a working credential " +
          "for nothing.",
      );
    }

    // Said even when nothing was found, because that is precisely when it matters: a
    // silent pass over a file nobody finished reading is a clean bill of health nobody
    // earned.
    if (!complete) {
      concerns.push(
        `The Skill \`${skill.path}\` is larger than ${MAX_SCANNED_BYTES} bytes, so only its ` +
          "first part was checked for credentials. Nothing is claimed about the rest. A " +
          "procedure that long is worth splitting up anyway — the coworker reads these " +
          "whole.",
      );
    }
  }

  return concerns;
}

/**
 * Which credential shapes appear in a piece of text, by name.
 *
 * Exported separately from {@link credentialConcerns} so the shapes can be tested as
 * shapes, without a directory of fixture files standing between the pattern and the
 * assertion.
 */
export function credentialShapesIn(text: string): string[] {
  return CREDENTIAL_SHAPES.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
}

/**
 * The shapes a leaked credential takes, and nothing looser.
 *
 * The first eight are vendor-issued prefixes: unambiguous on their own, because nothing
 * else looks like them. The last is not, and is included anyway with its ambiguity
 * managed rather than denied — a password inside a connection URL is the one secret with
 * its own syntax, and the `$`/`{` exclusions are what keep the *correct* form
 * (`postgres://reader:$PGPASSWORD@host`) from being reported as the thing it models.
 *
 * Deliberately **not** here: a bare `password = …` or `token: …`, which is how a Skill
 * written properly against an environment variable reads, and a high-entropy string,
 * which flags every base64 example anyone ever pastes. A lint that cries wolf on the
 * correct form of the thing it is teaching gets turned off, and then it catches nothing.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["a private key", /-----BEGIN[ A-Z]*PRIVATE KEY-----/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ["a GitHub personal access token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["a Slack app token", /\bxapp-\d-[A-Za-z0-9-]{10,}\b/],
  ["an OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["a Linear key", /\blin_api_[A-Za-z0-9]{20,}\b/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["a password in a connection URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@${}]{4,}@/i],
];

/**
 * Where the sandbox writes regardless of configuration.
 *
 * `$TMPDIR` and `/tmp` both, and each one realpathed: on macOS `$TMPDIR` is a long
 * `/var/folders/…` path that is itself reached through a symlink, and `/tmp` is
 * `/private/tmp`. Comparing the wrong one of those against a configured path is how this
 * check would pass while the directory it was checking was writable.
 */
async function temporaryRoots(): Promise<string[]> {
  const candidates = [os.tmpdir(), "/tmp", "/var/tmp"];
  const roots = await Promise.all(candidates.map(resolved));
  return [...new Set(roots)];
}

/** A path with its symlinks resolved, falling back to lexical resolution if it is absent. */
async function resolved(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return path.resolve(directory);
  }
}

/**
 * Whether `child` is inside `parent`.
 *
 * Equal paths are **not** "within" — the callers above need to tell "the same directory"
 * apart from "nested inside", because those are different mistakes with different advice.
 */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
