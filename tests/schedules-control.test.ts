import { describe, expect, it } from "vitest";
import { createScheduleControl } from "../src/schedules/control.ts";
import { openScheduleStore } from "../src/schedules/store.ts";
import { coworkerHarness } from "./support/harness.ts";

describe("Schedule control", () => {
  it("defaults timezone from Slack and notifies the destination", async () => {
    const h = await coworkerHarness();
    h.slack.userTimezones.set("U_ASKER", "Asia/Kolkata");
    h.slack.channels.set("engineering", { id: "C_ENGINEERING", name: "engineering" });
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const control = createScheduleControl({ store, slack: h.slack, clock: h.clock, dispatch: async () => {} });
    const schedule = await control.create({ actorUserId: "U_ASKER", task: "Daily digest", channel: "#engineering", rule: { kind: "daily", time: { hour: 9, minute: 0 } } });

    expect(schedule.timezone).toBe("Asia/Kolkata");
    expect(schedule.destination.channelId).toBe("C_ENGINEERING");
    expect(h.slack.topLevelPosts).toHaveLength(1);
    expect(h.slack.topLevelPosts[0]?.text).toContain("Daily digest");
  });

  it("creates nothing when destination or timezone cannot be resolved", async () => {
    const h = await coworkerHarness();
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const control = createScheduleControl({ store, slack: h.slack, clock: h.clock, dispatch: async () => {} });
    await expect(control.create({ actorUserId: "U_ASKER", task: "Digest", channel: "#missing", rule: { kind: "daily", time: { hour: 9, minute: 0 } } })).rejects.toThrow("timezone");
    expect(await store.list()).toHaveLength(0);
  });

  it("run now dispatches without moving the calendar occurrence", async () => {
    const h = await coworkerHarness();
    h.slack.channels.set("engineering", { id: "C_ENGINEERING", name: "engineering" });
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const dispatched: string[] = [];
    const control = createScheduleControl({ store, slack: h.slack, clock: h.clock, dispatch: async (claimed) => { dispatched.push(claimed.schedule.id); } });
    const schedule = await control.create({ actorUserId: "U_ASKER", task: "Digest", channel: "#engineering", timezone: "UTC", rule: { kind: "daily", time: { hour: 9, minute: 0 } } });
    const before = schedule.nextDueAt;
    await control.runNow(schedule.id);
    await Promise.resolve();
    expect(dispatched).toEqual([schedule.id]);
    expect((await store.get(schedule.id))?.nextDueAt).toBe(before);
  });

  it("updates, pauses, resumes, and deletes through one durable control surface", async () => {
    const h = await coworkerHarness();
    h.slack.channels.set("engineering", { id: "C_ENGINEERING", name: "engineering" });
    h.slack.channels.set("platform", { id: "C_PLATFORM", name: "platform" });
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const control = createScheduleControl({ store, slack: h.slack, clock: h.clock, dispatch: async () => {} });
    const schedule = await control.create({ actorUserId: "U_ASKER", task: "Digest", channel: "#engineering", timezone: "UTC", rule: { kind: "daily", time: { hour: 9, minute: 0 } } });

    const updated = await control.update({ id: schedule.id, actorUserId: "U_OTHER", task: "Platform digest", channel: "#platform" });
    expect(updated).toMatchObject({ task: "Platform digest", destination: { channelId: "C_PLATFORM" } });
    expect(h.slack.topLevelPosts.slice(-2).map((post) => post.channel)).toEqual(["C_ENGINEERING", "C_PLATFORM"]);
    expect((await control.pause(schedule.id)).state).toBe("paused");
    expect((await control.resume(schedule.id)).state).toBe("active");
    expect((await control.delete(schedule.id)).state).toBe("deleted");
    expect(await control.list()).toHaveLength(0);
  });
});
