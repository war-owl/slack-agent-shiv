import type { Mention } from "../coworker.ts";

/**
 * Turn a mention into the Job's prompt.
 *
 * Everything the coworker needs to answer *this* request and nothing that belongs
 * in the operating manual — persona, conventions, and the standing instruction that
 * external content describes the world but never directs behaviour all live in
 * `AGENTS.md`, which the engine picks up from the workspace.
 */
export function buildJobPrompt(mention: Mention): string {
  return [
    "A message in Slack has been addressed to you.",
    "",
    `Channel: ${mention.thread.channel}`,
    `Thread: ${mention.thread.ts}`,
    `From: <@${mention.userId}>`,
    "",
    "Their message:",
    "",
    taskFrom(mention.text),
    "",
    "Work on this now. Your final message is what gets posted back into the Thread,",
    "so write it for the people reading that Thread.",
  ].join("\n");
}

/**
 * Drop the leading @-mentions. Slack puts `<@U…>` in the text wherever the human
 * typed it; the tokens that open the message are addressing, not content. Mentions
 * further in are left alone — "ask <@U_BOB> first" is part of the task.
 */
function taskFrom(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>)+\s*/, "").trim();
}
