import type { Config } from "../config.ts";
import { disabledToolsFor, unknownDisabledTools } from "../mcp/denylist.ts";
import {
  driftFailure,
  hasDrifted,
  inventoryDrift,
  inventoryFingerprint,
  unpinnedFailure,
} from "../mcp/inventory.ts";
import type { Logger } from "../ports/log.ts";
import type { McpInventoryProber, McpServerConfig } from "../ports/mcp.ts";

/**
 * The connector half of preflight: Linear, and anything a self-hoster adds.
 *
 * Three questions per server, and they are asked in this order because each is cheaper to
 * be wrong about than the next: is the credential there, does the tool surface match the
 * one a human reviewed, and which tools will Codex be told not to have.
 *
 * **A mismatch is fatal and a missing pin is fatal.** Everything else in preflight
 * describes an instance that will work; these two describe an instance whose action
 * boundary is not the one anybody agreed to. See `mcp/inventory.ts` for why detecting
 * change — rather than danger — is the achievable goal, and `mcp/denylist.ts` for what is
 * generated from the pin.
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
    // First, because a probe with no credential fails as a transport error and reads like
    // the server being down. The name of the missing variable is the whole answer.
    requireBearerToken(server, deps.env, deps.config.source);

    const inventory = await deps.inventoryProber.probe(server);

    if (server.pinnedTools.length === 0) throw new Error(unpinnedFailure(server, inventory));

    const drift = inventoryDrift(server.pinnedTools, inventory.tools);
    if (hasDrifted(drift)) throw new Error(driftFailure(server, inventory, drift));

    deps.log.info(
      `Connector ${server.name}: ${inventory.tools.length} tools, matching the pin ` +
        `(${inventoryFingerprint(inventory.tools)})`,
    );

    // Said out loud, every startup, because this is layer 2 and an operator should be able
    // to see it rather than infer it from a document. An empty list is worth saying too:
    // it means this server offers nothing the project considers irreversible, which is
    // information about the server rather than an omission.
    const disabled = disabledToolsFor(server);
    deps.log.info(
      disabled.length === 0
        ? `Connector ${server.name}: nothing disabled — it advertises no tool this project ` +
            "refuses the coworker."
        : `Connector ${server.name}: ${disabled.length} tool(s) disabled, so they do not ` +
            `exist from the coworker's point of view: ${disabled.join(", ")}`,
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

function requireBearerToken(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv,
  source: string,
): void {
  const token = env[server.bearerTokenEnvVar]?.trim();
  if (token === undefined || token === "") {
    throw new Error(
      `Connector "${server.name}" has no credential: ${source} says its bearer token is in ` +
        `${server.bearerTokenEnvVar}, and ${server.bearerTokenEnvVar} is not set. Set it in ` +
        ".env, or remove the connector — an instance that starts without it would fail on " +
        "the first Job that needed the connector, in a Thread, unattended.",
    );
  }
}
