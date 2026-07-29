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
 * - **Generated as a small fixed floor rather than from an inventory snapshot.** MCP
 *   servers may add and remove tools without blocking startup. The irreversible tool names
 *   already measured by this project stay unavailable, and configuration can add more.
 *
 * **This covers the MCP tool path and nothing else.** GitHub is reached by Skill over the
 * `gh` CLI (ADR-0006), so `merge_pull_request` and `delete_file` are not on this list — not
 * because they became safe, but because there is no longer a server to disable them on.
 * That is the weakest point in the design and preflight says so out loud.
 */

/**
 * Blocked by exact name, independent of any server inventory.
 *
 * Both are Linear's, and both are the same mistake in different clothes: `merge_diff` puts
 * commits into a repository, and `submit_diff_review` approves someone's code in the
 * coworker's name. Reading diffs and commenting on them stays allowed — nobody scoped a
 * code-reviewing coworker into v1, and the two halves of that surface are separable.
 */
const BLOCKED_BY_NAME: readonly string[] = [
  "merge_diff",
  "submit_diff_review",
  "delete_attachment",
  "delete_comment",
  "delete_diff_comment",
  "delete_status_update",
];

/**
 * One connector's `disabled_tools`, as Codex will be configured with them: the generated
 * floor plus whatever configuration added.
 */
export function disabledToolsFor(server: McpServerConfig): string[] {
  return [...new Set([...BLOCKED_BY_NAME, ...server.disabledTools])].sort();
}

/**
 * Anything configuration asked to disable that the server does not advertise.
 *
 * Reported rather than fatal, and only for the configured half. The fixed floor is sent
 * to every MCP server whether or not it currently advertises those names. A stale explicit
 * entry is harmless to Codex and worth saying anyway, because someone believes it is
 * protecting them.
 */
export function unknownDisabledTools(server: McpServerConfig, tools: readonly string[]): string[] {
  return server.disabledTools.filter((tool) => !tools.includes(tool));
}
