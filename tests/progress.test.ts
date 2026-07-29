import { describe, expect, it } from "vitest";
import type { ActivityStatus } from "../src/ports/engine.ts";
import {
  SLACK_STATUS_TIMEOUT_MS,
  STATUS_BACKOFF_MS,
  STATUS_HEARTBEAT_MS,
  STATUS_POLL_MS,
} from "../src/reporter/status.ts";
import { deferred } from "./support/fakes.ts";
import { coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";

const A_LONG_SILENCE_MS = 10 * 60_000;

describe("the status message", () => {
  it("keeps to one message it edits, however much the engine has to say", async () => {
    const h = await coworkerHarness();
    const busy = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      yield { type: "plan", steps: [{ text: "Find the deploy config", completed: false }] };
      for (const command of ["git log", "rg deploy", "pnpm test"]) {
        yield { type: "command", command, status: "in-progress", output: "", exitCode: undefined };
        yield { type: "command", command, status: "completed", output: "ok", exitCode: 0 };
      }
      busy.resolve();
      await release.promise;
      yield { type: "message", text: "We deploy from `main` on merge." };
    };

    const delivery = await h.startMention();
    await busy.promise;
    await h.clock.advance(3 * STATUS_HEARTBEAT_MS);
    release.resolve();
    if (delivery.accepted) await delivery.completed;

    // The whole Job, in two messages: the status, and the answer.
    expect(h.slack.posts).toHaveLength(2);
    const statusTs = h.slack.tsOf(0);
    expect(h.slack.edits.length).toBeGreaterThan(1);
    expect(h.slack.edits.every((edit) => edit.ts === statusTs)).toBe(true);
  });

  it("shows the coworker's own plan and which step it is on", async () => {
    const h = await coworkerHarness();
    const planned = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      yield {
        type: "plan",
        steps: [
          { text: "Read the failing test", completed: true },
          { text: "Fix the assertion", completed: false },
          { text: "Run the suite", completed: false },
        ],
      };
      planned.resolve();
      await release.promise;
      yield { type: "message", text: "Fixed — the assertion was inverted." };
    };

    const delivery = await h.startMention();
    await planned.promise;
    await h.clock.advance(STATUS_HEARTBEAT_MS);

    const status = h.slack.currentTextOf(h.slack.tsOf(0));
    expect(status).toContain("Read the failing test");
    expect(status).toContain("Fix the assertion");
    expect(status).toContain("Run the suite");
    // The step it is on is marked out from the one behind it and the one ahead.
    const marker = (step: string): string =>
      status.split("\n").find((line) => line.includes(step))?.slice(0, 2) ?? "";
    expect(marker("Fix the assertion")).not.toBe(marker("Read the failing test"));
    expect(marker("Fix the assertion")).not.toBe(marker("Run the suite"));

    release.resolve();
    if (delivery.accepted) await delivery.completed;
  });

  it("says what it is doing right now, not just that it is busy", async () => {
    const h = await coworkerHarness();
    const running = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      yield {
        type: "command",
        command: "pnpm test --filter deploy",
        status: "in-progress",
        output: "",
        exitCode: undefined,
      };
      running.resolve();
      await release.promise;
      yield { type: "message", text: "All 412 tests pass." };
    };

    const delivery = await h.startMention();
    await running.promise;
    await h.clock.advance(STATUS_HEARTBEAT_MS);

    expect(h.slack.currentTextOf(h.slack.tsOf(0))).toContain("pnpm test --filter deploy");

    release.resolve();
    if (delivery.accepted) await delivery.completed;
  });

  it("keeps refreshing through a long silence, inside Slack's status timeout", async () => {
    const h = await coworkerHarness();
    const running = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      // A long command is silent until it completes. Silence must not read as a crash.
      yield {
        type: "command",
        command: "pnpm test",
        status: "in-progress",
        output: "",
        exitCode: undefined,
      };
      running.resolve();
      await release.promise;
      yield { type: "message", text: "All 412 tests pass." };
    };

    const delivery = await h.startMention();
    await running.promise;
    await h.clock.advance(A_LONG_SILENCE_MS);
    release.resolve();
    if (delivery.accepted) await delivery.completed;

    const landedAt = h.slack.timesOf(h.slack.tsOf(0));
    const gaps = landedAt.slice(1).map((at, index) => at - landedAt[index]!);
    expect(gaps.length).toBeGreaterThan(4);
    expect(Math.max(...gaps)).toBeLessThan(SLACK_STATUS_TIMEOUT_MS);
    // Slack's own thinking indicator is kept alive on the same beat, since it is the
    // thing that actually disappears after two minutes.
    expect(h.slack.statuses.filter((call) => call.status !== "").length).toBeGreaterThan(4);
  });

  it("folds a tool call into the status message rather than narrating it", async () => {
    const h = await coworkerHarness();
    const calling = deferred();
    const called = deferred();
    const release = deferred();
    const done = deferred();
    const call = (status: ActivityStatus) => ({
      type: "tool-call" as const,
      server: "linear",
      tool: "save_issue",
      status,
      error: undefined,
      result: undefined,
    });
    h.engine.script = async function* () {
      yield call("in-progress");
      calling.resolve();
      await release.promise;
      yield call("completed");
      called.resolve();
      await done.promise;
      yield { type: "message", text: "Filed ENG-412." };
    };

    const delivery = await h.startMention();
    await calling.promise;
    await h.clock.advance(STATUS_POLL_MS);

    // While it is running it shows up only in the status message. The permanent connector
    // audit is appended when the call completes, not when it merely starts.
    expect(h.slack.currentTextOf(h.slack.tsOf(0))).toContain("save_issue");
    expect(h.slack.posts).toHaveLength(1);

    release.resolve();
    await called.promise;
    await h.clock.advance(STATUS_POLL_MS);

    // And once the call finished, the status stopped claiming it was happening.
    expect(h.slack.currentTextOf(h.slack.tsOf(0))).not.toContain("save_issue");

    done.resolve();
    if (delivery.accepted) await delivery.completed;

    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toHaveLength(3);
    expect(h.slack.posts[1]?.text).toContain("save_issue");
  });

  it("keeps its private working out of the channel", async () => {
    const h = await coworkerHarness();
    const thought = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      // Reasoning summaries and finished web searches are deliberately not activity:
      // the first is the coworker's own working, in a channel where colleagues who did
      // not ask are reading, and the second has nothing to clear it once it is done.
      yield { type: "reasoning", text: "The staging secrets look like they leaked in #ops." };
      yield { type: "web-search", query: "acme corp internal salary bands" };
      thought.resolve();
      await release.promise;
      yield { type: "message", text: "Staging deploys from `develop`." };
    };

    const delivery = await h.startMention();
    await thought.promise;
    await h.clock.advance(STATUS_HEARTBEAT_MS);

    const shown = h.slack.versionsOf(h.slack.tsOf(0)).join("\n");
    expect(shown).not.toContain("leaked");
    expect(shown).not.toContain("salary");

    release.resolve();
    if (delivery.accepted) await delivery.completed;
  });

  it("settles into a final state and stops refreshing once the Job is done", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      { type: "plan", steps: [{ text: "Check the staging config", completed: true }] },
      { type: "message", text: "The staging config is stale." },
    ];

    await h.mention();
    const settled = h.slack.currentTextOf(h.slack.tsOf(0));
    const editsWhenDone = h.slack.edits.length;

    await h.clock.advance(A_LONG_SILENCE_MS);

    expect(h.slack.edits).toHaveLength(editsWhenDone);
    expect(settled).toContain("Check the staging config");
    expect(settled).toMatch(/done/i);
    // And Slack's indicator is cleared rather than left spinning on a finished Job.
    expect(h.slack.statuses.at(-1)?.status).toBe("");
  });

  it("settles into a stopped state when the Job did not finish", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => {
      throw new Error("codex: command not found");
    };

    await h.mention();

    expect(h.slack.currentTextOf(h.slack.tsOf(0))).toMatch(/stopped/i);
  });

  it("stays visibly apart from the answer, so the Thread stays skimmable afterwards", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [{ type: "message", text: "We deploy from `main` on merge." }];

    await h.mention();

    const settled = h.slack.currentTextOf(h.slack.tsOf(0));
    const answer = h.slack.posts[1]?.text ?? "";
    expect(answer).toBe("We deploy from `main` on merge.");
    // The working is not repeated into the answer, and the status is not prose.
    expect(settled).not.toContain("We deploy from");
    expect(settled).toMatch(/^:[a-z_]+: /);
    expect(answer).not.toMatch(/^:[a-z_]+: /);
  });

  it("gives each Thread its own status message", async () => {
    const h = await coworkerHarness();

    await h.mention({ thread_ts: "1700000042.000100" });
    await h.mention({ thread_ts: "1700000099.000100" });

    const edited = new Set(h.slack.edits.map((edit) => edit.ts));
    expect(edited).toEqual(new Set([h.slack.tsOf(0), h.slack.tsOf(2)]));
    expect(h.slack.edits.every((edit) => edit.thread.ts !== DEFAULT_THREAD_TS)).toBe(true);
  });

  it("still answers when Slack refuses to edit the status message", async () => {
    const h = await coworkerHarness();
    h.slack.failEdits = new Error("message_not_found");
    h.engine.script = () => [{ type: "message", text: "The answer." }];

    await h.mention();

    // Progress is a courtesy; the answer is the Job. Losing the first must not lose
    // the second, and the self-hoster should be told once rather than every 45 seconds.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("The answer.");
    expect(h.warnings.filter((warning) => /status message/i.test(warning))).toHaveLength(1);
  });

  it("still reports a refused edit when the indicator failed first", async () => {
    const h = await coworkerHarness();
    // An app whose scopes predate `setStatus` accepting `chat:write` fails on the very
    // first call, before any work has happened. One warning covering both kinds would
    // be spent here, and the failure that actually matters would go unlogged.
    h.slack.failStatuses = new Error("missing_scope");
    h.slack.failEdits = new Error("ratelimited");
    h.engine.script = () => [{ type: "message", text: "The answer." }];

    await h.mention();

    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("The answer.");
    expect(h.warnings.filter((warning) => /status message/i.test(warning))).toHaveLength(1);
    expect(h.warnings.filter((warning) => /indicator/i.test(warning))).toHaveLength(1);
  });

  it("stops pushing a message Slack refuses, but keeps the indicator alive", async () => {
    const h = await coworkerHarness();
    const working = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      yield {
        type: "command",
        command: "pnpm test",
        status: "in-progress",
        output: "",
        exitCode: undefined,
      };
      working.resolve();
      await release.promise;
      yield { type: "message", text: "All 412 tests pass." };
    };
    h.slack.failEdits = new Error("ratelimited");

    const delivery = await h.startMention();
    await working.promise;
    await h.clock.advance(A_LONG_SILENCE_MS);

    // Having been refused, it waits out the backoff before trying again rather than
    // pushing on the ordinary heartbeat.
    const attemptedAt = h.slack.editAttempts.map((attempt) => attempt.at);
    const gaps = attemptedAt.slice(1).map((at, index) => at - attemptedAt[index]!);
    expect(gaps.length).toBeGreaterThan(2);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(STATUS_BACKOFF_MS);

    // Slack's indicator is a different method on a far larger allowance, and it is what
    // tells the human the Job is alive — so it keeps beating right through the backoff.
    const lit = h.slack.statuses.filter((call) => call.status !== "");
    const litAt = lit.map((call) => call.at);
    expect(Math.max(...litAt.slice(1).map((at, index) => at - litAt[index]!))).toBeLessThan(
      SLACK_STATUS_TIMEOUT_MS,
    );

    const attemptsBeforeSettling = h.slack.editAttempts.length;
    release.resolve();
    if (delivery.accepted) await delivery.completed;

    // The final state is written regardless: it is the one that has to land, and it is
    // one call rather than a cadence.
    expect(h.slack.editAttempts).toHaveLength(attemptsBeforeSettling + 1);
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("All 412 tests pass.");
  });

  it("writes no more than one edit per poll however fast the engine talks", async () => {
    const h = await coworkerHarness();
    const chatty = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      for (let step = 0; step < 200; step++) {
        yield { type: "plan", steps: [{ text: `Step ${step}`, completed: false }] };
      }
      chatty.resolve();
      await release.promise;
      yield { type: "message", text: "Done." };
    };

    const delivery = await h.startMention();
    await chatty.promise;
    await h.clock.advance(STATUS_POLL_MS);
    release.resolve();
    if (delivery.accepted) await delivery.completed;

    // `chat.update` is Tier 3 — 50+ per minute — and an engine emitting a revised plan
    // per second must not be able to spend that on one Job.
    expect(h.slack.edits.length).toBeLessThanOrEqual(2);
  });
});
