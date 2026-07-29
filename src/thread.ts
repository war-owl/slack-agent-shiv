/**
 * A Slack conversation thread: the unit of topic and the unit of audience.
 *
 * Everyone who can see the channel can see the Thread, and nothing crosses between
 * Threads except through the Vault. It takes two values to name one — Slack's API
 * needs the channel as well as the timestamp — so they travel together everywhere.
 *
 * Where the word is ambiguous, this always means the Slack thread. The engine side is
 * a Session.
 */
export interface Thread {
  channel: string;
  /** Slack's `thread_ts`: the `ts` of the message that started the Thread. */
  ts: string;
}

/**
 * One Thread, as a single value — for the in-memory indexes that need to look one up.
 *
 * Two of those exist and they must agree: the queue that keeps a Thread's Jobs in a
 * line, and the index a hard-stop reaches the running Job through. A Thread that keyed
 * differently in the two would be a Thread whose stop found nothing.
 */
export function threadKey(thread: Thread): string {
  return `${thread.channel} ${thread.ts}`;
}
