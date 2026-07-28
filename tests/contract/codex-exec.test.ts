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
    // The Session's identity is what ticket 02 will persist against a Thread.
    expect(session.id).toBe(started?.type === "session-started" ? started.sessionId : undefined);

    const answers = events.flatMap((event) => (event.type === "message" ? [event.text] : []));
    expect(answers.at(-1)).toContain("PONG");

    const completed = events.find((event) => event.type === "turn-completed");
    expect(completed?.type === "turn-completed" && completed.usage?.outputTokens).toBeGreaterThan(
      0,
    );
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
