import type { Mention } from "../coworker.ts";
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
    "Their message:",
    "",
    taskIn(mention.text),
    "",
    "Work on this now. Your final message is what gets posted back into the Thread,",
    "so write it for the people reading that Thread.",
  ].join("\n");
}

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
