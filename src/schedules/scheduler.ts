import type { Coworker, JobCompletion } from "../coworker.ts";
import type { Logger } from "../ports/log.ts";
import type { Clock, Stoppable } from "../ports/clock.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { ClaimedOccurrence, ScheduleStore } from "./store.ts";
import type { Occurrence, Schedule } from "./types.ts";

export interface Scheduler {
  start(): Promise<void>;
  wake(): Promise<void>;
  stop(): void;
  dispatch(claimed: ClaimedOccurrence): Promise<void>;
}

export function createScheduler(deps: {
  store: ScheduleStore;
  coworker: Coworker;
  slack: SlackClient;
  clock: Clock;
  log: Logger;
}): Scheduler {
  let timer: Stoppable | undefined;
  let waking: Promise<void> | undefined;
  let stopped = false;

  const arm = async (): Promise<void> => {
    timer?.stop();
    timer = undefined;
    if (stopped) return;
    const due = await deps.store.nextDue();
    if (due === null) return;
    // Node timers cannot safely represent every distant date. A daily recheck also
    // makes wall-clock changes harmless because every wake recomputes from durable state.
    const delay = Math.max(0, Math.min(due - deps.clock.now(), 24 * 60 * 60 * 1000));
    timer = deps.clock.after(delay, () => scheduler.wake());
  };

  const dispatch = async (claimed: ClaimedOccurrence): Promise<void> => {
    const { schedule, occurrence } = claimed;
    let rootTs: string;
    try {
      const root = await deps.slack.postTopLevelMessage({
        channel: schedule.destination.channelId,
        text: occurrenceAnnouncement(schedule, occurrence),
      });
      rootTs = root.ts;
    } catch (error) {
      await deps.store.finish(occurrence.id, "failed", deps.clock.now(), { failureReason: `Could not announce the Occurrence in Slack: ${String(error)}` });
      deps.log.warn(`Schedule ${schedule.id} Occurrence ${occurrence.id} could not start: ${String(error)}`);
      return;
    }

    try {
      const job = await deps.coworker.handleScheduled({
        occurrenceId: occurrence.id,
        scheduleId: schedule.id,
        thread: { channel: schedule.destination.channelId, ts: rootTs },
        creatorUserId: schedule.creatorUserId,
        task: schedule.task,
        dueAt: occurrence.dueAt,
        startedAt: occurrence.startedAt ?? new Date(deps.clock.now()).toISOString(),
        timezone: schedule.timezone,
        previousSuccessAt: claimed.previousSuccessAt,
      });
      const outcome = await job.completed;
      await finish(deps.store, occurrence.id, outcome, deps.clock.now(), rootTs);
    } catch (error) {
      await deps.store.finish(occurrence.id, "failed", deps.clock.now(), { failureReason: String(error), threadTs: rootTs });
    }
  };

  const scheduler: Scheduler = {
    async start() {
      stopped = false;
      const reconciled = await deps.store.reconcile(deps.clock.now());
      if (reconciled.missed > 0) deps.log.info(`Skipped ${reconciled.missed} Schedule Occurrence(s) missed while offline.`);
      for (const interrupted of reconciled.interrupted) {
        await deps.slack.postTopLevelMessage({
          channel: interrupted.schedule.destination.channelId,
          text: `:warning: *${interrupted.schedule.id} was interrupted* — open-agent stopped while its previous Job was running. It was not rerun because some side effects may already have landed.`,
        }).catch((error) => deps.log.warn(`Could not announce interrupted Schedule ${interrupted.schedule.id}: ${String(error)}`));
      }
      await arm();
    },
    async wake() {
      if (waking) return waking;
      waking = (async () => {
        const batch = await deps.store.claimDue(deps.clock.now());
        for (const overlap of batch.overlaps) {
          await deps.slack.postTopLevelMessage({ channel: overlap.schedule.destination.channelId, text: overlapNotice(overlap.schedule, overlap.occurrence) })
            .catch((error) => deps.log.warn(`Could not announce overlap for ${overlap.schedule.id}: ${String(error)}`));
        }
        for (const claimed of batch.claimed) {
          void dispatch(claimed).catch((error) => deps.log.warn(`Schedule ${claimed.schedule.id} dispatch failed: ${String(error)}`));
        }
        await arm();
      })().finally(() => { waking = undefined; });
      return waking;
    },
    stop() {
      stopped = true;
      timer?.stop();
      timer = undefined;
    },
    dispatch,
  };
  return scheduler;
}

async function finish(store: ScheduleStore, occurrenceId: string, outcome: JobCompletion, nowMs: number, threadTs: string): Promise<void> {
  await store.finish(occurrenceId, outcome, nowMs, { threadTs });
}

function occurrenceAnnouncement(schedule: Schedule, occurrence: Occurrence): string {
  return [
    `:clock9: *${schedule.id} is running*`,
    `Task: ${schedule.task}`,
    `Scheduled for: ${occurrence.dueAt} (${schedule.timezone})`,
    `Created by: <@${schedule.creatorUserId}>`,
    "Progress and the final result will appear in this thread.",
  ].join("\n");
}

function overlapNotice(schedule: Schedule, occurrence: Occurrence): string {
  return `:double_vertical_bar: *${schedule.id} skipped ${occurrence.dueAt}* — its previous Job is still running, so open-agent did not start a concurrent copy.`;
}
