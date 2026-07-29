/**
 * Connectors are MCP servers named in configuration (ADR-0005) — there is no
 * plugin interface. The wrapper is not in the tool path; the only thing it does
 * with a connector is *probe* it at startup, so that a server which quietly grew a
 * tool fails loudly instead of silently granting the coworker new powers.
 */

interface McpServerPolicy {
  /** The id the server is configured under, e.g. `linear`. */
  name: string;
  /** Disabled servers remain in mcp.json but are neither probed nor exposed to Codex. */
  enabled: boolean;
  /**
   * Which of this server's tools act on the world rather than read it, so that every
   * use of one is appended to the Thread as a permanent record.
   *
   * Configuration rather than code, like the rest of a connector (ADR-0005) — the
   * wrapper is not in the tool path and has no way to tell a read from a write by
   * looking. A tool nobody listed here is a tool whose use leaves no trace, which
   * is why each server owns its own list rather than inheriting a guess.
   */
  writeTools: readonly string[];
  /**
   * Tools to disable **in addition** to the ones the wrapper denies on its own.
   *
   * The floor is generated rather than configured (`mcp/denylist.ts`): a self-hoster
   * cannot forget to block the irreversible ones, and cannot mistype them either. This is
   * for a judgement the project has not made — a tool a particular workspace does not want
   * its coworker calling.
   */
  disabledTools: readonly string[];
  /** Passed through to Codex when set. */
  startupTimeoutSec?: number | undefined;
  /** Passed through to Codex when set. */
  toolTimeoutSec?: number | undefined;
}

export interface McpHttpServerConfig extends McpServerPolicy {
  transport: "http";
  /** A Streamable HTTP MCP endpoint. */
  url: string;
  /** The environment variable holding the bearer token. Never the token itself. */
  bearerTokenEnvVar?: string | undefined;
  /** Non-secret fixed headers. */
  httpHeaders: Readonly<Record<string, string>>;
  /** Header name to environment-variable name. */
  envHttpHeaders: Readonly<Record<string, string>>;
}

export interface McpStdioServerConfig extends McpServerPolicy {
  transport: "stdio";
  command: string;
  args: readonly string[];
  /** Non-secret fixed environment values. */
  env: Readonly<Record<string, string>>;
  /** Environment-variable names to forward without putting their values in configuration. */
  envVars: readonly string[];
  cwd?: string | undefined;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export interface McpInventory {
  /** Every tool the server advertises, in the order it advertised them. */
  tools: string[];
}

export interface McpInventoryProber {
  probe(server: McpServerConfig): Promise<McpInventory>;
}
