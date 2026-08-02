import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nextDueAt } from "./calendar.ts";
import {
  timingRuleSchema,
  type CreateSchedule,
  type Occurrence,
  type OccurrenceOutcome,
  type Schedule,
} from "./types.ts";

const scheduleSchema = z.object({
  id: z.string(),
  creatorUserId: z.string(),
  task: z.string(),
  destination: z.object({ channelId: z.string(), channelName: z.string() }),
  timezone: z.string(),
  rule: timingRuleSchema,
  state: z.enum(["active", "paused", "deleted"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextDueAt: z.string().nullable(),
});

const occurrenceSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  dueAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  outcome: z.enum(["running", "succeeded", "failed", "timed-out", "skipped"]),
  skipReason: z.enum(["offline", "overlap"]).optional(),
  failureReason: z.string().optional(),
  threadTs: z.string().optional(),
  manual: z.boolean(),
});

const fileSchema = z.object({
  version: z.literal(1),
  nextScheduleId: z.number().int().positive(),
  schedules: z.array(scheduleSchema),
  occurrences: z.array(occurrenceSchema),
});

type StoreFile = z.infer<typeof fileSchema>;

export interface ClaimedOccurrence {
  schedule: Schedule;
  occurrence: Occurrence;
  previousSuccessAt: string | null;
}

export interface ScheduleStore {
  list(): Promise<readonly Schedule[]>;
  get(id: string): Promise<Schedule | undefined>;
  create(input: CreateSchedule, nowMs: number): Promise<Schedule>;
  update(id: string, patch: Partial<Pick<Schedule, "task" | "destination" | "timezone" | "rule">>, nowMs: number): Promise<Schedule>;
  pause(id: string, nowMs: number): Promise<Schedule>;
  resume(id: string, nowMs: number): Promise<Schedule>;
  delete(id: string, nowMs: number): Promise<Schedule>;
  claimDue(nowMs: number): Promise<{ claimed: readonly ClaimedOccurrence[]; overlaps: readonly { schedule: Schedule; occurrence: Occurrence }[] }>;
  runNow(id: string, nowMs: number): Promise<ClaimedOccurrence | { overlap: true; schedule: Schedule; occurrence: Occurrence }>;
  finish(occurrenceId: string, outcome: Exclude<OccurrenceOutcome, "running" | "skipped">, nowMs: number, details?: { failureReason?: string; threadTs?: string }): Promise<void>;
  skipOverlap(scheduleId: string, dueAt: string, nowMs: number, manual?: boolean): Promise<Occurrence>;
  reconcile(nowMs: number): Promise<{ missed: number; interrupted: readonly ClaimedOccurrence[] }>;
  nextDue(): Promise<number | null>;
  occurrencesFor(scheduleId: string): Promise<readonly Occurrence[]>;
}

export function scheduleStoreFile(stateDir: string): string {
  return path.join(stateDir, "schedules.json");
}

