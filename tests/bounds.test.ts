import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../src/ports/engine.ts";
import { deferred } from "./support/fakes.ts";
import { BOT_USER_ID, coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";

/**
 * Everything that happens when a Job does not simply succeed.
 *
 * Codex supplies none of this. It has no timeout, no cap on Turns, no budget and no
 * kill switch, and it reports what a Turn cost only once the Turn is over — so a
 * runaway Job runs until a human notices unless the wrapper stops it. These tests are
 * that promise: something stops it, the Thread says plainly that it was stopped rather
 * than finished, and the next Job in the Thread is told the state it inherited is
 * uncertain.
 */

/** A Turn that never ends: the wedged engine every wall clock exists for. */
const neverFinishes = () => new Promise<EngineEvent[]>(() => {});

/** The report is the Job's last message, after the acknowledgement and any records. */
const reportIn = (h: Awaited<ReturnType<typeof coworkerHarness>>, threadTs: string): string =>
  h.slack.textsIn(threadTs).at(-1) ?? "";

describe("the wall clock on a Turn", () => {
  it("has no timeout by default", async () => {
    const h = await coworkerHarness();
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    // Past the old one-hour default: omission now means unlimited.
    await h.clock.advance(3_600_001);
    expect(h.engine.ranTurns[0]?.aborted).toBe(false);

    await h.mention({ text: `<@${BOT_USER_ID}> stop`, user: "U_IMPATIENT" });
    if (delivery.accepted) await delivery.completed;

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
  });

  it("can be enabled explicitly", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 30_000 } });
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    await h.clock.advance(29_000);
    expect(h.engine.ranTurns[0]?.aborted).toBe(false);

    await h.clock.advance(2_000);
    if (delivery.accepted) await delivery.completed;

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    expect(reportIn(h, DEFAULT_THREAD_TS)).toContain("30 seconds");
  });

  it("still kills an engine that finished its Turn and then would not let go", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 30_000 } });
    const turnOver = deferred();
    h.engine.script = async function* () {
      yield { type: "message", text: "The answer." } as const;
      yield { type: "turn-completed", usage: undefined } as const;
      turnOver.resolve();
      // The Turn is over and the stream never closes. Standing the clock down here
      // because "nothing is running" would leave this Job unbounded forever — the
      // same wedge the wall clock exists for, wearing a different hat.
      await new Promise(() => {});
    };

    const delivery = await h.startMention();
    await turnOver.promise;
    await h.clock.advance(31_000);
    if (delivery.accepted) await delivery.completed;

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    // The answer it managed is still the answer; the Job is still not "finished".
    expect(reportIn(h, DEFAULT_THREAD_TS)).toContain("The answer.");
    expect(reportIn(h, DEFAULT_THREAD_TS)).toContain("Stopped");
  });
});

describe("the cap on Turns", () => {
  it("has no Turn cap by default", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      ...Array.from({ length: 9 }, () => [
        { type: "turn-completed", usage: undefined } as const,
        { type: "turn-started" } as const,
      ]).flat(),
      { type: "message", text: "Ten Turns completed." } as const,
    ];

    await h.mention();

    expect(h.engine.ranTurns[0]?.aborted).toBe(false);
    expect(reportIn(h, DEFAULT_THREAD_TS)).toBe("Ten Turns completed.");
  });

  it("stops a Job that keeps starting new Turns", async () => {
    const h = await coworkerHarness({ bounds: { maxTurnsPerJob: 3 } });
    // The engine opens with a Turn of its own, so this scripts the three after it.
    h.engine.script = () => [
      { type: "turn-completed", usage: undefined },
      { type: "turn-started" },
      { type: "turn-completed", usage: undefined },
      { type: "turn-started" },
      { type: "turn-completed", usage: undefined },
      { type: "turn-started" },
      { type: "message", text: "Still going." },
    ];

    await h.mention();

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    const report = reportIn(h, DEFAULT_THREAD_TS);
    expect(report).toContain("Stopped");
    expect(report).toContain("3 turns");
  });

  it("lets a Job that stays inside the cap finish normally", async () => {
    const h = await coworkerHarness({ bounds: { maxTurnsPerJob: 3 } });
    h.engine.script = () => [
      { type: "turn-completed", usage: undefined },
      { type: "turn-started" },
      { type: "message", text: "Two Turns was enough." },
      { type: "turn-completed", usage: undefined },
    ];

    await h.mention();

    expect(h.engine.ranTurns[0]?.aborted).toBe(false);
    expect(reportIn(h, DEFAULT_THREAD_TS)).toBe("Two Turns was enough.");
  });
});

