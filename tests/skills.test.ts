import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { LIBRARIAN_HEADING } from "../src/vault/librarian.ts";
import {
  credentialConcerns,
  credentialShapesIn,
  readSkills,
  SKILLS_DIRNAME,
} from "../src/vault/skills.ts";
import { coworkerHarness, type CoworkerHarness } from "./support/harness.ts";

/**
 * Skills: procedures a human wrote down, which the coworker follows and cannot write.
 *
 * The guarantee has two halves and they are tested in two different places, deliberately.
 * **That the sandbox refuses the write** is a fact about the kernel and belongs in
 * `tests/contract/codex-exec.test.ts`, because a fake that refused a write would be
 * asserting its own construction. What is testable here is everything the wrapper is
 * responsible for: that the Skills directory is never handed to the engine as writable,
 * that startup refuses an arrangement where the guarantee could not hold, and that the
 * coworker is actually told the Skills exist — a boundary around a directory nobody reads
 * is not a feature.
 */

/** A Skill, written the way a human writes one: a Markdown file, no format to learn. */
async function writeSkill(skillsDir: string, title: string, body: string): Promise<void> {
  await mkdir(skillsDir, { recursive: true });
  await writeFile(path.join(skillsDir, `${title}.md`), body, "utf8");
}

describe("the Skills directory", () => {
  it("is never handed to the engine as writable", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "Database access", "Use `$ANALYTICS_DATABASE_URL`.\n");

    await h.mention();

    // The whole of ADR-0004's authorship rule for Skills is this omission. Asserted
    // against every Session the Job opened rather than the first, because the Librarian's
    // pass opens one too and it writes Notes on the same grant.
    const granted = [
      ...h.engine.startedSessions,
      ...h.engine.resumedSessions.map((resumed) => resumed.options),
    ];
    expect(granted.length).toBeGreaterThan(0);
    for (const session of granted) {
      expect(session.writableDirectories ?? []).toContain(h.notesDir);
      expect(session.writableDirectories ?? []).not.toContain(h.skillsDir);
      // Nor by way of a parent: granting the Obsidian root would grant Skills with it.
      for (const directory of session.writableDirectories ?? []) {
        expect(path.relative(directory, h.skillsDir).startsWith("..")).toBe(true);
      }
    }
  });

  it("is named in the Job's prompt, with the Skills that are in it", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "Database access", "Use `$ANALYTICS_DATABASE_URL`.\n");
    await writeSkill(h.skillsDir, "Weekly export", "Run the reconciliation.\n");

    await h.mention();

    const prompt = h.engine.ranTurns[0]!.prompt;
    expect(prompt).toContain(h.skillsDir);
    // Titles, so the coworker has a reason to look now rather than a directory to
    // remember to check. As wikilinks, because that is how it reaches any other Note.
    expect(prompt).toContain("[[Database access]]");
    expect(prompt).toContain("[[Weekly export]]");
    // And told it cannot write them, so a Job that finds one wrong reports it instead of
    // spending a Turn failing to save an edit.
    expect(prompt).toMatch(/read-only/i);
  });

  it("does not put the Skills themselves in the prompt", async () => {
    const h = await coworkerHarness();
    // A Skill is read when it is relevant. Inlining every procedure into every Job would
    // make the directory a second operating manual competing with the first.
    await writeSkill(h.skillsDir, "Database access", "The magic word is HALYARD.\n");

    await h.mention();

    expect(h.engine.ranTurns[0]!.prompt).not.toContain("HALYARD");
  });

  it("is described honestly when it is empty, rather than left unmentioned", async () => {
    const h = await coworkerHarness();

    await h.mention();

    const prompt = h.engine.ranTurns[0]!.prompt;
    expect(prompt).toContain(h.skillsDir);
    // An empty Skills directory is the ordinary starting state, and a coworker told
    // "there are none" does not go hunting for a procedure that does not exist.
    expect(prompt).toMatch(/none there yet/i);
  });

  it("is read fresh for each Job, so a Skill written mid-session is picked up", async () => {
    const h = await coworkerHarness();

    await h.mention();
    expect(h.engine.ranTurns[0]!.prompt).not.toContain("[[Weekly export]]");

    // A human edits these in Obsidian while the instance runs. Reading them once at
    // startup would mean a new Skill needs a restart, which nobody would discover.
    await writeSkill(h.skillsDir, "Weekly export", "Run the reconciliation.\n");
    await h.mention();

    expect(h.engine.ranTurns[1]!.prompt).toContain("[[Weekly export]]");
  });
});

