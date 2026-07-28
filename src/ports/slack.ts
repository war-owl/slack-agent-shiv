import type { Thread } from "../thread.ts";

/**
 * What the coworker needs from Slack, and nothing more.
 *
 * The real implementation wraps Bolt's `WebClient`; tests substitute a fake and
 * assert on the calls made. Keeping this narrow is what makes "assert on the Slack
 * calls" a readable test rather than a mock-heavy one.
 */

export interface PostMessage {
  /** Every message the coworker posts is threaded — the answer lives with the question. */
  thread: Thread;
  text: string;
}

export interface PostedMessage {
  /** The new message's own `ts` — needed to edit it later. */
  ts: string;
}

export interface SlackClient {
  postMessage(message: PostMessage): Promise<PostedMessage>;
}
