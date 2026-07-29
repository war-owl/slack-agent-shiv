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
  /**
   * Run `tick` once, `delayMs` from now, unless the returned handle is stopped first.
   *
   * Same contract as {@link every}: a tick must not reject. This exists for the
   * bounds — "kill this Turn if it is still running in an hour" is a deadline rather
   * than a cadence, and expressing it as a poll would make the test assert on the
   * polling interval instead of on the bound.
   */
  after(delayMs: number, tick: () => void | Promise<void>): Stoppable;
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

  after: (delayMs, tick) => {
    const handle = setTimeout(() => {
      void Promise.resolve(tick()).catch(() => {});
    }, delayMs);
    handle.unref();
    return { stop: () => clearTimeout(handle) };
  },
};
