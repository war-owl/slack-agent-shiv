import type { McpServerConfig } from "../ports/mcp.ts";

/**
 * Layer 2 of the action boundary: the tools that do not exist from the coworker's point of
 * view ([ADR-0002](../../docs/adr/0002-unattended-action-boundary.md)).
 *
 * The criterion is not "dangerous" but **"can a human undo this after noticing it in the
 * Thread?"** A wrong comment is embarrassing and stays available; a merged pull request is
 * in `main`. Those are also precisely the actions a poisoned issue comment would aim at.
 *
 * Two properties of how it is built here, both deliberate:
 *
 * - **Hand-curated, not derived from MCP annotations.** The names below are this project's
 *   judgement. Measured, Linear flags 18 of 57 tools destructive while GitHub's server
 *   flagged exactly one and left `merge_pull_request` unflagged — so "deny everything the
 *   server calls destructive" would have left the worst tool in the inventory reachable.
 * - **Generated per server rather than configured.** The list is computed from the
 *   connector's pinned inventory, so a self-hoster cannot forget to block `merge_diff` and
 *   cannot mistype it either — a deny-list entry naming a tool that does not exist is a
 *   boundary that silently is not there. Configuration adds to this floor
 *   ({@link McpServerConfig.disabledTools}); it cannot lower it.
 *
 * **Derived from the pin, not from the live probe**, which is what makes it safe to compute
 * before the engine starts: preflight refuses to run when the two disagree, so a deny-list
 * built from the pin can never be a deny-list built from a stale inventory.
 *
 * **This covers the MCP tool path and nothing else.** GitHub is reached by Skill over the
 * `gh` CLI (ADR-0006), so `merge_pull_request` and `delete_file` are not on this list — not
 * because they became safe, but because there is no longer a server to disable them on.
 * That is the weakest point in the design and preflight says so out loud.
 */

/**
 * Blocked by exact name.
 *
 * Both are Linear's, and both are the same mistake in different clothes: `merge_diff` puts
 * commits into a repository, and `submit_diff_review` approves someone's code in the
 * coworker's name. Reading diffs and commenting on them stays allowed — nobody scoped a
 * code-reviewing coworker into v1, and the two halves of that surface are separable.
 */
const BLOCKED_BY_NAME: readonly string[] = ["merge_diff", "submit_diff_review"];

/**
 * Blocked by prefix — Linear's `delete_*` family, and any other server's.
 *
 * A prefix rather than the four names measured on Linear, because a server that adds a
 * fifth `delete_` tool should not be able to hand it to the coworker just by being renamed
 * in configuration. The inventory pin catches the *arrival* of any new tool; this makes the
 * commonest irreversible verb blocked the moment it arrives rather than after the review.
 *
 * Deliberately not `merge_`: ADR-0006 took GitHub out of the tool path, and generalising
 * over a verb that no configured server currently exposes would be a rule written for a
 * connector nobody has.
 */
const BLOCKED_BY_PREFIX: readonly string[] = ["delete_"];

/** The tools in a given inventory that this project will not let the coworker call. */
export function irreversibleToolsIn(tools: readonly string[]): string[] {
  return [...new Set(tools)]
    .filter(
      (tool) =>
        BLOCKED_BY_NAME.includes(tool) ||
        BLOCKED_BY_PREFIX.some((prefix) => tool.startsWith(prefix)),
    )
    .sort();
}

/**
 * One connector's `disabled_tools`, as Codex will be configured with them: the generated
 * floor plus whatever configuration added.
 */
export function disabledToolsFor(server: McpServerConfig): string[] {
  return [
    ...new Set([...irreversibleToolsIn(server.pinnedTools), ...server.disabledTools]),
  ].sort();
}

/**
 * Anything configuration asked to disable that the server does not advertise.
 *
 * Reported rather than fatal, and only for the configured half — the generated half is
 * drawn from the inventory and cannot miss. A stale entry here is harmless to Codex and
 * worth saying anyway, because someone believes it is protecting them.
 */
export function unknownDisabledTools(server: McpServerConfig, tools: readonly string[]): string[] {
  return server.disabledTools.filter((tool) => !tools.includes(tool));
}
