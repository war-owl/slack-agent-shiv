import type { Bounds } from "../config.ts";
import type { Clock, Stoppable } from "../ports/clock.ts";
import type { EngineEvent } from "../ports/engine.ts";

/**
 * What stops a Job that does not stop by itself.
 *
 * **Every bound here is the wrapper's.** Codex offers no ceiling of any kind: no
 * timeout, no maximum number of Turns, no budget, and no kill switch. It reports what
 * a Turn cost only once the Turn is over. So this module is not a convenience layer
 * over the engine's own limits — it is the only thing between a wedged or looping Job
 * and however long the self-hoster takes to notice.
 *
 * The three bounds catch three different failures and none of them substitutes for
 * another:
 *
 * - **Wall clock** catches the Job that is *stuck*. A hung subprocess spends nothing
 *   and would otherwise sit there until someone looks.
 * - **Turns** catches the Job that is *looping* — making progress by its own lights,
 *   over and over.
 * - **Tokens** catches the Job that is *expensive*. It is the only one of the three
 *   that answers for money, and it is necessarily coarse: usage arrives at turn
 *   completion and nowhere else, so a single Turn can overrun the budget entirely
 *   before anything can be counted. **What it prevents is the next Turn** — which
 *   means that for the one-Turn Job `exec` normally produces, the wall clock is the
 *   only thing standing between a runaway and the bill. That is a real gap and not a
 *   fixable one from here; it is why the wall clock's default is chosen with spend in
 *   mind and not only with wedges.
 *
 * All three land on the same primitive: abort the signal the engine's run was given,
 * which kills the subprocess. A Job that has been stopped and is still spending money
 * has not been stopped.
 *
 * The configured `bounds` carry a fourth number, `maxConcurrentJobs`, which nothing
 * here reads. It bounds the *instance* rather than a Job — it decides whether a Job
 * starts, where these three decide when a started one has gone on too long — so it is
 * enforced by `./queue.ts`. It travels in the same config group because it is the same
 * question for whoever writes the `.env`.
 */

/** Why a Job stopped before it was finished. */
export type StopReason =
  /** A single Turn ran longer than it is allowed to. */
  | { kind: "turn-timeout"; limitMs: number }
  /** The Job ran more Turns than it is allowed to. */
  | { kind: "max-turns"; limit: number }
  /** The Job spent more tokens than it is allowed to. */
  | { kind: "token-budget"; spent: number; budget: number }
  /** A person said stop, from the Thread. */
  | { kind: "asked-to-stop"; byUserId: string };

export interface JobBounds {
  /** Handed to the engine's run. Aborted the moment any bound trips. */
  readonly signal: AbortSignal;
  /**
   * Count what the engine just did against the bounds.
   *
   * Synchronous and cheap, like the Reporter's two channels — a bound that cost a
   * network call would be a bound that slows down the thing it is watching.
   */
  observe(event: EngineEvent): void;
  /**
   * Stop this Job now. Returns false if it had already stopped or already finished,
   * so a person stopping a Job that just ended is told so rather than left waiting.
   */
  stop(reason: StopReason): boolean;
  /** Why the Job was stopped, or undefined while it is still running normally. */
  readonly stoppedBy: StopReason | undefined;
  /** Tokens spent so far, as the engine reported them at each turn completion. */
  readonly tokensSpent: number;
  /** The Job is over. Stops the timers, and refuses any later attempt to stop it. */
  release(): void;
}

export function boundJob(deps: { bounds: Bounds; clock: Clock }): JobBounds {
  const { bounds, clock } = deps;
  const controller = new AbortController();

  let stoppedBy: StopReason | undefined;
  let released = false;
  let turns = 0;
  let tokensSpent = 0;
  let turnDeadline: Stoppable | undefined;

  const trip = (reason: StopReason): boolean => {
    if (stoppedBy !== undefined || released) return false;
    stoppedBy = reason;
    turnDeadline?.stop();
    turnDeadline = undefined;
    // The engine's process dies here. Everything downstream — the report, the status
    // message, the Session's interrupted flag — is a consequence of this line.
    controller.abort();
    return true;
  };

  /**
   * Start the clock on a Turn.
   *
   * Armed as soon as the Job asks the engine to run rather than at the first
   * `turn-started`, because an engine that never gets as far as starting a Turn is
   * exactly the wedge this is here to catch — and re-armed at each `turn-started`,
   * because the bound is per Turn.
   *
   * **Never disarmed until the Job ends**, including at `turn-completed`. Disarming
   * there looks right — nothing is running, so nothing is overdue — and leaves an
   * engine that finished its Turn and then never closed its stream bounded by nothing
   * at all, which is the same wedge wearing a different hat.
   */
  const armTurnClock = (): void => {
    turnDeadline?.stop();
    turnDeadline = clock.after(bounds.turnTimeoutMs, () => {
      trip({ kind: "turn-timeout", limitMs: bounds.turnTimeoutMs });
    });
  };

  armTurnClock();

  return {
    signal: controller.signal,

    observe(event: EngineEvent): void {
      if (stoppedBy !== undefined) return;
      switch (event.type) {
        case "turn-started":
          turns++;
          // Counted from the engine's own event rather than from the wrapper's calls.
          // The engine decides what a Turn is — it is the unit of durability, not a
          // unit this side chose — so the honest count is the one it announces.
          if (turns > bounds.maxTurnsPerJob) {
            trip({ kind: "max-turns", limit: bounds.maxTurnsPerJob });
            return;
          }
          armTurnClock();
          break;
        case "turn-completed":
          if (event.usage) {
            // Exactly as reported, cache included. See BOUND_DEFAULTS: this is a
            // ceiling on volume, and the instance cannot price the model it was
            // pointed at, so it does not pretend to.
            tokensSpent += event.usage.inputTokens + event.usage.outputTokens;
          }
          if (tokensSpent >= bounds.tokenBudgetPerJob) {
            trip({
              kind: "token-budget",
              spent: tokensSpent,
              budget: bounds.tokenBudgetPerJob,
            });
          }
          break;
        default:
          // Everything else is the Job's work, and none of the three bounds counts it.
          break;
      }
    },

    stop: (reason: StopReason): boolean => trip(reason),

    get stoppedBy() {
      return stoppedBy;
    },

    get tokensSpent() {
      return tokensSpent;
    },

    release(): void {
      released = true;
      turnDeadline?.stop();
      turnDeadline = undefined;
    },
  };
}