describe("the Librarian", () => {
  it("is told it cannot write Skills, and what to do instead", async () => {
    const h = await coworkerHarness();

    await h.mention();

    const pass = h.engine.librarianPrompts[0]!;
    expect(pass).toContain(LIBRARIAN_HEADING);
    expect(pass).toContain(SKILLS_DIRNAME);
    // The instruction is worthless without the alternative: a Job that discovered a
    // procedure is wrong has to have somewhere to put that, or the finding is lost.
    expect(pass).toMatch(/ordinary Note/i);
  });
});

describe("startup", () => {
  it("refuses to run when the Skills sit inside the writable Notes directory", async () => {
    const h = await coworkerHarness();
    const inside = path.join(h.notesDir, SKILLS_DIRNAME);
    await mkdir(inside, { recursive: true });
    const broken = await withSkillsAt(h, inside);

    // Fatal rather than a warning: the instance would run perfectly, and the authorship
    // rule everybody believes is holding would not be.
    await expect(broken.coworker.preflight()).rejects.toThrow(/sibling/i);
  });

  it("refuses to run when the Skills sit in a temporary directory", async () => {
    // Measured on build/15: `workspace-write` grants `$TMPDIR` and `/tmp`
    // unconditionally, whatever the writable list says. So Skills there are writable by
    // the coworker however carefully they were configured, and the guarantee is void.
    const h = await coworkerHarness();
    const temporary = path.join(os.tmpdir(), "open-agent-skills-check");
    await mkdir(temporary, { recursive: true });
    const broken = await withSkillsAt(h, temporary);

    await expect(broken.coworker.preflight()).rejects.toThrow(/temporar/i);
  });

  it("refuses to run when the Skills sit inside a Job workspace", async () => {
    const h = await coworkerHarness();
    const inside = path.join(h.workspaceRoot, SKILLS_DIRNAME);
    await mkdir(inside, { recursive: true });
    const broken = await withSkillsAt(h, inside);

    await expect(broken.coworker.preflight()).rejects.toThrow(/workspace/i);
  });

  it("refuses to run when the workspaces would be created inside the Skills", async () => {
    const h = await coworkerHarness();
    // The other direction, and just as bad: a workspace created under the Skills tree is
    // a fully writable directory inside the read-only one. Checking only the containment
    // that reads naturally would let this through.
    const above = path.dirname(h.workspaceRoot);
    const broken = await withSkillsAt(h, above);

    await expect(broken.coworker.preflight()).rejects.toThrow(/workspace/i);
  });

  it("warns, naming the path, when the Skills directory is not there", async () => {
    const h = await coworkerHarness();
    const absent = path.join(path.dirname(h.notesDir), "Procedures");
    const misconfigured = await withSkillsAt(h, absent);
    // The harness creates whatever it is pointed at, so this is the one arrangement it has
    // to undo: a configured location that is not there, which is both the clean install and
    // the typo.
    await rm(absent, { recursive: true, force: true });

    await misconfigured.coworker.preflight();

    // A warning rather than a refusal, because no Skills yet is the ordinary starting state.
    // But it names the path, because the *other* thing this looks like is a mistyped one —
    // and "no Skills yet" for a directory full of them is exactly what "checked at startup
    // rather than discovered on first use" is meant to prevent.
    expect(misconfigured.warnings.join("\n")).toContain(absent);
  });

  it("refuses to run when the Skills directory cannot be read", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "Database access", "Use `$ANALYTICS_DATABASE_URL`.\n");
    // The layout is right and the procedures are there; the instance simply cannot open the
    // directory. `readSkills` would report "none yet" and every Skill in there would be
    // silently ignored — half of a guarantee whose whole content is "readable, not writable".
    await chmod(h.skillsDir, 0o000);
    onTestFinished(() => chmod(h.skillsDir, 0o755));

    await expect(h.coworker.preflight()).rejects.toThrow(/cannot be read/i);
  });

  it("runs, and says what it found, when the layout is right", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "Database access", "Use `$ANALYTICS_DATABASE_URL`.\n");

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toMatch(/Skills:.*Database access\.md/s);
    expect(h.logs.join("\n")).toMatch(/read-only/i);
    expect(h.warnings).toEqual([]);
  });

  it("warns about a credential written into a Skill", async () => {
    const h = await coworkerHarness();
    await writeSkill(
      h.skillsDir,
      "Database access",
      "Connect with `postgres://reader:hunter2loose@analytics.internal/main`.\n",
    );

    await h.coworker.preflight();

    const warning = h.warnings.join("\n");
    expect(warning).toContain("Database access.md");
    expect(warning).toMatch(/connection URL/i);
    // Told to rotate, because the vault opens in Obsidian and plausibly ends up in git —
    // by the time this is read, the credential should be treated as gone.
    expect(warning).toMatch(/rotate/i);
    // A warning, not a refusal: this is the self-hoster's credential in their own vault,
    // unlike a layout that voids the project's own guarantee.
    expect(h.warnings.length).toBeGreaterThan(0);
  });

  it("says when a Skill was too large to scan in full, rather than passing it quietly", async () => {
    const h = await coworkerHarness();
    // A clean bill of health on a file nobody finished reading is the one outcome a lint
    // must not produce — the same reason the Root note's size is warned about rather than
    // silently truncated.
    await writeSkill(h.skillsDir, "Enormous", `# Enormous\n\n${"padding. ".repeat(20_000)}\n`);

    await h.coworker.preflight();

    const warning = h.warnings.join("\n");
    expect(warning).toContain("Enormous.md");
    expect(warning).toMatch(/only its first part was checked/i);
    expect(warning).toMatch(/nothing is claimed about the rest/i);
  });

  it("does not warn about a Skill that correctly names an environment variable", async () => {
    const h = await coworkerHarness();
    // The correct form of the very thing the lint is looking for. A check that fires on
    // this gets turned off, and then it catches nothing at all.
    await writeSkill(
      h.skillsDir,
      "Database access",
      [
        "The connection string is in `ANALYTICS_DATABASE_URL`.",
        "",
        '```sh',
        'psql "$ANALYTICS_DATABASE_URL" --csv -c "select count(*) from orders"',
        'PGPASSWORD=$ANALYTICS_DB_PASSWORD psql -h analytics.internal -U reader',
        'psql "postgres://reader:$PGPASSWORD@analytics.internal/main"',
        '```',
      ].join("\n"),
    );

    await h.coworker.preflight();

    expect(h.warnings).toEqual([]);
  });
});

