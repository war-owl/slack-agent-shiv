import { describe, expect, it } from "vitest";
import { BOUND_DEFAULTS } from "../src/config.ts";
import type { EngineEvent } from "../src/ports/engine.ts";
import type { Delivery } from "../src/slack/mentions.ts";
import { deferred, type Deferred } from "./support/fakes.ts";
import { BOT_USER_ID, coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";

/**
 * One Thread at a time, several Threads at once.
 *
 * A Thread is the unit of topic and the unit of a Session, and two Jobs writing into
 * the same Session at the same time would interleave two conversations into one. So
 * Jobs in a Thread are strictly sequential and a mention arriving mid-Job waits — and
 * the waiting is *said out loud*, because a person who typed something and saw nothing
 * has no way to tell "queued" from "dropped".
 *
 * Two Threads are two audiences and two pieces of work, and neither has any reason to
 * wait for the other. What bounds them is not each other but the instance ceiling.
 */

/** A Turn the test can hold open, so a second mention arrives while it is running. */
function heldTurn(answer = "The answer."): {
  release: Deferred<void>;
  script: () => Promise<EngineEvent[]>;
} {
  const release = deferred();
  return {
    release,
    script: async () => {
      await release.promise;
      return [{ type: "message", text: answer }];
    },
  };
}

/** Wait for a delivery's Job, whether it ran or was dropped before it could. */
async function settled(deliveries: Delivery[]): Promise<void> {
  await Promise.all(deliveries.map((d) => (d.accepted ? d.completed : undefined)));
}

describe("a mention that arrives while a Job is running", () => {
  it("is acknowledged straight away, so silence never reads as it being dropped", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> also check staging` });

    expect(second.accepted).toBe(true);
    // Acknowledged before the first Job has finished, not after.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toHaveLength(2);
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)[1]).toMatch(/got it/i);
    expect(h.engine.turns).toHaveLength(1);

    held.release.resolve();
    await settled([first, second]);
  });

  it("says how to interrupt, because a correction queues rather than interrupting", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> stop, wrong repo` });

    // "stop, wrong repo" is a correction and is queued like any other. The accepted
    // cost of that is only acceptable if the Thread says what to type instead.
    const receipt = h.slack.textsIn(DEFAULT_THREAD_TS)[1] ?? "";
    expect(receipt).toMatch(/\bstop\b/);
    expect(h.engine.ranTurns[0]?.aborted).toBe(false);

    held.release.resolve();
    await settled([first, second]);
  });

  it("runs it in the same Session once the running Turn has finished", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> also check staging` });
    held.release.resolve();
    await settled([first, second]);

    expect(h.engine.turns).toHaveLength(2);
    expect(h.engine.sessionFor(1)).toBe(h.engine.sessionFor(0));
    expect(h.engine.promptFor(1)).toContain("also check staging");
  });

  it("tells the coworker the message was written before it had answered", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> actually, the other repo` });
    held.release.resolve();
    await settled([first, second]);

    // Without this the coworker reads a correction as a new request arriving after a
    // finished answer, which is a different thing and gets a different reply.
    expect(h.engine.promptFor(1)).toContain("while you were still working");
    expect(h.engine.promptFor(0)).not.toContain("while you were still working");
  });

  it("takes over its own acknowledgement rather than posting a second message", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> also check staging` });
    const receiptTs = h.slack.tsOf(1);
    held.release.resolve();
    await settled([first, second]);

    // Progress is one thing per Job, revised: the receipt becomes that Job's status
    // message. Two Jobs in this Thread, so four messages — two status, two answers.
    expect(h.slack.posts).toHaveLength(4);
    expect(h.slack.versionsOf(receiptTs)[0]).toMatch(/got it/i);
    expect(h.slack.currentTextOf(receiptTs)).toMatch(/Done/);
  });
});

describe("Jobs in one Thread", () => {
  it("never run two at a time", async () => {
    const h = await coworkerHarness();
    let inFlight = 0;
    let mostAtOnce = 0;
    const release = deferred();
    h.engine.script = async () => {
      inFlight++;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      await release.promise;
      inFlight--;
      return [{ type: "message", text: "The answer." }];
    };

    const deliveries = [await h.startMention(), await h.startMention(), await h.startMention()];
    await h.engine.started();
    release.resolve();
    await settled(deliveries);

    expect(mostAtOnce).toBe(1);
    expect(h.engine.turns).toHaveLength(3);
  });

  it("run in the order the mentions arrived", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention({ text: `<@${BOT_USER_ID}> one` });
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> two` });
    const third = await h.startMention({ text: `<@${BOT_USER_ID}> three` });
    const fourth = await h.startMention({ text: `<@${BOT_USER_ID}> four` });
    held.release.resolve();
    await settled([first, second, third, fourth]);

    expect(h.engine.turns.map((prompt) => prompt.match(/^(one|two|three|four)$/m)?.[0])).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});

