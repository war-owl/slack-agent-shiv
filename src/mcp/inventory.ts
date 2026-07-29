import { createHash } from "node:crypto";
import type { McpInventory, McpServerConfig } from "../ports/mcp.ts";

/**
 * The inventory pin: what a connector offered when a human last looked at it.
 *
 * A hosted MCP server is somebody else's deployment, and it can grow a tool between one
 * startup and the next without telling anyone. [ADR-0002](../../docs/adr/0002-unattended-action-boundary.md)
 * makes that a **loud startup failure** rather than a silent capability gain, on a measured
 * rather than hypothetical basis: Linear shipped `merge_diff` — a tool that puts commits in
 * a repository's merge queue — into a surface nobody re-reviewed, and MCP's own
 * `destructiveHint` annotations cannot be trusted to flag that sort of thing (Linear flags
 * 18 of 57 tools destructive; GitHub's server flagged exactly one).
 *
 * **This detects change, not danger.** A human still has to read the diff and decide. What
 * the pin buys is that the decision happens at all.
 */

/**
 * The pin's fingerprint — a hash of the tool names, reported next to them.
 *
 * **Sorted before hashing**, so that a server which reorders its own `tools/list` does not
 * read as a capability change. That is not laxness: a false alarm here is worse than none,
 * because the remedy for an alarm is "re-pin", and an operator who has learned that
 * re-pinning is routine will re-pin the day it matters.
 */
export function inventoryFingerprint(tools: readonly string[]): string {
  const canonical = [...new Set(tools)].sort().join("\n");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** What changed between the pin and the live server. Empty both ways means no drift. */
export interface InventoryDrift {
  /** Tools the server now advertises and the pin does not know about. */
  appeared: string[];
  /** Tools the pin expects and the server no longer advertises. */
  disappeared: string[];
}

export function inventoryDrift(
  pinned: readonly string[],
  live: readonly string[],
): InventoryDrift {
  const pin = new Set(pinned);
  const now = new Set(live);
  return {
    appeared: [...now].filter((tool) => !pin.has(tool)).sort(),
    disappeared: [...pin].filter((tool) => !now.has(tool)).sort(),
  };
}

export function hasDrifted(drift: InventoryDrift): boolean {
  return drift.appeared.length > 0 || drift.disappeared.length > 0;
}

/**
 * Why the instance is not starting, written for whoever has to decide what to do about it.
 *
 * Every part of it is here for a reason: the two lists because "the inventory changed" is
 * not something anyone can act on; the fresh fingerprint because re-pinning is the intended
 * outcome of an *informed* review and the operator should not have to compute it; and the
 * appeared tools spelled out one per line because they are the thing to go and read.
 */
export function driftFailure(
  server: McpServerConfig,
  live: McpInventory,
  drift: InventoryDrift,
): string {
  const lines = [
    `Connector "${server.name}" no longer advertises the tools it was pinned to, so the ` +
      "instance is stopping rather than running with a tool surface nobody has reviewed.",
  ];
  if (drift.appeared.length > 0) {
    lines.push(
      "",
      `Appeared since the pin (${drift.appeared.length}) — these are new powers the ` +
        "coworker would have had, unattended:",
      ...drift.appeared.map((tool) => `  + ${tool}`),
    );
  }
  if (drift.disappeared.length > 0) {
    lines.push(
      "",
      `Gone since the pin (${drift.disappeared.length}) — anything relying on these will ` +
        "now fail mid-Job:",
      ...drift.disappeared.map((tool) => `  - ${tool}`),
    );
  }
  lines.push(
    "",
    "Read what appeared, decide whether the coworker should have it, and only then " +
      `re-pin: replace this connector's "pinnedTools" with the ${live.tools.length} tools ` +
      "it advertises now.",
    `  fingerprint now: ${inventoryFingerprint(live.tools)}`,
    `  pinned:          ${inventoryFingerprint(server.pinnedTools)}`,
    `  tools now:       ${JSON.stringify([...live.tools].sort())}`,
  );
  return lines.join("\n");
}

/**
 * Why an unpinned connector does not start either.
 *
 * The alternative — pin whatever the server happens to say on first run — would make the
 * mechanism worthless: the one moment a human is guaranteed to be watching is the moment
 * they add the connector, and an inventory adopted without being read is a review that
 * never happened. So the first startup is the review, and this is the message that asks
 * for it, with the answer already in hand so it costs a paste rather than a script.
 */
export function unpinnedFailure(server: McpServerConfig, live: McpInventory): string {
  return [
    `Connector "${server.name}" has no pinned tool inventory, so the instance is stopping: ` +
      "an unreviewed tool surface is exactly what the pin exists to prevent.",
    "",
    `It advertises ${live.tools.length} tools right now. Read them — particularly anything ` +
      "that merges, deletes, or approves — and if the coworker should have them, paste this " +
      `into the connector's "pinnedTools":`,
    "",
    JSON.stringify([...live.tools].sort(), undefined, 2),
    "",
    `  fingerprint: ${inventoryFingerprint(live.tools)}`,
  ].join("\n");
}