describe("the credential lint", () => {
  it("recognises the shapes a leaked credential actually takes", () => {
    const shapes = [
      ["a GitHub token", "Use `ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8`."],
      ["a Slack token", "Set it to `" + ["xoxb", "test-token"].join("-") + "`."],
      ["an OpenAI key", "`sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6`"],
      ["an AWS access key id", "`AKIAIOSFODNN7EXAMPLE`"],
      ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n"],
    ] as const;

    for (const [what, body] of shapes) {
      expect(credentialShapesIn(body), what).toContain(what);
    }
  });

  it("says nothing about prose that merely talks about credentials", () => {
    expect(
      credentialShapesIn(
        "Never paste the token into a Note. The password lives in `DB_PASSWORD`, and the " +
          "API key is in `LINEAR_API_KEY`. Do not print them.\n",
      ),
    ).toEqual([]);
  });
});

describe("reading the Skills", () => {
  it("lists Markdown by title, including inside folders a human made", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "Database access", "body\n");
    await writeSkill(path.join(h.skillsDir, "Finance"), "Weekly export", "body\n");
    // Not a procedure: Obsidian's own state, and a stray attachment.
    await mkdir(path.join(h.skillsDir, ".obsidian"), { recursive: true });
    await writeFile(path.join(h.skillsDir, ".obsidian", "workspace.json"), "{}", "utf8");
    await writeFile(path.join(h.skillsDir, "diagram.png"), "not markdown", "utf8");

    const skills = await readSkills(h.skillsDir);

    expect(skills.map((skill) => skill.path)).toEqual([
      "Database access.md",
      "Finance/Weekly export.md",
    ]);
    expect(skills.map((skill) => skill.title)).toEqual(["Database access", "Weekly export"]);
  });

  it("reads an absent Skills directory as empty rather than failing", async () => {
    const h = await coworkerHarness();

    // The ordinary starting state, and a Job against it must still run.
    expect(await readSkills(path.join(h.root, "nothing-here"))).toEqual([]);
  });

  it("does not advertise the README to the coworker as a procedure", async () => {
    const h = await coworkerHarness();
    // What a self-hoster gets by following the copy instruction in `assets/skills`. The
    // README explains how to *write* a Skill, so a Job told it is one reads the
    // instructions for authoring procedures instead of the procedure.
    await writeSkill(h.skillsDir, "README", "# Skills\n\nHow to write one.\n");
    await writeSkill(h.skillsDir, "Database access", "Use `$ANALYTICS_DATABASE_URL`.\n");

    await h.mention();

    const prompt = h.engine.ranTurns[0]!.prompt;
    expect(prompt).toContain("[[Database access]]");
    expect(prompt).not.toContain("[[README]]");
    // Still read from disk, though: the credential scan wants it, because a README's
    // examples are exactly where someone pastes a real connection string.
    expect((await readSkills(h.skillsDir)).map((skill) => skill.path)).toContain("README.md");
  });

  it("says the Skills are empty when the README is the only file", async () => {
    const h = await coworkerHarness();
    await writeSkill(h.skillsDir, "README", "# Skills\n\nHow to write one.\n");

    await h.mention();

    // Not "here are your Skills:" followed by nothing, which is what filtering after the
    // empty check would produce.
    expect(h.engine.ranTurns[0]!.prompt).toMatch(/none there yet/i);
  });
});

