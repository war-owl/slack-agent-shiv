/**
 * What the instance says about itself.
 *
 * A self-hoster reads this at startup and when something looks wrong, so `warn` is
 * for conditions they can act on rather than for anything unexpected.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}
