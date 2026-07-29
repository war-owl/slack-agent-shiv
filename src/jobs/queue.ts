import { threadKey, type Thread } from "../thread.ts";

/**
 * One Thread at a time, several Threads at once.
 *
 * A Thread has exactly one Session, and a Session is a conversation. Two Jobs running
 * in it at once would interleave two conversations into one transcript, so Jobs in a
 * Thread are **strictly sequential**: a mention arriving mid-Job waits for the running
 * one to finish. Two different Threads are two audiences and two pieces of work, and
 * neither has any reason to wait for the other.
 *
 * What they wait for instead is the instance. Each Job is bounded — a wall clock, a
 * Turn cap, a token budget — but nothing bounded how many of them there were, so ten
 * Threads mentioning the coworker at once was ten subprocesses and ten budgets. The
 * ceiling here is that missing bound, and it is the only reason a Job in an idle Thread
 * ever has to wait.
 *
 * The lane is claimed **synchronously**, before the acknowledgement is posted. Order is
 * the whole promise — "delivered in the order they arrived" — and a place taken after
 * an `await` would be a place taken in the order Slack's replies came back.
 *
 * What it sequences is **Jobs, not Turns**. A Job is normally one Turn under `exec`, so
 * the next Job starting is the next Turn boundary; a Job that runs several Turns holds
 * its Thread for all of them. Delivering into a *running* Turn would need mid-turn
 * steering, which ADR-0001 gave up when it chose `exec` over `app-server`.
 */

/**
 * Why a Job cannot start the moment it arrives — the counterpart to `StopReason`, and
 * shaped like it, because both exist to be turned into a sentence in the Thread.
 */
export type WaitReason =
  /** Its own Thread is busy: the Job it is behind has to finish first. */
  | { kind: "job-ahead"; ahead: number }
  /** Its Thread is free, but the instance is already running all it will run at once. */
  | { kind: "instance-full" };

/** One Job's place in the line. */
export interface Place {
  /**
   * Why this Job will not start yet, or undefined if it starts as soon as it is given
   * work. Read before {@link take}, because it is what the acknowledgement has to say.
   */
  readonly waiting: WaitReason | undefined;
  /**
   * Wait for this Job's turn, run it, and let the Thread's next Job start.
   *
   * Answers `"dropped"` without running the Job if the place was dropped while it
   * waited — a person who stopped this Thread is not asking for the queue behind it to
   * be worked through. The caller is told which happened because it has already said
   * something in the Thread that a dropped Job makes untrue.
   */
  take(job: () => Promise<void>): Promise<"ran" | "dropped">;
  /** This Job will never run. Frees the place so the Thread is not wedged behind it. */
  abandon(): void;
}

export interface JobQueue {
  /** Take this Thread's next place in line. Synchronous, so arrival order is kept. */
  join(thread: Thread): Place;
  /**
   * Discard every Job waiting in this Thread, leaving a running one alone — stopping
   * that is a separate thing, and only the Job itself knows how.
   *
   * Returns how many were discarded, because the Thread has to be told: those are
   * messages a person sent that are now not going to be answered.
   */
  dropWaiting(thread: Thread): number;
}

/** What the queue tracks about one place. The Place above is its public face. */
interface PlaceState {
  dropped: boolean;
  /** Once the Job is running, the queue is no longer the thing that can end it. */
  started: boolean;
  /** Holding one of the instance's slots, whether or not the Job has started yet. */
  holdsSlot: boolean;
}

interface Lane {
  /** Places joined and not yet finished, oldest first. */
  places: PlaceState[];
  /** Resolves when the last place joined so far has finished. The chain's end. */
  tail: Promise<void>;
}

export function createJobQueue(deps: { maxConcurrentJobs: number }): JobQueue {
  const lanes = new Map<string, Lane>();
  /** Slots taken: Jobs running, plus Jobs that have been promised they can start. */
  let taken = 0;
  const forASlot: (() => void)[] = [];

  /**
   * Take a slot **now**, or say there is none — the question `join` has to answer
   * before it has awaited anything.
   *
   * Deciding this at join time rather than when the Job is about to run is what makes
   * the answer true. A snapshot read here and acted on after an `await` would tell
   * every mention arriving in the same tick that there was room, and the ones there
   * was no room for would then sit silent behind a status message promising work.
   */
  const claimSlot = (): boolean => {
    if (taken >= deps.maxConcurrentJobs) return false;
    taken++;
    return true;
  };

  const acquireSlot = (): Promise<void> => {
    if (claimSlot()) return Promise.resolve();
    return new Promise<void>((resolve) => forASlot.push(resolve));
  };

  const releaseSlot = (): void => {
    const next = forASlot.shift();
    // Handed straight to the longest waiter rather than counted down and back up: a
    // slot that is free for even a moment is a slot a newcomer could take out of turn.
    if (next) next();
    else taken--;
  };

  return {
    join(thread: Thread): Place {
      const key = threadKey(thread);
      const lane = lanes.get(key) ?? { places: [], tail: Promise.resolve() };
      lanes.set(key, lane);

      const place: PlaceState = { dropped: false, started: false, holdsSlot: false };
      // Places dropped by a stop are still in the line — they resolve rather than run —
      // but they are not something for a newcomer to be told it is waiting behind.
      const ahead = lane.places.filter((other) => !other.dropped).length;
      lane.places.push(place);

      // Each place waits on the one before it and is waited on by the one after, which
      // is what makes a Thread a line rather than a crowd.
      const myTurn = lane.tail;
      let finish!: () => void;
      lane.tail = new Promise<void>((resolve) => (finish = resolve));

      // A place at the head of its lane takes its slot here, synchronously, so that
      // "you are waiting" and "you are starting" are decided once and stay true. One
      // behind another Job does not: it would hold the slot idle through a wait whose
      // length nobody knows.
      if (ahead === 0) place.holdsSlot = claimSlot();

      let over = false;
      const done = (): void => {
        if (over) return;
        over = true;
        if (place.holdsSlot) {
          place.holdsSlot = false;
          releaseSlot();
        }
        const at = lane.places.indexOf(place);
        if (at !== -1) lane.places.splice(at, 1);
        // Threads are unbounded in number and most are mentioned once, so a lane that
        // nobody is in stops existing rather than accumulating for the process's life.
        if (lane.places.length === 0 && lanes.get(key) === lane) lanes.delete(key);
        finish();
      };

      return {
        waiting:
          ahead > 0
            ? { kind: "job-ahead", ahead }
            : place.holdsSlot
              ? undefined
              : { kind: "instance-full" },

        async take(job: () => Promise<void>): Promise<"ran" | "dropped"> {
          try {
            await myTurn;
            if (place.dropped) return "dropped";
            if (!place.holdsSlot) {
              await acquireSlot();
              place.holdsSlot = true;
            }
            // Checked again on the far side: waiting for a slot can be a long wait, and
            // the Thread may have been stopped during it.
            if (place.dropped) return "dropped";
            place.started = true;
            await job();
            return "ran";
          } finally {
            // Which releases the slot as well, on every path out — including the Job
            // throwing, which is the one that would otherwise wedge the whole instance.
            done();
          }
        },

        abandon(): void {
          place.dropped = true;
          done();
        },
      };
    },

    dropWaiting(thread: Thread): number {
      const lane = lanes.get(threadKey(thread));
      if (lane === undefined) return 0;
      let dropped = 0;
      for (const place of lane.places) {
        if (place.started || place.dropped) continue;
        place.dropped = true;
        dropped++;
      }
      return dropped;
    },
  };
}