describe("the shipped starter Skills", () => {
  it("state the two rules the next author has to know", async () => {
    const readme = await readFile(
      path.join(import.meta.dirname, "..", "assets", "skills", "README.md"),
      "utf8",
    );

    // Documented at the Skill location itself, per the ticket: whoever writes the next
    // one reads this file, not the project's docs.
    expect(readme).toMatch(/never contains a credential/i);
    expect(readme).toMatch(/environment variable/i);
    // And the one that is easy to leave out and expensive to omit: a Skill drives the
    // shell, so the MCP deny-list does not cover it.
    expect(readme).toMatch(/credential is the entire boundary/i);
    expect(readme).toMatch(/read-only database role is a \*\*requirement\*\*/i);
  });

  it("carry no credential of their own", async () => {
    const directory = path.join(import.meta.dirname, "..", "assets", "skills");

    expect((await readSkills(directory)).length).toBeGreaterThan(0);
    // The example Skill is the likeliest place in the repo for a plausible-looking
    // connection string to be pasted, and it is scanned by the same check a self-hoster's
    // own Skills get.
    expect(await credentialConcerns(directory)).toEqual([]);
  });
});

/**
 * The same instance again, with its Skills moved somewhere they cannot stay read-only.
 *
 * The harness builds a correct layout on purpose, so testing the checks that catch a
 * broken one means rebuilding against a broken configuration. **Over the same root**, so
 * that the Notes and workspace directories the checks compare against are the ones this
 * instance actually uses — a fresh root would make "inside the Notes directory" a claim
 * about some other instance's Notes, and every check would pass.
 */
function withSkillsAt(h: CoworkerHarness, skillsDir: string): Promise<CoworkerHarness> {
  return coworkerHarness({ root: h.root, skillsDir });
}
