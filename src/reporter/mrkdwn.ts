/**
 * Slack's mrkdwn, for text the coworker did not write for Slack.
 *
 * Both output channels render model output and machine output — plan steps, commands,
 * file paths, tool results — into messages. All of it routinely contains `<`, `>` and
 * `&`, which Slack's parser reads as markup, and any of it can be arbitrarily long or
 * span many lines where the message has room for a phrase. So all of it comes through
 * here, and everything here does both jobs: escape, and cut to size.
 */

/** How long a phrase may be before it is elided, and how long a quoted command may be. */
const PHRASE = 300;
const COMMAND = 160;

/** A phrase from elsewhere: escaped, collapsed onto one line, and elided if long. */
export function mrkdwn(value: string): string {
  return escaped(oneLine(value, PHRASE));
}

/** A command or a path, as inline code. Backticks are replaced rather than escaped. */
export function code(value: string): string {
  return `\`${escaped(oneLine(value, COMMAND).replace(/`/g, "'"))}\``;
}

/** A link, in Slack's own `<url|label>` form. */
export function link(url: string, label: string): string {
  // The label is escaped as any phrase is; the address needs only its ampersands,
  // which query strings have and Slack would otherwise read as the start of an entity.
  return `<${url.replace(/&/g, "&amp;")}|${mrkdwn(label)}>`;
}

/** One line, at most `max` characters, with an ellipsis where it was cut. */
export function oneLine(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** Escape what Slack's mrkdwn parser would otherwise read as markup. */
function escaped(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