export async function openScheduleStore(filePath: string): Promise<ScheduleStore> {
  let state = await readStore(filePath);
  let lastWrite: Promise<void> = Promise.resolve();

  const commit = async <T>(change: (draft: StoreFile) => T): Promise<T> => {
    let result!: T;
    lastWrite = lastWrite.catch(() => {}).then(async () => {
      const draft = structuredClone(state);
      result = change(draft);
      trimOccurrences(draft);
      await writeStore(filePath, draft);
      state = draft;
    });
    await lastWrite;
    return result;
  };

  const previousSuccess = (file: StoreFile, scheduleId: string): string | null =>
    file.occurrences
      .filter((item) => item.scheduleId === scheduleId && item.outcome === "succeeded")
      .sort((a, b) => b.dueAt.localeCompare(a.dueAt))[0]?.dueAt ?? null;

  const claim = (file: StoreFile, schedule: Schedule, dueAt: string, nowMs: number, manual: boolean): ClaimedOccurrence => {
    const occurrence: Occurrence = {
      id: randomUUID(),
      scheduleId: schedule.id,
      dueAt,
      startedAt: new Date(nowMs).toISOString(),
      finishedAt: null,
      outcome: "running",
      manual,
    };
    file.occurrences.push(occurrence);
    return { schedule: structuredClone(schedule), occurrence: structuredClone(occurrence), previousSuccessAt: previousSuccess(file, schedule.id) };
  };

  return {
    async list() {
      await lastWrite.catch(() => {});
      return structuredClone(state.schedules.filter((schedule) => schedule.state !== "deleted"));
    },
    async get(id) {
      await lastWrite.catch(() => {});
      const found = state.schedules.find((schedule) => schedule.id === id && schedule.state !== "deleted");
      return found && structuredClone(found);
    },
    create(input, nowMs) {
      return commit((draft) => {
        const now = new Date(nowMs).toISOString();
        const due = nextDueAt(input.rule, input.timezone, nowMs);
        if (due === null) throw new Error("The Schedule has no future Occurrence");
        const schedule: Schedule = {
          id: `S-${draft.nextScheduleId++}`,
          ...structuredClone(input),
          state: "active",
          createdAt: now,
          updatedAt: now,
          nextDueAt: new Date(due).toISOString(),
        };
        draft.schedules.push(schedule);
        return structuredClone(schedule);
      });
    },
    update(id, patch, nowMs) {
      return commit((draft) => {
        const schedule = requiredSchedule(draft, id);
        Object.assign(schedule, structuredClone(patch), { updatedAt: new Date(nowMs).toISOString() });
        if (schedule.state === "active") {
          const due = nextDueAt(schedule.rule, schedule.timezone, nowMs);
          if (due === null) throw new Error("The updated Schedule has no future Occurrence");
          schedule.nextDueAt = new Date(due).toISOString();
        }
        return structuredClone(schedule);
      });
    },
    pause(id, nowMs) {
      return commit((draft) => {
        const schedule = requiredSchedule(draft, id);
        schedule.state = "paused";
        schedule.nextDueAt = null;
        schedule.updatedAt = new Date(nowMs).toISOString();
        return structuredClone(schedule);
      });
    },
    resume(id, nowMs) {
      return commit((draft) => {
        const schedule = requiredSchedule(draft, id);
        const due = nextDueAt(schedule.rule, schedule.timezone, nowMs);
        if (due === null) throw new Error("The Schedule has no future Occurrence");
        schedule.state = "active";
        schedule.nextDueAt = new Date(due).toISOString();
        schedule.updatedAt = new Date(nowMs).toISOString();
        return structuredClone(schedule);
      });
    },
    delete(id, nowMs) {
      return commit((draft) => {
        const schedule = requiredSchedule(draft, id);
        schedule.state = "deleted";
        schedule.nextDueAt = null;
        schedule.updatedAt = new Date(nowMs).toISOString();
        return structuredClone(schedule);
      });
    },
    claimDue(nowMs) {
      return commit((draft) => {
        const claimed: ClaimedOccurrence[] = [];
        const overlaps: { schedule: Schedule; occurrence: Occurrence }[] = [];
        for (const schedule of draft.schedules) {
          if (schedule.state !== "active" || schedule.nextDueAt === null) continue;
          const dueMs = Date.parse(schedule.nextDueAt);
          if (dueMs > nowMs) continue;
          const dueAt = schedule.nextDueAt;
          const next = nextDueAt(schedule.rule, schedule.timezone, Math.max(dueMs, nowMs));
          schedule.nextDueAt = next === null ? null : new Date(next).toISOString();
          schedule.updatedAt = new Date(nowMs).toISOString();
          if (hasRunning(draft, schedule.id)) {
            const occurrence = skippedOccurrence(schedule.id, dueAt, nowMs, "overlap", false);
            draft.occurrences.push(occurrence);
            overlaps.push({ schedule: structuredClone(schedule), occurrence: structuredClone(occurrence) });
            continue;
          }
          if (draft.occurrences.some((item) => item.scheduleId === schedule.id && item.dueAt === dueAt)) continue;
          claimed.push(claim(draft, schedule, dueAt, nowMs, false));
        }
        return { claimed, overlaps };
      });
    },
    runNow(id, nowMs) {
      return commit((draft) => {
        const schedule = requiredSchedule(draft, id);
        const dueAt = new Date(nowMs).toISOString();
        if (hasRunning(draft, id)) {
          const occurrence = skippedOccurrence(id, dueAt, nowMs, "overlap", true);
          draft.occurrences.push(occurrence);
          return { overlap: true as const, schedule: structuredClone(schedule), occurrence };
        }
        return claim(draft, schedule, dueAt, nowMs, true);
      });
    },
    finish(occurrenceId, outcome, nowMs, details = {}) {
      return commit((draft) => {
        const occurrence = draft.occurrences.find((item) => item.id === occurrenceId);
        if (!occurrence) throw new Error(`Unknown Occurrence ${occurrenceId}`);
        occurrence.outcome = outcome;
        occurrence.finishedAt = new Date(nowMs).toISOString();
        occurrence.failureReason = details.failureReason;
        occurrence.threadTs = details.threadTs ?? occurrence.threadTs;
      });
    },
    skipOverlap(scheduleId, dueAt, nowMs, manual = false) {
      return commit((draft) => {
        const occurrence = skippedOccurrence(scheduleId, dueAt, nowMs, "overlap", manual);
        draft.occurrences.push(occurrence);
        return structuredClone(occurrence);
      });
    },
    reconcile(nowMs) {
      return commit((draft) => {
        const interrupted: ClaimedOccurrence[] = [];
        for (const occurrence of draft.occurrences) {
          if (occurrence.outcome !== "running") continue;
          occurrence.outcome = "failed";
          occurrence.finishedAt = new Date(nowMs).toISOString();
          occurrence.failureReason = "The open-agent process stopped while this Job was running.";
          const schedule = draft.schedules.find((item) => item.id === occurrence.scheduleId);
          if (schedule) interrupted.push({ schedule: structuredClone(schedule), occurrence: structuredClone(occurrence), previousSuccessAt: previousSuccess(draft, schedule.id) });
        }
        let missed = 0;
        for (const schedule of draft.schedules) {
          if (schedule.state !== "active" || schedule.nextDueAt === null) continue;
          const due = Date.parse(schedule.nextDueAt);
          if (due >= nowMs) continue;
          draft.occurrences.push(skippedOccurrence(schedule.id, schedule.nextDueAt, nowMs, "offline", false));
          missed++;
          const next = nextDueAt(schedule.rule, schedule.timezone, nowMs);
          schedule.nextDueAt = next === null ? null : new Date(next).toISOString();
        }
        return { missed, interrupted };
      });
    },
    async nextDue() {
      await lastWrite.catch(() => {});
      const values = state.schedules.flatMap((schedule) => schedule.state === "active" && schedule.nextDueAt ? [Date.parse(schedule.nextDueAt)] : []);
      return values.length === 0 ? null : Math.min(...values);
    },
    async occurrencesFor(scheduleId) {
      await lastWrite.catch(() => {});
      return structuredClone(state.occurrences.filter((item) => item.scheduleId === scheduleId));
    },
  };
}

