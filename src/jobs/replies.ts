import type { WaitReason } from "./queue.ts";

/**
 * What the wrapper says about a Job when the Job itself has nothing to say yet.
 *
 * Two moments, both of them the wrapper's own voice rather than the coworker's: a
 * mention that landed but cannot be worked on, and a person asking for everything in
 * this Thread to stop. Neither is Progress ({@link ../reporter/status.ts}) and neither
 * is the Job's report ({@link ./report.ts}) — nothing has happened yet in one case and
 * nothing more will happen in the other.
 *
 * Kept out of the Job runner for the same reason the report is: what the Thread reads
 * changes far more often than how a Job is sequenced, and a module that changes for
 * both reasons gets edited nervously.
 */

/**
 * The receipt for a mention that cannot be worked on yet.
 *
 * It says three things, and the third is the one that stops the queue being a trap:
 * that the message landed, why nothing is happening, and **what to type if waiting is
 * not what they wanted**. A correction — "stop, wrong repo" — queues like anything
 * else, which is the accepted cost of never interleaving two Jobs in one Session; a
 * person who does not know that is a person watching the coworker knowingly finish the
 * wrong work.
 */
export function queueReceipt(wait: WaitReason): string {
  return [
    `:inbox_tray: *Got it* — ${whyItWaits(wait)}`,
    "_If you'd rather I dropped what I'm doing, say *stop* on its own._",
  ].join("\n");
}

function whyItWaits(wait: WaitReason): string {
  if (wait.kind === "instance-full") {
    return (
      "I'm already running as many jobs at once as I will, so I'll start this as soon " +
      "as one of them frees up."
    );
  }
  return wait.ahead === 1
    ? "I'm still working on the job above this one, so I'll start this when that's done."
    : `there are ${wait.ahead} jobs ahead of this one in this thread, so I'll start it ` +
        "when they're done.";
}

/**
 * What a receipt becomes when its Job is dropped before it ever starts.
 *
 * The receipt promised to pick the message up. Emptying the queue without correcting it
 * leaves that promise sitting in the Thread — the reader has to infer, from a count in
 * a different message, that the one they are looking at no longer means what it says.
 */
export function droppedReceipt(): string {
  return (
    ":wastebasket: *Dropped* — this thread was stopped before I got to this message. " +
    "Send it again if you still want it done."
  );
}

/**
 * What stopping actually did, in the four combinations of running and queued.
 *
 * Both halves are said out loud even when one of them is "nothing". A person who typed
 * stop and saw silence cannot tell whether it was heard, and messages dropped from the
 * queue are things they sent that are now not going to be answered — discarding those
 * quietly would be the same failure as queueing them quietly.
 */
export function stopReply(said: { stopped: boolean; dropped: number }): string {
  const waiting =
    said.dropped === 1
      ? "the message that was waiting"
      : `the ${said.dropped} messages that were waiting`;
  const again = said.dropped === 1 ? "Send it again" : "Send them again";

  if (said.stopped) {
    return said.dropped === 0
      ? "Stopping now. I'll say where I had got to in a moment."
      : `Stopping now, and I've dropped ${waiting} behind it. ${again} if you still ` +
          "want it done. I'll say where I had got to in a moment.";
  }
  return said.dropped === 0
    ? "Nothing of mine is running in this thread, so there was nothing to stop."
    : "Nothing of mine had started in this thread yet, so there was nothing to stop — " +
        `but I've dropped ${waiting} to be picked up. ${again} if you still want it done.`;
}