describe("the token budget", () => {
  const usage = (input: number, output: number) =>
    ({
      inputTokens: input,
      cachedInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    }) as const;

  it("has no token budget by default", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      { type: "turn-completed", usage: usage(1_000_000, 250_000) },
      { type: "message", text: "No default token stop." },
    ];

    await h.mention();

    expect(h.engine.ranTurns[0]?.aborted).toBe(false);
    expect(reportIn(h, DEFAULT_THREAD_TS)).toBe("No default token stop.");
  });

  it("accumulates across Turns and stops the Job when the budget is gone", async () => {
    const h = await coworkerHarness({ bounds: { tokenBudgetPerJob: 1_000 } });
    h.engine.script = () => [
      { type: "turn-completed", usage: usage(400, 200) },
      { type: "turn-started" },
      { type: "turn-completed", usage: usage(400, 200) },
      { type: "turn-started" },
      { type: "message", text: "Never reached." },
    ];

    await h.mention();

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    const report = reportIn(h, DEFAULT_THREAD_TS);
    expect(report).toContain("Stopped");
    expect(report).toContain("1,200 tokens");
    expect(report).toContain("budget of 1,000");
    expect(report).not.toContain("Never reached.");
  });

  it("keeps the answer a single overrunning Turn produced, and still says it stopped", async () => {
    const h = await coworkerHarness({ bounds: { tokenBudgetPerJob: 1_000 } });
    h.engine.script = () => [
      { type: "message", text: "The staging config is stale." },
      { type: "turn-completed", usage: usage(900, 300) },
    ];

    await h.mention();

    const report = reportIn(h, DEFAULT_THREAD_TS);
    // Both halves are true and both are needed: there is a usable answer here, and
    // there will be no more work on this Job.
    expect(report).toContain("The staging config is stale.");
    expect(report).toContain("token budget");
  });

  it("lets a Job inside its budget finish without comment", async () => {
    const h = await coworkerHarness({ bounds: { tokenBudgetPerJob: 1_000 } });
    h.engine.script = () => [
      { type: "message", text: "Cheap enough." },
      { type: "turn-completed", usage: usage(100, 50) },
    ];

    await h.mention();

    expect(reportIn(h, DEFAULT_THREAD_TS)).toBe("Cheap enough.");
  });
});

describe("a bound message cannot be read as a result", () => {
  it("is a message of its own and settles the status to stopped", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 10_000 } });
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    await h.clock.advance(11_000);
    if (delivery.accepted) await delivery.completed;

    // The status message says stopped where a finished Job says done…
    expect(h.slack.currentTextOf(h.slack.tsOf(0))).toContain("Stopped");
    expect(h.slack.currentTextOf(h.slack.tsOf(0))).not.toContain("Done");
    // …and the report is its own message, opening with the word rather than burying it.
    expect(reportIn(h, DEFAULT_THREAD_TS)).toMatch(/^\*Stopped —/);
  });
});

describe("stopping a Job from the Thread", () => {
  it("kills the engine and reports where it had got to", async () => {
    const h = await coworkerHarness();
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    await h.mention({ text: `<@${BOT_USER_ID}> stop`, user: "U_IMPATIENT" });
    if (delivery.accepted) await delivery.completed;

    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    const texts = h.slack.textsIn(DEFAULT_THREAD_TS);
    expect(texts.some((text) => text.includes("Stopping now"))).toBe(true);
    expect(texts.some((text) => text.includes("U_IMPATIENT") && text.includes("Stopped"))).toBe(
      true,
    );
  });

  it.each(["stop", "Stop.", "cancel", "ABORT"])(
    "recognises %s on its own as a stop and not as a task",
    async (said) => {
      const h = await coworkerHarness();
      h.engine.script = neverFinishes;

      const delivery = await h.startMention();
      await h.engine.started();
      await h.mention({ text: `<@${BOT_USER_ID}> ${said}` });
      if (delivery.accepted) await delivery.completed;

      // One Turn ran: the stop was never handed to the engine as work.
      expect(h.engine.ranTurns).toHaveLength(1);
      expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    },
  );

  it("treats a correction that begins with stop as work, not as a hard-stop", async () => {
    const h = await coworkerHarness();
    const running = deferred();
    h.engine.script = async () => {
      await running.promise;
      return [{ type: "message", text: "Finished after all." }];
    };

    const delivery = await h.startMention();
    await h.engine.started();
    const correction = await h.startMention({
      text: `<@${BOT_USER_ID}> stop, wrong repo — use the other one`,
    });

    // Killing an hour of work over the first word of a sentence is the expensive
    // mistake. A correction is a correction; hard-stop is one word and nothing else.
    expect(h.engine.ranTurns[0]?.aborted).toBe(false);
    // It queues instead, like any other mention arriving mid-Job. That is the accepted
    // cost of never running two Jobs in one Session — and the receipt says as much.
    expect(h.engine.ranTurns).toHaveLength(1);

    running.resolve();
    if (delivery.accepted) await delivery.completed;
    if (correction.accepted) await correction.completed;
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("Finished after all.");
    expect(h.engine.promptFor(1)).toContain("wrong repo");
  });

  it("says so when there is nothing to stop", async () => {
    const h = await coworkerHarness();

    await h.mention({ text: `<@${BOT_USER_ID}> stop` });

    expect(h.engine.ranTurns).toHaveLength(0);
    expect(reportIn(h, DEFAULT_THREAD_TS)).toContain("nothing to stop");
  });
});

