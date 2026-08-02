import type { Clock } from "../ports/clock.ts";
import type { SlackClient } from "../ports/slack.ts";
import { describeRule, isTimezone } from "./calendar.ts";
import type { ClaimedOccurrence, ScheduleStore } from "./store.ts";
import type { Schedule, TimingRule } from "./types.ts";

export interface ScheduleControl {
  create(input: { actorUserId: string; task: string; channel: string; timezone?: string; rule: TimingRule }): Promise<Schedule>;
  list(): Promise<readonly Schedule[]>;
  get(id: string): Promise<Schedule>;
  update(input: { id: string; actorUserId: string; task?: string; channel?: string; timezone?: string; rule?: TimingRule }): Promise<Schedule>;
  pause(id: string): Promise<Schedule>;
  resume(id: string): Promise<Schedule>;
  delete(id: string): Promise<Schedule>;
  runNow(id: string): Promise<{ schedule: Schedule; overlap: boolean }>;
}

export function createScheduleControl(deps: {
  store: ScheduleStore;
  slack: SlackClient;
  clock: Clock;
  dispatch: (claimed: ClaimedOccurrence) => Promise<void>;
  /** Recompute the scheduler's timer after a mutation changes the next due instant. */
  scheduleChanged?: (() => Promise<void>) | undefined;
}): ScheduleControl {
  const get = async (id: string): Promise<Schedule> => {
    const found = await deps.store.get(id);
    if (!found) throw new Error(`Unknown Schedule ${id}`);
    return found;
  };
  return {
    async create(input) {
      const timezone = input.timezone ?? (await deps.slack.userTimezone(input.actorUserId));
      if (!timezone) throw new Error("No timezone was specified and Slack has no timezone for this user. Ask which timezone to use.");
      if (!isTimezone(timezone)) throw new Error(`Unknown timezone ${timezone}. Ask for an IANA timezone such as Asia/Kolkata.`);
      const channel = await deps.slack.resolveWritableChannel(input.channel);
      const schedule = await deps.store.create({
        creatorUserId: input.actorUserId,
        task: input.task.trim(),
        destination: { channelId: channel.id, channelName: channel.name },
        timezone,
        rule: input.rule,
      }, deps.clock.now());
      try {
        await deps.slack.postTopLevelMessage({ channel: channel.id, text: creationNotice(schedule) });
      } catch (error) {
        await deps.store.delete(schedule.id, deps.clock.now());
        throw new Error(`Slack could not receive the team notification, so ${schedule.id} was not kept: ${String(error)}`);
      }
      await deps.scheduleChanged?.();
      return schedule;
    },
    list: () => deps.store.list(),
    get,
    async update(input) {
      const old = await get(input.id);
      const destination = input.channel === undefined ? undefined : await deps.slack.resolveWritableChannel(input.channel);
      const timezone = input.timezone;
      if (timezone !== undefined && !isTimezone(timezone)) throw new Error(`Unknown timezone ${timezone}`);
      const updated = await deps.store.update(input.id, {
        ...(input.task === undefined ? {} : { task: input.task.trim() }),
        ...(destination === undefined ? {} : { destination: { channelId: destination.id, channelName: destination.name } }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(input.rule === undefined ? {} : { rule: input.rule }),
      }, deps.clock.now());
      if (destination && destination.id !== old.destination.channelId) {
        const text = `:twisted_rightwards_arrows: *${updated.id} moved* by <@${input.actorUserId}> — future results will be posted in #${destination.name}.`;
        await Promise.all([
          deps.slack.postTopLevelMessage({ channel: old.destination.channelId, text }),
          deps.slack.postTopLevelMessage({ channel: destination.id, text }),
        ]);
      }
      await deps.scheduleChanged?.();
      return updated;
    },
    async pause(id) {
      const schedule = await deps.store.pause(id, deps.clock.now());
      await deps.scheduleChanged?.();
      return schedule;
    },
    async resume(id) {
      const schedule = await deps.store.resume(id, deps.clock.now());
      await deps.scheduleChanged?.();
      return schedule;
    },
    async delete(id) {
      const schedule = await deps.store.delete(id, deps.clock.now());
      await deps.scheduleChanged?.();
      return schedule;
    },
    async runNow(id) {
      const result = await deps.store.runNow(id, deps.clock.now());
      if ("overlap" in result) {
        await deps.slack.postTopLevelMessage({
          channel: result.schedule.destination.channelId,
          text: `:double_vertical_bar: *${result.schedule.id} run-now skipped* — its previous Job is still running.`,
        });
        return { schedule: result.schedule, overlap: true };
      }
      void deps.dispatch(result);
      return { schedule: result.schedule, overlap: false };
    },
  };
}

export function scheduleSummary(schedule: Schedule): string {
  return [
    `${schedule.id} · ${schedule.state}`,
    `${describeRule(schedule.rule)} ${schedule.timezone}`,
    `Task: ${schedule.task}`,
    `Results: <#${schedule.destination.channelId}>`,
    `Next run: ${schedule.nextDueAt ?? "none"}`,
  ].join("\n");
}

function creationNotice(schedule: Schedule): string {
  return [
    `:calendar: *${schedule.id} created* by <@${schedule.creatorUserId}>`,
    `${describeRule(schedule.rule)} ${schedule.timezone}`,
    `Task: ${schedule.task}`,
    `Results: <#${schedule.destination.channelId}>`,
    `Next run: ${schedule.nextDueAt}`,
  ].join("\n");
}
