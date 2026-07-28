import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORDED_CODEX_VERSION } from "../../src/config.ts";
import { createCodexEngine } from "../../src/engine/codex.ts";
import type { Engine, EngineEvent } from "../../src/ports/engine.ts";

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
