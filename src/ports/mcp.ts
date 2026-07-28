/**
 * Connectors are MCP servers named in configuration (ADR-0005) — there is no
 * plugin interface. The wrapper is not in the tool path; the only thing it does
 * with a connector is *probe* it at startup, so that a server which quietly grew a
 * tool fails loudly instead of silently granting the coworker new powers.
 */

export interface McpServerConfig {
  /** The id the server is configured under, e.g. `github`. */
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
}

export interface McpInventory {
  /** Every tool the server advertises, in the order it advertised them. */
  tools: string[];
}

export interface McpInventoryProber {
  probe(server: McpServerConfig): Promise<McpInventory>;
}
