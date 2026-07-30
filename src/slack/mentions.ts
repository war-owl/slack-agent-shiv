import type { Coworker, Mention, StartedJob } from "../coworker.ts";
import type { Logger } from "../ports/log.ts";

/**
 * The Slack gateway's own work: turning an `app_mention` into a Mention, and
 * discarding the ones Slack has already delivered.
 *
 * `app_mention` is the only entry point. Slash commands are barred from threads and
 * the Assistant surface is DM-only, so a mention is the one primitive that can carry
 * "here is a task, in the thread where we are already discussing it".
 *
 * Kept apart from the Bolt wiring so that tests can drive synthetic `app_mention`
 * events through the real translation and the real dedupe.
 */

/** The subset of Slack's `app_mention` event this wrapper reads. */
export interface AppMentionEvent {
  channel?: string | undefined;
  thread_ts?: string | undefined;
  ts?: string | undefined;
  user?: string | undefined;
  text?: string | undefined;
  bot_id?: string | undefined;
  files?: readonly AppMentionFile[] | undefined;
}

export interface AppMentionFile {
  id?: string | undefined;
  name?: string | undefined;
  mimetype?: string | undefined;
  size?: number | undefined;
  url_private_download?: string | undefined;
}

/** The envelope Slack wraps the event in. `event_id` lives here, not on the event. */
export interface SlackEventEnvelope {
  event_id?: string | undefined;
}

export type Delivery =
  | ({ accepted: true } & StartedJob)
  | { accepted: false; reason: "duplicate" | "ignored" };

export interface MentionGateway {
  deliver(event: AppMentionEvent, envelope: SlackEventEnvelope): Promise<Delivery>;
}

export function createMentionGateway(deps: { coworker: Coworker; log: Logger }): MentionGateway {
  // The Slack `event_id` is the Job's identity. Slack retries delivery, and a retry
  // that produced a second Job would double both the work and the spend.
  const seenEvents = new Set<string>();

  return {
    async deliver(event, envelope): Promise<Delivery> {
      const mention = toMention(event, envelope);
      if (!mention) return { accepted: false, reason: "ignored" };

      if (seenEvents.has(mention.eventId)) {
        deps.log.info(`Discarding redelivered Slack event ${mention.eventId}`);
        return { accepted: false, reason: "duplicate" };
      }
      seenEvents.add(mention.eventId);

      try {
        return { accepted: true, ...(await deps.coworker.handleMention(mention)) };
      } catch (error) {
        // Nothing was acknowledged, so nothing was really taken on. Forget the event
        // so Slack's redelivery gets a real attempt instead of being discarded as a
        // duplicate of a Job that never started.
        seenEvents.delete(mention.eventId);
        throw error;
      }
    },
  };
}

function toMention(
  event: AppMentionEvent,
  envelope: SlackEventEnvelope,
): Mention | undefined {
  if (!envelope.event_id || !event.channel || !event.ts) return undefined;
  // Another app's bot mentioning this one would otherwise be a delegation loop.
  if (event.bot_id) return undefined;

  return {
    eventId: envelope.event_id,
    thread: {
      channel: event.channel,
      // A mention that starts a thread has no `thread_ts`; its own `ts` becomes one.
      ts: event.thread_ts ?? event.ts,
    },
    userId: event.user ?? "unknown",
    text: event.text ?? "",
    // Preserve incomplete file objects too. Dropping one would let the Job run as if the
    // user had attached nothing; normalizing missing fields makes ingress fail honestly.
    files: (event.files ?? []).map((file) => ({
      id: file.id ?? "unknown",
      name: file.name ?? `Slack file ${file.id ?? "unknown"}`,
      mimetype: file.mimetype ?? "unknown",
      size: file.size ?? 0,
      privateDownloadUrl: file.url_private_download ?? "",
    })),
  };
}
