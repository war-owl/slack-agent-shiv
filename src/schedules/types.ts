import { z } from "zod";

const localTimeSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export const timingRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().datetime({ offset: true }) }),
  z.object({ kind: z.literal("daily"), time: localTimeSchema }),
  z.object({
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: localTimeSchema,
  }),
  z.object({
    kind: z.literal("monthly"),
    day: z.number().int().min(1).max(31),
    time: localTimeSchema,
  }),
  z.object({
    kind: z.literal("yearly"),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    time: localTimeSchema,
  }),
]);

export type TimingRule = z.infer<typeof timingRuleSchema>;
export type ScheduleState = "active" | "paused" | "deleted";
export type OccurrenceOutcome = "running" | "succeeded" | "failed" | "timed-out" | "skipped";

export interface Schedule {
  id: string;
  creatorUserId: string;
  task: string;
  destination: { channelId: string; channelName: string };
  timezone: string;
  rule: TimingRule;
  state: ScheduleState;
  createdAt: string;
  updatedAt: string;
  nextDueAt: string | null;
}

export interface Occurrence {
  id: string;
  scheduleId: string;
  dueAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: OccurrenceOutcome;
  skipReason?: "offline" | "overlap" | undefined;
  failureReason?: string | undefined;
  threadTs?: string | undefined;
  manual: boolean;
}

export interface CreateSchedule {
  creatorUserId: string;
  task: string;
  destination: Schedule["destination"];
  timezone: string;
  rule: TimingRule;
}

