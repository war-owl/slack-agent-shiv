import type { Thread } from "../thread.ts";

/**
 * The `Thread → engine session id` mapping: **the wrapper's only durable state.**
 *
 * Codex owns Session content as append-only rollouts on its own disk, and Notes are
 * files in the Vault. So there is nothing else for this project to persist — which is
 * why this port is two methods and stores identifiers rather than conversation. If a
 * future ticket finds itself wanting to keep transcripts here, that is the signal to
 * reread ADR-0003 rather than to widen this interface.
 */
export interface SessionStore {
  /** The Session recorded for this Thread, or undefined if it has none yet. */
  get(thread: Thread): Promise<string | undefined>;
  /**
   * Record this Thread's Session.
   *
   * Written by the time it resolves, and written such that this process dying
   * afterwards still leaves the Thread resumable. That is a promise about *this
   * process*, not about the host: the write is atomically replaced rather than
   * `fsync`ed, so a machine losing power may still lose the most recent mapping. The
   * cost of that is one Thread starting over, which is not worth an `fsync` on every
   * Job — but it is worth stating rather than implying.
   */
  set(thread: Thread, sessionId: string): Promise<void>;
}
