import { describe, expect, it, vi } from "vitest";
import { createScheduleControl } from "../src/schedules/control.ts";
import { createScheduler } from "../src/schedules/scheduler.ts";
import { openScheduleStore } from "../src/schedules/store.ts";
import { coworkerHarness } from "./support/harness.ts";

describe("scheduler", () => {
  it("re-arms when the first Schedule is created after startup", async () => {
    const h = await coworkerHarness();
    h.slack.channels.set("engineering", { id: "C_ENGINEERING", name: "engineering" });
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const scheduler = createScheduler({ store, coworker: h.coworker, slack: h.slack, clock: h.clock, log: { info: (message) => h.logs.push(message), warn: (message) => h.warnings.push(message) } });
    const control = createScheduleControl({
      store,
      slack: h.slack,
      clock: h.clock,
      dispatch: (claimed) => scheduler.dispatch(claimed),
      scheduleChanged: () => scheduler.wake(),
    });
    await scheduler.start();

    await control.create({
      actorUserId: "U_ASKER",
      task: "Give the update",
      channel: "C_ENGINEERING",
      timezone: "UTC",
      rule: { kind: "once", at: new Date(h.clock.now() + 1_000).toISOString() },
    });
    await h.clock.advance(1_000);
    await vi.waitFor(async () => {
      expect((await store.occurrencesFor("S-1"))[0]?.outcome).toBe("succeeded");
    });
  });

  it("turns a due Occurrence into an ordinary threaded Job", async () => {
    const h = await coworkerHarness();
    h.slack.channels.set("engineering", { id: "C_ENGINEERING", name: "engineering" });
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const now = h.clock.now();
    const schedule = await store.create({
      creatorUserId: "U_ASKER",
      task: "Summarize the repository",
      destination: { channelId: "C_ENGINEERING", channelName: "engineering" },
      timezone: "UTC",
      rule: { kind: "once", at: new Date(now + 1_000).toISOString() },
    }, now);
    const scheduler = createScheduler({ store, coworker: h.coworker, slack: h.slack, clock: h.clock, log: { info: (message) => h.logs.push(message), warn: (message) => h.warnings.push(message) } });
    const batch = await store.claimDue(now + 1_000);
    await scheduler.dispatch(batch.claimed[0]!);

    expect(h.slack.topLevelPosts[0]).toMatchObject({ channel: "C_ENGINEERING" });
    expect(h.engine.ranTurns[0]?.prompt).toContain("Summarize the repository");
    expect(h.engine.ranTurns[0]?.prompt).toContain(`Schedule: ${schedule.id}`);
    expect((await store.occurrencesFor(schedule.id))[0]?.outcome).toBe("succeeded");
  });
});
