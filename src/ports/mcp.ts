/**
 * Connectors are MCP servers named in configuration (ADR-0005) — there is no
 * plugin interface. The wrapper is not in the tool path; the only thing it does
 * with a connector is *probe* it at startup, so that a server which quietly grew a
 * tool fails loudly instead of silently granting the coworker new powers.
 */

export interface McpServerConfig {
  /** The id the server is configured under, e.g. `linear`. */
  name: string;
  /** A streamable-HTTP MCP server URL. */
  url: string;
  /** The environment variable holding the bearer token. Never the token itself. */
  bearerTokenEnvVar: string;
  /**
   * Which of this server's tools act on the world rather than read it, so that every
   * use of one is appended to the Thread as a permanent record.
   *
   * Configuration rather than code, like the rest of a connector (ADR-0005) — the
   * wrapper is not in the tool path and has no way to tell a read from a write by
   * looking. Naming them is the same act as pinning the inventory: a tool nobody
   * listed here is a tool whose use leaves no trace, which is why the connector
   * tickets own their own lists rather than inheriting a guess.
   */
  writeTools: readonly string[];
  /**
   * Every tool this server advertised when a human last reviewed it — the pin.
   *
   * The **whole** inventory, not the interesting part of it, because what this exists to
   * catch is a tool that was not here before. Startup probes the live server and refuses
   * to run when the two disagree, naming what appeared and what went away
   * (`mcp/inventory.ts`).
   *
   * A list rather than the bare hash [ADR-0002](../../docs/adr/0002-unattended-action-boundary.md)
   * calls for, because a hash cannot say *which* tool appeared, and "review the diff, then
   * re-pin" is not a step anybody can take against one changed digit. The hash is derived
   * from this list and reported next to it, so the pin is both comparable and readable —
   * and per ADR-0005 it doubles as this project's only record of what Linear offers.
   */
  pinnedTools: readonly string[];
  /**
   * Tools to disable **in addition** to the ones the wrapper denies on its own.
   *
   * The floor is generated rather than configured (`mcp/denylist.ts`): a self-hoster
   * cannot forget to block the irreversible ones, and cannot mistype them either. This is
   * for a judgement the project has not made — a tool a particular workspace does not want
   * its coworker calling.
   */
  disabledTools: readonly string[];
}

export interface McpInventory {
  /** Every tool the server advertises, in the order it advertised them. */
  tools: string[];
}

export interface McpInventoryProber {
  probe(server: McpServerConfig): Promise<McpInventory>;
}
