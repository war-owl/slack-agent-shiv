/**
 * Time, injected — because "acknowledged within three seconds" and "refreshed
 * inside Slack's two-minute status timeout" are behaviours a test has to be able
 * to drive rather than wait for.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /**
   * Run `tick` every `intervalMs` until the returned handle is stopped.
   *
   * A tick **must not reject**: it runs detached from whatever asked for it, so there
   * is nobody left to hand a failure to. Anything in a tick that can fail catches and
   * logs it itself.
   */
  every(intervalMs: number, tick: () => void | Promise<void>): Stoppable;
}

/** A handle on something running on its own, for whoever has to end it. */
export interface Stoppable {
  stop(): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),

  every: (intervalMs, tick) => {
    const handle = setInterval(() => {
      // A backstop, not error handling: ticks are contracted not to reject, and an
      // unhandled rejection here would end the process over a status refresh.
      void Promise.resolve(tick()).catch(() => {});
    }, intervalMs);
    // A pending refresh must never be the reason the process will not exit.
    handle.unref();
    return { stop: () => clearInterval(handle) };
  },
};
