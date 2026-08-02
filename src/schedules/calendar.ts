import { TZDate } from "@date-fns/tz";
import { addDays } from "date-fns";
import type { TimingRule } from "./types.ts";

/** Is this a real IANA timezone accepted by the host's ICU data? */
export function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The first valid due instant strictly after `afterMs`.
 *
 * Calendar arithmetic happens in the Schedule's timezone. A local time which does not
 * exist during a DST jump is skipped rather than silently moved by the date library.
 */
export function nextDueAt(rule: TimingRule, timezone: string, afterMs: number): number | null {
  if (!isTimezone(timezone)) throw new Error(`Unknown timezone ${timezone}`);
  if (rule.kind === "once") {
    const at = Date.parse(rule.at);
    if (!Number.isFinite(at)) throw new Error("The one-time instant is invalid");
    return at > afterMs ? at : null;
  }

  let day = new TZDate(afterMs, timezone);
  // 370 days covers the sparsest supported recurrence plus leap-year edges.
  for (let searched = 0; searched < 370; searched++, day = addDays(day, 1)) {
    const year = day.getFullYear();
    const month = day.getMonth();
    const date = day.getDate();
    if (!matches(rule, day)) continue;

    const candidate = localInstant(year, month, date, rule.time.hour, rule.time.minute, timezone);
    if (candidate !== null && candidate > afterMs) return candidate;
  }
  return null;
}

function matches(rule: Exclude<TimingRule, { kind: "once" }>, day: TZDate): boolean {
  switch (rule.kind) {
    case "daily":
      return true;
    case "weekly":
      return new Set(rule.weekdays).has(day.getDay());
    case "monthly":
      return day.getDate() === rule.day;
    case "yearly":
      return day.getMonth() + 1 === rule.month && day.getDate() === rule.day;
  }
}

function localInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  const candidate = new TZDate(year, month, day, hour, minute, 0, 0, timezone);
  // TZDate normalises nonexistent wall times forward. Reject that normalization: the
  // product rule says a DST-gap Occurrence is skipped.
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month ||
    candidate.getDate() !== day ||
    candidate.getHours() !== hour ||
    candidate.getMinutes() !== minute
  ) {
    return null;
  }
  return candidate.getTime();
}

export function describeRule(rule: TimingRule): string {
  if (rule.kind === "once") return `Once at ${rule.at}`;
  const time = `${String(rule.time.hour).padStart(2, "0")}:${String(rule.time.minute).padStart(2, "0")}`;
  switch (rule.kind) {
    case "daily":
      return `Every day at ${time}`;
    case "weekly": {
      const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `Every ${rule.weekdays.map((day) => names[day]).join(", ")} at ${time}`;
    }
    case "monthly":
      return `Every month on day ${rule.day} at ${time}`;
    case "yearly":
      return `Every year on ${rule.month}/${rule.day} at ${time}`;
  }
}
