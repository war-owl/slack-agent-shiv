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

export interface UpdateMessage {
  thread: Thread;
  /**
   * The message to rewrite. Only ever the Job's status message: a Write record is
   * appended and never edited, because the Thread is the accountability trail.
   */
  ts: string;
  text: string;
}

export interface SetStatus {
  thread: Thread;
  /** Slack's own "is thinking…" phrasing. An empty string clears the indicator. */
  status: string;
}

/** Who the instance is, according to Slack. What `auth.test` answers. */
export interface SlackIdentity {
  /** The bot's own user id — the one that appears in `<@…>` when someone mentions it. */
  botUserId: string;
  /** The workspace the tokens belong to, so a startup line can name it. */
  team: string;
}

export interface SlackClient {
  /**
   * Ask Slack who these tokens belong to.
   *
   * Called once at startup and nowhere else. The instance would otherwise discover a bad
   * bot token on the first mention — as a Job that accepted the work, said nothing, and
   * failed in the log — which is the failure preflight exists to move to a moment when
   * somebody is watching.
   */
  identity(): Promise<SlackIdentity>;
  postMessage(message: PostMessage): Promise<PostedMessage>;
  /**
   * Rewrite a message in place. Preferred over posting for progress: `chat.update` is
   * Tier 3 (50+/minute) where `chat.postMessage` is about one per second per channel,
   * and one message that changes beats a wall of narration to scroll past.
   */
  updateMessage(message: UpdateMessage): Promise<void>;
  /**
   * Slack's native loading indicator on the Thread.
   *
   * It is removed two minutes after the last call, which is the clock every long Job
   * has to beat: the indicator vanishing is what makes a quiet ten-minute command
   * look like a crash.
   */
  setStatus(status: SetStatus): Promise<void>;
}
