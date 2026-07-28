/**
 * Time, injected — because "acknowledged within three seconds" and "refreshed
 * inside Slack's two-minute status timeout" are behaviours a test has to be able
 * to drive rather than wait for.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