function requiredSchedule(file: StoreFile, id: string): Schedule {
  const schedule = file.schedules.find((item) => item.id === id && item.state !== "deleted");
  if (!schedule) throw new Error(`Unknown Schedule ${id}`);
  return schedule;
}

function hasRunning(file: StoreFile, scheduleId: string): boolean {
  return file.occurrences.some((item) => item.scheduleId === scheduleId && item.outcome === "running");
}

function skippedOccurrence(scheduleId: string, dueAt: string, nowMs: number, reason: "offline" | "overlap", manual: boolean): Occurrence {
  return { id: randomUUID(), scheduleId, dueAt, startedAt: null, finishedAt: new Date(nowMs).toISOString(), outcome: "skipped", skipReason: reason, manual };
}

function trimOccurrences(file: StoreFile): void {
  const keep = new Set<string>();
  for (const schedule of file.schedules) {
    file.occurrences
      .filter((item) => item.scheduleId === schedule.id)
      .sort((a, b) => b.dueAt.localeCompare(a.dueAt))
      .slice(0, 100)
      .forEach((item) => keep.add(item.id));
  }
  file.occurrences = file.occurrences.filter((item) => keep.has(item.id));
}

async function readStore(filePath: string): Promise<StoreFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextScheduleId: 1, schedules: [], occurrences: [] };
    throw error;
  }
  try {
    return fileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`The Schedule store at ${filePath} could not be read, so the instance is stopping without touching it: ${String(error)}`);
  }
}

async function writeStore(filePath: string, file: StoreFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.writing`;
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
