/**
 * What the human actually said, and whether what they said was "stop".
 *
 * Both questions are asked of the same string and answered the same way — after the
 * addressing tokens come off — so they live together rather than each stripping
 * mentions in its own way.
 */

/**
 * Drop the leading @-mentions. Slack puts `<@U…>` in the text wherever the human
 * typed it; the tokens that open the message are addressing, not content. Mentions
 * further in are left alone — "ask <@U_BOB> first" is part of the task.
 */
export function taskIn(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>)+\s*/, "").trim();
}

/**
 * The whole vocabulary of stopping. Deliberately short, and deliberately matched
 * whole.
 *
 * A mention arriving mid-Job is *queued*, not obeyed, so "stop, wrong repo" is a
 * correction the coworker reads at the next Turn boundary and hard-stop has to be
 * something else. It cannot be a slash command — those are barred from threads — and
 * `app_mention` is the only entry point this system has, so the distinguisher is that
 * the message says nothing but the word.
 *
 * That line is sharp on purpose. "Stop" alone can only mean stop; "stop and check the
 * other branch instead" is work, and killing the Job on it would throw away an hour
 * over a word. The cost of being wrong the other way is one queued message and a
 * person typing "stop" again.
 */
const STOP_WORDS = new Set(["stop", "halt", "cancel", "abort", "stop it", "quit"]);

/** Did this mention ask the coworker to stop, and nothing else? */
export function isStopRequest(text: string): boolean {
  // Trailing punctuation and case are how people type; neither changes the meaning.
  const said = taskIn(text).toLowerCase().replace(/[.!]+$/, "").trim();
  return STOP_WORDS.has(said);
}