describe("a Job that dies says what it left behind", () => {
  it("reports what it finished, what it did not, and that its side effects stand", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      {
        type: "plan",
        steps: [
          { text: "Read the incident thread", completed: true },
          { text: "Reproduce the failure", completed: true },
          { text: "Open a pull request", completed: false },
        ],
      },
      { type: "turn-failed", message: "stream disconnected before completion" },
    ];

    await h.mention();

    const report = reportIn(h, DEFAULT_THREAD_TS);
    expect(report).toContain("stream disconnected before completion");
    expect(report).toContain("What I finished");
    expect(report).toContain("Read the incident thread");
    expect(report).toContain("What I did not");
    expect(report).toContain("Open a pull request");
    expect(report).toMatch(/may have landed only partway|worth a look/);
  });

  it("logs a Vault change without counting it as an external Write", async () => {
    const h = await coworkerHarness();
    // A Note written before the engine gave up. It is on disk, so it is recorded — the
    // Vault's own contents are what the record is made from, which is what makes this
    // true of a Job that died as well as one that finished.
    h.engine.script = async () => {
      await writeFile(path.join(h.notesDir, "deploys.md"), "Ship on green.\n", "utf8");
      return [{ type: "turn-failed", message: "the engine gave up" }];
    };

    await h.mention();

    const texts = h.slack.textsIn(DEFAULT_THREAD_TS);
    expect(texts.some((text) => text.includes("deploys.md"))).toBe(false);
    expect(await readFile(h.vaultChangeLogPath, "utf8")).toContain("deploys.md");
    expect(texts.at(-1)).not.toContain("action recorded above");
  });

  it("does not claim an all-clear when it recorded nothing", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [{ type: "turn-failed", message: "the engine gave up" }];

    await h.mention();

    // The audit trail sees file changes and tool calls exactly and shell commands only
    // by pattern, so "nothing recorded" is a weaker claim than "nothing happened".
    expect(reportIn(h, DEFAULT_THREAD_TS)).toContain("shell command");
  });
});

describe("the Session outlives the Job that died in it", () => {
  it("resumes the same Session on the next mention after a bound stopped one", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 10_000 } });
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    await h.clock.advance(11_000);
    if (delivery.accepted) await delivery.completed;
    const session = h.engine.sessionFor(0);

    h.engine.script = () => [{ type: "message", text: "Picking that back up." }];
    await h.mention();

    expect(h.engine.resumedSessions.map((resumed) => resumed.sessionId)).toEqual([session]);
  });

  it("tells the next Job that the previous Turn may have half-happened", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 10_000 } });
    h.engine.script = neverFinishes;

    const delivery = await h.startMention();
    await h.engine.started();
    await h.clock.advance(11_000);
    if (delivery.accepted) await delivery.completed;

    h.engine.script = () => [{ type: "message", text: "Checked; the branch was there." }];
    await h.mention();

    const prompt = h.engine.promptFor(1);
    expect(prompt).toContain("interrupted");
    expect(prompt).toMatch(/already.*pushed|already.*filed/);
    expect(prompt).toContain("check whether it has already happened");
  });

  it("says nothing of the sort when the previous Turn completed", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [{ type: "message", text: "Done." }];

    await h.mention();
    await h.mention();

    expect(h.engine.promptFor(1)).not.toContain("interrupted");
  });

  it("remembers the interruption across a restart of the instance", async () => {
    const first = await coworkerHarness();
    first.engine.script = () => {
      throw new Error("the process died mid-Turn");
    };
    await first.mention();

    const restarted = await first.restart();
    restarted.engine.script = () => [{ type: "message", text: "Checked before repeating." }];
    await restarted.mention();

    // The warning is a fact about the Thread, not about this process — and the process
    // dying is the case that most needs it.
    expect(restarted.engine.promptFor(0)).toContain("interrupted");
  });

  it("warns only once, not on every mention thereafter", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [{ type: "turn-failed", message: "the engine gave up" }];
    await h.mention();

    h.engine.script = () => [{ type: "message", text: "All checked." }];
    await h.mention();
    await h.mention();

    expect(h.engine.promptFor(1)).toContain("interrupted");
    expect(h.engine.promptFor(2)).not.toContain("interrupted");
  });
});
