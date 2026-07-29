import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORDED_CODEX_VERSION } from "../../src/config.ts";
import { createCodexEngine } from "../../src/engine/codex.ts";
import type { Engine, EngineEvent } from "../../src/ports/engine.ts";
import { changesBetween, snapshotVault } from "../../src/vault/snapshot.ts";
import { writeScope, writesIn, type Write } from "../../src/writes/classify.ts";

/**
 * The contract seam.
 *
 * These tests run a **real `codex exec`**, so they need working Codex credentials
 * and they cost tokens. They are excluded from `pnpm test` and run with
 * `pnpm test:contract`.
 *
 * They exist because this is the one place a fake can drift from reality, and v1
 * pins no Codex version: with multiple upstream alphas a day, this suite is what
 * stands between an alpha that changed the event stream and an instance that is
 * silently broken. Run it against whatever version is installed, not only at a
 * deliberate bump.
 *
 * Cover only what a fake cannot honestly assert. Everything else belongs at the top
 * seam in `tests/coworker.test.ts`.
 */

let engine: Engine;
let workspace: string;

beforeAll(async () => {
  engine = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low" });
  workspace = await mkdtemp(path.join(os.tmpdir(), "open-agent-contract-"));
  await writeFile(
    path.join(workspace, "AGENTS.md"),
    "# Operating manual\n\nAnswer exactly what you are asked, with no preamble.\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Every process this one spawned directly. */
const childPids = (): Promise<number[]> => childPidsOf(process.pid);

/** The direct children of a pid. `pgrep` prints nothing and exits 1 when there are none. */
async function childPidsOf(pid: number): Promise<number[]> {
  const { stdout } = await promisify(execFile)("pgrep", ["-P", String(pid)]).catch(() => ({
    stdout: "",
  }));
  return stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0);
}

/** Everything below a pid, however deep. A shell command is not always a direct child. */
async function descendantsOf(pid: number): Promise<number[]> {
  const children = await childPidsOf(pid);
  const below = await Promise.all(children.map(descendantsOf));
  return [...children, ...below.flat()];
}

/** Signal 0 asks the kernel whether the process exists without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the real engine", () => {
  it("reports the version that will actually run", async () => {
    const version = await engine.version();

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    if (version !== RECORDED_CODEX_VERSION) {
      console.warn(
        `Codex ${version} is installed; this project records ${RECORDED_CODEX_VERSION}. ` +
          "If the assertions below fail, upstream changed something.",
      );
    }
  });

  it("translates a real turn's event stream into the wrapper's events", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const events: EngineEvent[] = [];
    for await (const event of session.run(
      'Reply with exactly the word PONG and nothing else. Do not run any commands.',
    )) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).toContain("session-started");
    expect(types).toContain("turn-started");
    expect(types).toContain("turn-completed");
    expect(types).not.toContain("turn-failed");

    const started = events.find((event) => event.type === "session-started");
    expect(started?.type === "session-started" && started.sessionId).toMatch(/[0-9a-f-]{36}/);
    // The Session's identity is what the wrapper persists against a Thread.
    expect(session.id).toBe(started?.type === "session-started" ? started.sessionId : undefined);

    const answers = events.flatMap((event) => (event.type === "message" ? [event.text] : []));
    expect(answers.at(-1)).toContain("PONG");

    const completed = events.find((event) => event.type === "turn-completed");
    expect(completed?.type === "turn-completed" && completed.usage?.outputTokens).toBeGreaterThan(
      0,
    );
  });

  it("resumes a Session in a fresh process, remembering what it was told", async () => {
    const first = engine.startSession({ workingDirectory: workspace });
    for await (const event of first.run(
      "Remember this for later: the deploy codeword is `saltmarsh`. Reply with just OK.",
    )) {
      if (event.type === "turn-failed") throw new Error(event.message);
    }
    const sessionId = first.id;
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    // A second engine over the same installed Codex, sharing nothing with the first
    // but the identifier — which is exactly what the wrapper persists and all it has
    // after a restart. The Session's content is on Codex's disk, not in this process.
    const restarted = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low" });
    const resumed = restarted.resumeSession(sessionId!, { workingDirectory: workspace });

    const answers: string[] = [];
    for await (const event of resumed.run("What was the deploy codeword? Reply with just the word.")) {
      if (event.type === "message") answers.push(event.text);
      if (event.type === "turn-failed") throw new Error(event.message);
    }

    expect(answers.at(-1)?.toLowerCase()).toContain("saltmarsh");
    expect(resumed.id).toBe(sessionId);
  });

  /**
   * Ticket 02 asks that the coworker **cannot** reach Codex's own session storage,
   * verified rather than assumed. This is the verification, and it currently fails to
   * find any such guarantee: under `workspace-write` the sandbox allows reads
   * anywhere, `codex exec` exposes no way to narrow them (`--permission-profile` and
   * its readable roots are not on `exec`, and `sandbox_permissions=[]` is inert), so a
   * Job can list every Thread's rollout file.
   *
   * The assertion is therefore written the way the finding actually is. **If this test
   * starts failing, that is good news**: upstream has restricted reads, and ADR-0003's
   * "Sessions never read each other" can be upgraded from a behavioural guarantee to a
   * structural one. See the comments on ticket 02.
   */
  it("cannot yet be prevented from reading Codex's own session storage", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const outputs: string[] = [];
    for await (const event of session.run(
      'Run the shell command `find "$HOME/.codex/sessions" -name "*.jsonl" | head -2` ' +
        "and report its output verbatim. Do not do anything else.",
    )) {
      if (event.type === "command" && event.status === "completed") outputs.push(event.output);
    }

    // Asserted on the rollout filenames themselves rather than on the absence of a
    // denial message: "no such file or directory" is also not a denial, and a test that
    // passed on it would report this hole as closed when the directory had merely moved.
    expect(outputs.join("\n")).toMatch(/rollout-[\dT-]+-[0-9a-f-]{36}\.jsonl/);
  });

  /**
   * The status message is the engine's own todo list, so two facts about `exec` are
   * load-bearing and neither can be honestly asserted against a fake: that a plan is
   * emitted at all, and that it is **revised** mid-Turn rather than reported once at
   * the end. Without the second, "which step it is on" has nothing to show.
   */
  it("emits a todo list, and revises it as it works", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const plans: EngineEvent[] = [];
    const commands: EngineEvent[] = [];
    for await (const event of session.run(
      "Use your plan tool to record these three steps before starting, then carry them " +
        "out, marking each one complete as you finish it: (1) run `echo one`, " +
        "(2) run `echo two`, (3) reply with just DONE.",
    )) {
      if (event.type === "plan") plans.push(event);
      if (event.type === "command") commands.push(event);
    }

    const steps = plans.flatMap((event) => (event.type === "plan" ? [event.steps] : []));
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]!.length).toBeGreaterThan(1);
    const done = (index: number): number => steps[index]!.filter((step) => step.completed).length;
    expect(done(steps.length - 1)).toBeGreaterThan(done(0));

    // And activity is reported when a command *starts*. A long command is silent
    // until it completes, so without this the status could only ever say what the
    // coworker has already finished.
    expect(
      commands.some((event) => event.type === "command" && event.status === "in-progress"),
    ).toBe(true);
  });

  /**
   * A Note the coworker writes into the human's Vault, end to end, against a real
   * engine — and the two mechanisms that answer for it, which are deliberately not the
   * same mechanism.
   *
   * The **engine** has to actually apply a patch outside its working directory when that
   * directory is passed as writable. A fake asserts that by construction; if `exec` ever
   * stops honouring `additionalDirectories`, every Note the coworker tries to write fails
   * and nothing else in this suite would notice.
   *
   * The **record** comes from the Vault's own contents rather than from the event
   * (`vault/snapshot.ts`), which is what lets it catch a Note written by shell
   * redirection and carry what the Note now says. So the classifier is asserted to record
   * *nothing* here — a Vault path is not its business — and the snapshot is asserted to
   * record exactly the one file, once. Two records for one Write is precisely what an
   * audit trail must not do, and with two mechanisms in play that is worth pinning
   * against the real thing.
   */
  it("writes into the Vault outside its workspace, and is recorded once from the Vault", async () => {
    const vault = path.join(workspace, "..", `vault-${path.basename(workspace)}`);
    await mkdir(vault, { recursive: true });
    const before = await snapshotVault(vault);
    const session = engine.startSession({
      workingDirectory: workspace,
      writableDirectories: [vault],
    });

    const writes: Write[] = [];
    const scope = await writeScope({ workspaceDir: workspace, vaultDir: vault, servers: [] });
    const changes: EngineEvent[] = [];
    for await (const event of session.run(
      "Using your file-editing tool and not shell redirection, create exactly two files: " +
        `\`${path.join(workspace, "scratch.md")}\` containing the word ONE, and ` +
        `\`${path.join(vault, "note.md")}\` containing the word TWO. Then reply with just DONE.`,
    )) {
      if (event.type === "file-change") changes.push(event);
      writes.push(...writesIn(event, scope));
    }

    expect(changes.length).toBeGreaterThan(0);
    expect(await readFile(path.join(vault, "note.md"), "utf8")).toContain("TWO");
    // Neither file is recorded from the event stream: the scratch file next to its own
    // AGENTS.md is the coworker's own desk, and the Note is the Vault's to answer for.
    expect(writes).toEqual([]);
    // And the Vault answers for it: one change, the Note, with what it now says.
    const vaultChanges = changesBetween(before, await snapshotVault(vault));
    expect(vaultChanges.map((change) => change.path)).toEqual(["note.md"]);
    expect(vaultChanges[0]?.kind).toBe("add");
    expect(vaultChanges[0]?.diff).toContain("TWO");
  });

  /**
   * A real command Write, end to end: a real `git push` into a real repository.
   *
   * The whole reason this is worth tokens is that the *shape* of what the engine
   * reports decided the design. A shell call arrives as
   * `/bin/zsh -lc "git add … && git commit … && git push …"` — the program is behind a
   * quote rather than at the start of the string, and one item carries a whole script —
   * and a table of patterns written against `git push …` on its own would match none of
   * it. A fake cannot tell us that, because a fake says whatever the test says.
   *
   * The remote is a bare repository on disk, so nothing here needs a network or a
   * credential.
   */
  it("recognises a Write in a command the way the engine really reports it", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "open-agent-push-"));
    const remote = path.join(repo, "remote.git");
    const checkout = path.join(repo, "checkout");
    const git = (...args: string[]): Promise<unknown> => promisify(execFile)("git", args);
    await git("init", "--bare", remote);
    await git("init", checkout);
    await git("-C", checkout, "config", "user.email", "coworker@example.com");
    await git("-C", checkout, "config", "user.name", "Coworker");
    // The self-hoster running this may well sign their commits; the agent cannot answer
    // a passphrase prompt, and this test is not about signing.
    await git("-C", checkout, "config", "commit.gpgsign", "false");
    await writeFile(path.join(checkout, "AGENTS.md"), "Answer what you are asked.\n", "utf8");
    await writeFile(path.join(checkout, "README.md"), "one\n", "utf8");
    await git("-C", checkout, "add", ".");
    await git("-C", checkout, "commit", "-m", "first");
    await git("-C", checkout, "remote", "add", "origin", remote);
    const before = await git("-C", remote, "rev-parse", "HEAD");

    const session = engine.startSession({ workingDirectory: checkout });
    const scope = await writeScope({
      workspaceDir: checkout,
      vaultDir: path.join(repo, "vault"),
      servers: [],
    });
    const writes: Write[] = [];
    for await (const event of session.run(
      "Append the word two to README.md, commit it with git, and push it to origin on " +
        "the current branch. Do not use gh. Then reply with just DONE.",
    )) {
      writes.push(...writesIn(event, scope));
    }

    // The push really happened — the bare repository moved on.
    const after = await git("-C", remote, "rev-parse", "HEAD");
    expect(after).not.toEqual(before);
    // And it was recorded as what it was. There may be more than one: the coworker
    // retries, and an attempt that did not obviously succeed is recorded too.
    //
    // Nothing is asserted about the outcome on purpose, and this test is why. The push
    // demonstrably worked — the remote moved — yet it arrives inside a chained command
    // that ends non-zero often enough that "the push succeeded" is not a claim the exit
    // code supports. `Write.failure` says only what is known.
    expect(writes.map((write) => write.action)).toContain("Pushed to a git remote");
    // The commit and the edit are not Writes: one is inside the checkout it was given,
    // and the other never left the workspace at all.
    expect(writes.every((write) => write.action === "Pushed to a git remote")).toBe(true);

    await rm(repo, { recursive: true, force: true });
  });

  /**
   * The bounds — the wall clock, the Turn cap, the token budget, and a person typing
   * "stop" — all reduce to one thing: abort the signal the run was given. Every one of
   * them is worthless if that leaves a real `codex exec` running, and no fake can tell
   * us whether it does. A Job that has been stopped and is still spending money has not
   * been stopped.
   *
   * The process is found rather than assumed: the SDK spawns the binary as a direct
   * child of this one, so anything new under this pid during the run is it.
   */
  it("kills the real Codex process when the run is aborted", async () => {
    const controller = new AbortController();
    const session = engine.startSession({ workingDirectory: workspace });
    const before = await childPids();
    const startedAt = Date.now();

    let spawned: number[] = [];
    let underIt: number[] = [];
    const run = (async () => {
      for await (const event of session.run(
        "Run the shell command `sleep 120` and then reply with just DONE.",
        { signal: controller.signal },
      )) {
        // Aborted while a command is genuinely in flight, which is the shape of every
        // Job a bound ever stops — not a process idling between turns.
        if (event.type === "command" && event.status === "in-progress") {
          spawned = (await childPids()).filter((pid) => !before.includes(pid));
          underIt = (await Promise.all(spawned.map(descendantsOf))).flat();
          controller.abort();
        }
      }
    })();

    // The abort surfaces as a rejection, which is why the Job runner prefers the reason
    // the bound holds over the one the error carries.
    await expect(run).rejects.toThrow();
    expect(spawned.length).toBeGreaterThan(0);

    for (const pid of spawned) {
      // SIGTERM is not instant; a couple of seconds is generous and still nothing like
      // the two minutes the command it was running would have taken.
      await until(() => !alive(pid), 5_000);
      expect(alive(pid)).toBe(false);
    }
    // And it did not quietly wait for `sleep 120` to finish first.
    expect(Date.now() - startedAt).toBeLessThan(90_000);

    /**
     * **The command Codex had already launched outlives it**, reparented to init.
     * Measured, not assumed, and asserted as measured rather than as desirable: the
     * SDK kills the process it spawned, and that process is not a process-group
     * leader, so the `sleep 120` further down the tree keeps sleeping. Codex's own
     * direct child does die — it is the leaf that is orphaned.
     *
     * This is a real limit on what "stop" means, and it is the same limit the Job's
     * report already tells the human about: stopping unwinds nothing, and something in
     * flight may land anyway. What it does **not** leak is spend — the model is only
     * ever called by the process that just died — which is why the token budget is
     * still a bound on cost.
     *
     * **If this starts failing, that is good news:** upstream began killing the
     * process group, and this paragraph can go.
     */
    expect(underIt.length).toBeGreaterThan(0);
    expect(underIt.some(alive)).toBe(true);
    for (const pid of underIt) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone. Nothing to tidy.
      }
    }
  });

  it("translates a command execution, including its output and exit code", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const events: EngineEvent[] = [];
    for await (const event of session.run(
      "Run the shell command `echo open-agent-contract` and tell me its output.",
    )) {
      events.push(event);
    }

    const commands = events.flatMap((event) => (event.type === "command" ? [event] : []));
    expect(commands.length).toBeGreaterThan(0);
    const finished = commands.filter((command) => command.status === "completed");
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.map((command) => command.output).join("\n")).toContain(
      "open-agent-contract",
    );
    expect(finished.every((command) => command.exitCode === 0)).toBe(true);
  });
});
