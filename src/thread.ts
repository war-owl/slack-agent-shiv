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