describe("a Thread whose line could have been left blocked", () => {
  it("starts the next Job after one that died rather than finished", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = async ({ prompt }) => {
      if (!prompt.includes("the risky one")) return [{ type: "message", text: "The answer." }];
      await held.release.promise;
      throw new Error("the engine died");
    };

    const first = await h.startMention({ text: `<@${BOT_USER_ID}> the risky one` });
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> the next one` });
    held.release.resolve();
    await settled([first, second]);

    // A Job that throws still has to hand its Thread on, or one crash means the Thread
    // never answers again.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("The answer.");
  });

  it("frees the place of a mention whose acknowledgement Slack refused", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    h.slack.failNextPost = new Error("slack is down");
    await expect(h.startMention({ text: `<@${BOT_USER_ID}> the lost one` })).rejects.toThrow(
      "slack is down",
    );

    const third = await h.startMention({ text: `<@${BOT_USER_ID}> the next one` });
    held.release.resolve();
    await settled([first, third]);

    // The mention that was never acknowledged took no place in the line with it.
    expect(h.engine.turns).toHaveLength(2);
    expect(h.engine.promptFor(1)).toContain("the next one");
  });
});

describe("Jobs in different Threads", () => {
  it("run at the same time rather than waiting for each other", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const mine = await h.startMention({ channel: "C_PLATFORM", thread_ts: "1700000042.000100" });
    const theirs = await h.startMention({ channel: "C_DESIGN", thread_ts: "1700000099.000100" });
    // Both engines are running: the second Thread was not held behind the first.
    await h.engine.started(2);

    // And the second was acknowledged as work starting, not as work waiting.
    expect(h.slack.textsIn("1700000099.000100")[0]).toMatch(/on it/i);

    held.release.resolve();
    await settled([mine, theirs]);
    expect(h.engine.sessionFor(1)).not.toBe(h.engine.sessionFor(0));
  });
});

describe("the ceiling on how many Jobs run at once", () => {
  it("is four by default, and the fifth Thread is told it is waiting", async () => {
    // The shipped number, not one invented here: four is what a self-hoster gets by
    // doing nothing, and it is chosen against Slack's `chat.update` allowance.
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const busy = [];
    for (const n of [1, 2, 3, 4]) {
      busy.push(await h.startMention({ thread_ts: `170000000${n}.000100` }));
    }
    await h.engine.started(BOUND_DEFAULTS.maxConcurrentJobs);
    const fifth = await h.startMention({ thread_ts: "1700000005.000100" });

    expect(h.engine.turns).toHaveLength(BOUND_DEFAULTS.maxConcurrentJobs);
    expect(h.slack.textsIn("1700000004.000100")[0]).toMatch(/on it/i);
    expect(h.slack.textsIn("1700000005.000100")[0]).toMatch(/got it/i);

    held.release.resolve();
    await settled([...busy, fifth]);
    expect(h.engine.turns).toHaveLength(5);
  });

  it("counts a Job from the moment it is promised a slot, not from its first Turn", async () => {
    const h = await coworkerHarness({ bounds: { maxConcurrentJobs: 1 } });
    const held = heldTurn();
    h.engine.script = held.script;

    // Both mentions land before either acknowledgement has been posted, which is the
    // ordinary case for a busy workspace. If the ceiling were read from a snapshot
    // taken before the first Job had claimed its slot, both would be told "on it" and
    // one of them would then sit silent — the exact silence a receipt exists to avoid.
    const [mine, theirs] = await Promise.all([
      h.startMention({ thread_ts: "1700000001.000100" }),
      h.startMention({ thread_ts: "1700000002.000100" }),
    ]);

    expect(h.slack.textsIn("1700000001.000100")[0]).toMatch(/on it/i);
    expect(h.slack.textsIn("1700000002.000100")[0]).toMatch(/got it/i);

    held.release.resolve();
    await settled([mine, theirs]);
  });

  it("holds a Thread's Job until the instance has room, and says so", async () => {
    const h = await coworkerHarness({ bounds: { maxConcurrentJobs: 2 } });
    const held = heldTurn();
    h.engine.script = held.script;

    const one = await h.startMention({ thread_ts: "1700000001.000100" });
    const two = await h.startMention({ thread_ts: "1700000002.000100" });
    await h.engine.started(2);
    const three = await h.startMention({ thread_ts: "1700000003.000100" });

    // Nothing is running in the third Thread, and still it waits — the instance is
    // full. Saying nothing would look like the mention had been dropped.
    expect(h.engine.turns).toHaveLength(2);
    expect(h.slack.textsIn("1700000003.000100")[0]).toMatch(/got it/i);

    held.release.resolve();
    await settled([one, two, three]);
    expect(h.engine.turns).toHaveLength(3);
  });
});

describe("stopping a Thread with mentions queued behind the Job", () => {
  it("drops what was waiting rather than starting the next one", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const running = await h.startMention();
    await h.engine.started();
    const queued = await h.startMention({ text: `<@${BOT_USER_ID}> also check staging` });
    const stop = await h.startMention({ text: `<@${BOT_USER_ID}> stop`, user: "U_ASKER" });
    await settled([running, queued, stop]);

    // A person who says stop and then watches the next queued Job start immediately
    // has every reason to conclude that stopping does not work.
    expect(h.engine.turns).toHaveLength(1);
    expect(h.engine.ranTurns[0]?.aborted).toBe(true);
    // And the Thread says what happened to the message they are no longer getting —
    // both in the reply to the stop, and on the queued message itself, which until now
    // was still promising to pick it up.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS).join("\n")).toMatch(/dropped/i);
    expect(h.slack.currentTextOf(h.slack.tsOf(1))).toMatch(/Dropped/);
  });

  it("reaches a Job in the moment between being promoted and doing anything", async () => {
    const h = await coworkerHarness();
    const held = heldTurn();
    h.engine.script = held.script;

    const first = await h.startMention();
    await h.engine.started();
    const second = await h.startMention({ text: `<@${BOT_USER_ID}> also check staging` });

    // Slack is slow to accept the edit that turns the queued Job's receipt into its
    // status message. That is the whole window: the Job has been handed the Thread, so
    // it is no longer something the queue can drop, and it has not yet done anything.
    const slowEdit = h.slack.holdEditsTo(h.slack.tsOf(1));
    held.release.resolve();
    await slowEdit.attempted;

    await h.mention({ text: `<@${BOT_USER_ID}> stop`, user: "U_ASKER" });
    slowEdit.release();
    await settled([first, second]);

    // Answered "nothing was running", the person would watch the Job they just stopped
    // work on regardless — the worst of both, since they think it has ended.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS).join("\n")).toContain("Stopping now");
    expect(h.engine.ranTurns[1]?.aborted).toBe(true);
  });

  it("says what it dropped even when nothing was running to stop", async () => {
    const h = await coworkerHarness({ bounds: { maxConcurrentJobs: 1 } });
    const held = heldTurn();
    h.engine.script = held.script;

    const elsewhere = await h.startMention({ thread_ts: "1700000001.000100" });
    await h.engine.started();
    const waiting = await h.startMention({ thread_ts: "1700000002.000100" });
    const stop = await h.startMention({
      thread_ts: "1700000002.000100",
      text: `<@${BOT_USER_ID}> stop`,
    });

    const said = h.slack.textsIn("1700000002.000100").join("\n");
    expect(said).toMatch(/dropped/i);

    held.release.resolve();
    await settled([elsewhere, waiting, stop]);
    // The dropped Job never ran, and the Thread it was queued in got no answer.
    expect(h.engine.turns).toHaveLength(1);
  });
});
