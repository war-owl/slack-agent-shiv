import { describe, expect, it } from "vitest";
import { nextDueAt } from "../src/schedules/calendar.ts";

describe("schedule calendar", () => {
  it("finds a daily time in the stored timezone", () => {
    const after = Date.parse("2026-08-02T00:00:00Z");
    expect(nextDueAt({ kind: "daily", time: { hour: 9, minute: 0 } }, "Asia/Kolkata", after))
      .toBe(Date.parse("2026-08-02T03:30:00Z"));
  });

  it("moves a passed daily time to the next local day", () => {
    const after = Date.parse("2026-08-02T04:00:00Z");
    expect(nextDueAt({ kind: "daily", time: { hour: 9, minute: 0 } }, "Asia/Kolkata", after))
      .toBe(Date.parse("2026-08-03T03:30:00Z"));
  });

  it("supports selected weekdays", () => {
    const after = Date.parse("2026-08-07T20:00:00Z"); // Saturday in Kolkata
    expect(nextDueAt({ kind: "weekly", weekdays: [1, 3], time: { hour: 9, minute: 0 } }, "Asia/Kolkata", after))
      .toBe(Date.parse("2026-08-10T03:30:00Z"));
  });

  it("skips a nonexistent DST wall time", () => {
    const after = Date.parse("2026-03-08T05:00:00Z");
    expect(nextDueAt({ kind: "daily", time: { hour: 2, minute: 30 } }, "America/New_York", after))
      .toBe(Date.parse("2026-03-09T06:30:00Z"));
  });

  it("dispatches a repeated DST wall time only once", () => {
    const before = Date.parse("2026-11-01T04:00:00Z");
    const first = nextDueAt({ kind: "daily", time: { hour: 1, minute: 30 } }, "America/New_York", before);
    expect(first).toBe(Date.parse("2026-11-01T05:30:00Z"));
    const next = nextDueAt({ kind: "daily", time: { hour: 1, minute: 30 } }, "America/New_York", first!);
    expect(next).toBe(Date.parse("2026-11-02T06:30:00Z"));
  });

  it("does not return a past one-time instant", () => {
    expect(nextDueAt({ kind: "once", at: "2026-08-01T10:00:00Z" }, "UTC", Date.parse("2026-08-02T00:00:00Z"))).toBeNull();
  });
});
