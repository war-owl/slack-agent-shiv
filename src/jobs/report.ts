import type { PlanStep } from "../ports/engine.ts";
import { mrkdwn } from "../reporter/mrkdwn.ts";
import type { JobOutcome } from "../reporter/status.ts";
import type { StopReason } from "./bounds.ts";

/**
 * The last word on a Job: the message that goes into the Thread.
 *
 * A Job that succeeds says one thing — its answer. A Job that does not has three
 * things to say, and this module exists because getting any of them wrong is worse
 * than saying nothing: **that it stopped**, in a way that cannot be read as a result;
 * **how far it got**, because the person who walked away needs to know what to pick
 * up; and **that its side effects may have landed anyway**, because the coworker acts
 * unattended and a half-finished Job leaves real things behind it.
 *
 * The last of those is the one a failure message usually omits. A Job that dies after
 * pushing a branch has changed the world, and a report that says only "something went
 * wrong" invites the human to ask again and get a duplicate.
 */

/**
 * How the Job ended, said two ways: the message that goes into the Thread, and the
 * state the status message settles into.
 *
 * They are one value because they are one judgement. Deciding "did this finish?" twice
 * — once to write the prose and once to pick the icon — is how a Thread ends up with
 * an apology under a green tick.
 */
export interface JobReport {
  text: string;
  outcome: JobOutcome;
}

export interface JobEnding {
  /** The engine's last message. Empty if it never produced one. */
  answer: string;
  /** Set when a bound tripped or a person stopped the Job. */
  stoppedBy: StopReason | undefined;
  /** Set when the engine failed or the wrapper threw. */
  failure: string | undefined;
  /** The engine's own plan, as last revised — what it finished, and what it did not. */
  plan: readonly PlanStep[];
  /** Writes appended to the Thread. What is known to have happened out in the world. */
  recorded: number;
  /** Writes Slack refused. Holes in the account. */
  unrecorded: number;
}

export function reportFor(ending: JobEnding): JobReport {
  return withMissingRecords(endingReport(ending), ending.unrecorded);
}

function endingReport(ending: JobEnding): JobReport {
  if (ending.stoppedBy !== undefined) {
    return {
      outcome: "stopped",
      text: paragraphs([
        `**Stopped — ${stopSentence(ending.stoppedBy)}**`,
        ending.answer.trim() === "" ? undefined : `Where I had got to:\n\n${ending.answer}`,
        ...howFarItGot(ending.plan),
        aftermath(ending.recorded),
      ]),
    };
  }

  if (ending.answer.trim() === "") {
    return ending.failure === undefined
      ? {
          outcome: "stopped",
          text:
            "I finished without producing an answer. That is not a result — ask me " +
            "again, and if it keeps happening the instance logs will say why.",
        }
      : brokeDown(ending);
  }

  // An answer that arrived before a failure is still the answer. Losing it and
  // reporting only the error would throw away work the human can use.
  if (ending.failure === undefined) return { text: ending.answer, outcome: "finished" };
  return {
    outcome: "stopped",
    text: `${ending.answer}\n\n---\n${brokeDown(ending).text}`,
  };
}

/** A Job that did not stop deliberately: it broke. */
function brokeDown(ending: JobEnding): JobReport {
  return {
    outcome: "stopped",
    text: paragraphs([
      `**Stopped — I could not finish this: ${mrkdwn(ending.failure ?? "no reason given")}**`,
      ...howFarItGot(ending.plan),
      aftermath(ending.recorded),
    ]),
  };
}

/**
 * What each way of stopping says for itself.
 *
 * Every one of these names the bound that stopped the Job, because the remedies are
 * completely different — raise a limit, split the task, look at why it wedged — and a
 * generic "it was stopped" serves none of them.
 *
 * Exported because the instance's own log wants to say the same thing, and the phrase
 * is worth having in one place: two switches on the same four cases is how a fifth way
 * of stopping ends up described in the Thread and not in the log.
 */
export function stopSentence(reason: StopReason): string {
  switch (reason.kind) {
    case "turn-timeout":
      return (
        `this turn ran past the ${duration(reason.limitMs)} it is allowed, ` +
        "so I killed it."
      );
    case "max-turns":
      return `this job reached its limit of ${reason.limit} turns.`;
    case "token-budget":
      return (
        `this job reached its token budget — ${grouped(reason.spent)} tokens spent ` +
        `against a budget of ${grouped(reason.budget)}.`
      );
    case "asked-to-stop":
      return `<@${reason.byUserId}> asked me to stop.`;
  }
}

/**
 * What completed and what did not, from the engine's own plan.
 *
 * The plan is the only account of intent this side has — the wrapper does not know
 * what the coworker meant to do, only what it wrote down that it meant to do. When
 * there is no plan there is nothing honest to enumerate, and {@link aftermath} still
 * says what is known.
 */
function howFarItGot(plan: readonly PlanStep[]): string[] {
  const finished = plan.filter((step) => step.completed);
  const unfinished = plan.filter((step) => !step.completed);
  return [
    ...(finished.length > 0 ? [list("What I finished", finished)] : []),
    ...(unfinished.length > 0 ? [list("What I did not", unfinished)] : []),
  ];
}

function list(heading: string, steps: readonly PlanStep[]): string {
  return [`**${heading}:**`, ...steps.map((step) => `- ${mrkdwn(step.text)}`)].join("\n");
}

/**
 * The sentence that has to be there whatever else is.
 *
 * Stopping a Job unwinds nothing. Whatever it had already done is still done, and
 * whatever it was in the middle of may be half done — the branch pushed but the pull
 * request unopened, the file written but not linked. The person coming back to this
 * needs to check before they ask again, and saying so is the difference between a
 * duplicate ticket and none.
 *
 * The no-records case is deliberately not phrased as an all-clear. The audit trail
 * sees file changes and tool calls exactly and shell commands only by pattern, so
 * "nothing was recorded" is weaker than "nothing happened", and this says so.
 */
function aftermath(recorded: number): string {
  if (recorded === 0) {
    return (
      "I have no record of changing anything outside my own workspace — though a " +
      "change made by a shell command may not have been recorded, so it is worth a look."
    );
  }
  const what =
    recorded === 1 ? "The one action recorded above" : `The ${recorded} actions recorded above`;
  return (
    `${what} already happened, and stopping did not undo any of it. Anything I was ` +
    "in the middle of may have landed only partway, so check before asking me again."
  );
}

/**
 * A Job that could not record everything it did says so where the human is reading.
 *
 * The Job itself may well have succeeded — a Slack refusal does not undo the work, and
 * the outcome is left alone. But the Thread is the accountability record, and a record
 * with a silent hole in it is worse than one that admits to the hole.
 */
function withMissingRecords(report: JobReport, missing: number): JobReport {
  if (missing === 0) return report;
  const what =
    missing === 1
      ? "One action I took could not be recorded"
      : `${missing} of the actions I took could not be recorded`;
  return {
    outcome: report.outcome,
    text:
      `${report.text}\n\n---\n${what} in this thread — Slack refused the message. ` +
      "What I did still happened; the instance's own log has the records.",
  };
}

function paragraphs(parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined).join("\n\n");
}

/** A limit in the words someone would use for it, not in milliseconds. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return plural(minutes, "minute");
  return plural(Math.round(minutes / 60), "hour");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** Thousands separators, without asking the runtime what locale it is in. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
