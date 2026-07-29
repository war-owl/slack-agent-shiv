import type { Config } from "../config.ts";
import { disabledToolsFor, unknownDisabledTools } from "../mcp/denylist.ts";
import type { Logger } from "../ports/log.ts";
import type { McpInventoryProber, McpServerConfig } from "../ports/mcp.ts";

/**
 * The connector half of preflight: Linear, and anything a self-hoster adds.
 *
 * Three questions per server: can its environment be resolved, can the server be reached,
 * and which tools will Codex be told not to have. Tool inventories are observed rather
 * than pinned: servers may add or remove tools without turning an otherwise healthy
 * instance into an outage.
 */
export async function checkConnectors(deps: {
  config: Config;
  inventoryProber: McpInventoryProber;
  log: Logger;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (deps.config.mcpServers.length === 0) {
    deps.log.info(
      "Connectors: none configured. The coworker reaches Slack and its Vault, and nothing " +
        "else over MCP.",
    );
    return;
  }

  for (const server of deps.config.mcpServers) {
    if (!server.enabled) {
      deps.log.info(`Connector ${server.name}: disabled in ${deps.config.mcpConfigSource}`);
      continue;
    }
    // First, because a probe with no credential fails as a transport error and reads like
    // the server being down. The name of the missing variable is the whole answer.
    requireEnvironment(server, deps.env, deps.config.mcpConfigSource);

    if (server.transport === "stdio") {
      deps.log.warn(
        `Connector ${server.name} starts a local process: ${server.command} ${server.args.join(
          " ",
        )}. A stdio MCP server is executable software; pin its package version and review it.`,
      );
    }

    const inventory = await deps.inventoryProber.probe(server);

    deps.log.info(
      `Connector ${server.name}: ${inventory.tools.length} tools available; inventory ` +
        "changes are allowed.",
    );

    // Said out loud, every startup, because this is layer 2 and an operator should be able
    // to see it rather than infer it from a document.
    const disabled = disabledToolsFor(server);
    deps.log.info(
      `Connector ${server.name}: ${disabled.length} exact tool name(s) disabled: ` +
        disabled.join(", "),
    );

    // A tool named as a Write that the server does not have is a typo, and its cost is
    // silence: every use of the tool that was *meant* would go unrecorded in the Thread.
    // Cheap to catch here, since the inventory has just been fetched anyway.
    const unknownWrites = server.writeTools.filter((tool) => !inventory.tools.includes(tool));
    if (unknownWrites.length > 0) {
      deps.log.warn(
        `Connector ${server.name} is configured with writeTools it does not advertise: ` +
          `${unknownWrites.join(", ")}. Nothing uses those names, so check the spelling — a ` +
          "tool that writes but is not listed leaves no record in the Thread when it does.",
      );
    }

    const unknownDisabled = unknownDisabledTools(server, inventory.tools);
    if (unknownDisabled.length > 0) {
      deps.log.warn(
        `Connector ${server.name} is configured to disable tools it does not advertise: ` +
          `${unknownDisabled.join(", ")}. Harmless, and worth checking: somebody wrote those ` +
          "names believing they were a boundary.",
      );
    }
  }
}

function requireEnvironment(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv,
  source: string,
): void {
  const variables =
    server.transport === "http"
      ? [
          ...(server.bearerTokenEnvVar === undefined ? [] : [server.bearerTokenEnvVar]),
          ...Object.values(server.envHttpHeaders),
        ]
      : server.envVars;
  const missing = [...new Set(variables)].filter((variable) => !env[variable]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Connector "${server.name}" cannot resolve ${missing.join(", ")}: ${source} names ` +
        `${missing.length === 1 ? "that environment variable" : "those environment variables"}, ` +
        "but they are not set. Set them in .env, disable the connector, or remove it — an " +
        "instance that starts without them would fail on the first unattended Job that needs it.",
    );
  }
}
