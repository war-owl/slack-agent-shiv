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
}

export interface McpInventory {
  /** Every tool the server advertises, in the order it advertised them. */
  tools: string[];
}

export interface McpInventoryProber {
  probe(server: McpServerConfig): Promise<McpInventory>;
}
