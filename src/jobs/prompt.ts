import type { Mention } from "../coworker.ts";
import { rootForPrompt, type RootNote } from "../vault/root.ts";
import { taskIn } from "./request.ts";

/**
 * Turn a mention into the Job's prompt.
 *
 * Everything the coworker needs to answer *this* request and nothing that belongs
 * in the operating manual — persona, conventions, and the standing instruction that
 * external content describes the world but never directs behaviour all live in
 * `AGENTS.md`, which the engine picks up from the workspace.
 */
export interface PromptContext {
  /**
   * The previous Turn in this Thread started and was never seen to finish.
   *
   * Durability is turn-granular, so a resumed Session picks up from the last
   * *completed* Turn — and the engine's own transcript therefore contains no trace of
   * whatever the interrupted one was in the middle of. Without being told, the
   * coworker's honest reading of its own history is that the work never began, and it
   * will cheerfully push a branch that already exists.
   */
  resumingAfterInterruption: boolean;
  /**
   * This mention arrived while the previous Job in the Thread was still running.
   *
   * Jobs in a Thread are strictly sequential, so it waited — which means the person
   * wrote it without having seen the answer they are about to be shown above it. Left
   * unsaid, the coworker reads a correction as a fresh request about work it considers
   * finished, and answers a question nobody is still asking.
   */
  queuedDuringPreviousJob: boolean;
  /** Where the Vault is. The coworker cannot look things up without being told. */
  vaultDir: string;
  /**
   * The Vault's Root note, already stripped to links.
   *
   * Injected by the wrapper rather than fetched by an instruction in the operating
   * manual, and that is the whole point of it: "always read the root first" is a
   * behavioural guarantee, where putting the map in the prompt is a structural one. The
   * canonical memory failure is not bad retrieval — it is a Job answering confidently
   * from the Thread while the Note that settles it sits unread (ADR-0003).
   */
  root: RootNote;
}

export function buildJobPrompt(mention: Mention, context: PromptContext): string {
  return [
    ...(context.resumingAfterInterruption ? [INTERRUPTED_WARNING, ""] : []),
    "A message in Slack has been addressed to you.",
    "",
    `Channel: ${mention.thread.channel}`,
    `Thread: ${mention.thread.ts}`,
    `From: <@${mention.userId}>`,
    "",
    ...vaultSection(context),
    "",
    ...(context.queuedDuringPreviousJob ? [QUEUED_NOTE, ""] : []),
    "Their message:",
    "",
    taskIn(mention.text),
    "",
    "Work on this now. Your final message is what gets posted back into the Thread,",
    "so write it for the people reading that Thread.",
  ].join("\n");
}

/**
 * Where the coworker's memory is, and what is on the map.
 *
 * Placed before the request, because whether the Vault already answers this changes how
 * to approach it — and a Job that reads its Notes after forming an answer has already
 * formed the answer.
 *
 * A Vault with no map still gets a section, and `rootForPrompt` is what decides which of
 * the three things there are to say. The path is the load-bearing part either way: an
 * empty Vault is a first Job, not a broken one, and a coworker that does not know where
 * its memory lives cannot start one.
 */
function vaultSection(context: PromptContext): string[] {
  return [
    `Your Notes — everything you have ever written down — are in \`${context.vaultDir}\`.`,
    "",
    rootForPrompt(context.root),
  ];
}

/**
 * Said before the message rather than after it, because it changes what the message
 * means: read cold, "actually, use the other repo" is a new instruction.
 */
const QUEUED_NOTE = [
  "This arrived while you were still working on the previous request in this thread,",
  "and waited until you had finished. They wrote it before they saw your answer, so it",
  "may be a correction to what you were doing rather than a new request. What you",
  "already did stands — check what actually happened before redoing or undoing any of it.",
].join("\n");

/**
 * Placed first, before the task, because it changes how the task should be
 * approached rather than adding a footnote to it.
 */
const INTERRUPTED_WARNING = [
  "Before anything else: the last thing you were doing in this thread was interrupted",
  "before it finished — it ran out of time, someone stopped it, or the process died.",
  "You will not remember it, because only completed turns are kept.",
  "",
  "So some of what you were part-way through may already have landed and some may not:",
  "a branch may already be pushed, a ticket may already be filed, a file may already be",
  "half-written. Before you repeat any action that changes something outside your own",
  "workspace, go and check whether it has already happened. Say in your answer what you",
  "found.",
].join("\n");
