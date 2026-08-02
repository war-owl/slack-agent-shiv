import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openScheduleStore } from "../src/schedules/store.ts";
import { testTempDir } from "./support/test-root.ts";

const DAILY = { kind: "daily", time: { hour: 9, minute: 0 } } as const;

describe("Schedule store", () => {
  it("persists a Schedule and claims one due Occurrence exactly once", async () => {
    const file = path.join(await testTempDir("schedules-"), "schedules.json");
    const store = await openScheduleStore(file);
    const created = await store.create({ creatorUserId: "U1", task: "Digest", destination: { channelId: "C1", channelName: "engineering" }, timezone: "UTC", rule: DAILY }, Date.parse("2026-08-01T10:00:00Z"));
    expect(created.id).toBe("S-1");
    expect(created.nextDueAt).toBe("2026-08-02T09:00:00.000Z");

    const reopened = await openScheduleStore(file);
    expect((await reopened.list())[0]?.task).toBe("Digest");
    expect((await reopened.claimDue(Date.parse("2026-08-02T09:00:00Z"))).claimed).toHaveLength(1);
    expect((await reopened.claimDue(Date.parse("2026-08-02T09:00:00Z"))).claimed).toHaveLength(0);
  });

  it("skips downtime and advances strictly into the future", async () => {
    const file = path.join(await testTempDir("schedules-"), "schedules.json");
    const store = await openScheduleStore(file);
    const schedule = await store.create({ creatorUserId: "U1", task: "Digest", destination: { channelId: "C1", channelName: "engineering" }, timezone: "UTC", rule: DAILY }, Date.parse("2026-08-01T10:00:00Z"));
    expect(await store.reconcile(Date.parse("2026-08-04T12:00:00Z"))).toMatchObject({ missed: 1 });
    expect((await store.get(schedule.id))?.nextDueAt).toBe("2026-08-05T09:00:00.000Z");
    expect((await store.occurrencesFor(schedule.id))[0]).toMatchObject({ outcome: "skipped", skipReason: "offline" });
  });

  it("marks a running Occurrence interrupted on restart", async () => {
    const file = path.join(await testTempDir("schedules-"), "schedules.json");
    const store = await openScheduleStore(file);
    const schedule = await store.create({ creatorUserId: "U1", task: "Digest", destination: { channelId: "C1", channelName: "engineering" }, timezone: "UTC", rule: DAILY }, Date.parse("2026-08-01T10:00:00Z"));
    await store.claimDue(Date.parse("2026-08-02T09:00:00Z"));
    const result = await (await openScheduleStore(file)).reconcile(Date.parse("2026-08-02T10:00:00Z"));
    expect(result.interrupted).toHaveLength(1);
    expect((await store.occurrencesFor(schedule.id))[0]?.outcome).toBe("running");
    expect((await (await openScheduleStore(file)).occurrencesFor(schedule.id))[0]?.outcome).toBe("failed");
  });

  it("refuses an unknown store version without modifying it", async () => {
    const file = path.join(await testTempDir("schedules-"), "schedules.json");
    const original = '{"version":99}\n';
    await writeFile(file, original);
    await expect(openScheduleStore(file)).rejects.toThrow("Schedule store");
    expect(await readFile(file, "utf8")).toBe(original);
  });
});
