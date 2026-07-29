import { RECORDED_CODEX_VERSION, type Config } from "./config.ts";
import type { Engine } from "./ports/engine.ts";
import type { Logger } from "./ports/log.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";

/**
 * What the instance checks before it accepts its first mention.
 *
 * Everything it finds goes to the log, because the log is what a self-hoster reads
 * at startup. Conditions that must not be survivable throw — ticket 08 adds the
 * first of those, a connector whose tool inventory no longer matches its pin.
 *
 * v1 ships **no version pin**: the instance runs against whatever Codex is
 * installed, records the version, and warns when it has drifted from the version
 * this project was tested against. That report is not optional — Codex ships
 * multiple alphas a day and has already removed flags a wrapper would plausibly
 * depend on, so "it broke overnight and nobody can see why" is the failure mode this
 * exists to make visible.
 */
export async function runPreflight(deps: {
  config: Config;
  engine: Engine;
  inventoryProber: McpInventoryProber;
  log: Logger;
}): Promise<void> {
  const engineVersion = await deps.engine.version();
  deps.log.info(`Codex version ${engineVersion} (recorded: ${RECORDED_CODEX_VERSION})`);
  if (engineVersion !== RECORDED_CODEX_VERSION) {
    deps.log.warn(
      `The installed Codex is ${engineVersion}, but this project was built and tested ` +
        `against ${RECORDED_CODEX_VERSION}. v1 pins no version, so the instance will run ` +
        "anyway — but if it behaves strangely, this is the first thing to suspect. " +
        "Run `pnpm test:contract` to check the engine still behaves as expected.",
    );
  }

  // Reported because they are the wrapper's alone — the engine has no ceiling of its
  // own — and because a self-hoster who has lowered one wants to see that it took.
  const bounds = deps.config.bounds;
  deps.log.info(
    `Bounds: ${Math.round(bounds.turnTimeoutMs / 1000)}s per Turn, ` +
      `${bounds.maxTurnsPerJob} Turns per Job, ` +
      `${bounds.tokenBudgetPerJob} tokens per Job. A Job that hits one is stopped.`,
  );

  for (const server of deps.config.mcpServers) {
    const inventory = await deps.inventoryProber.probe(server);
    deps.log.info(
      `Connector ${server.name} advertises ${inventory.tools.length} tools: ` +
        inventory.tools.join(", "),
    );

    // A tool named as a Write that the server does not have is a typo, and its cost is
    // silence: every use of the tool that was *meant* would go unrecorded in the Thread.
    // Cheap to catch here, since the inventory has just been fetched anyway.
    const unknown = server.writeTools.filter((tool) => !inventory.tools.includes(tool));
    if (unknown.length > 0) {
      deps.log.warn(
        `Connector ${server.name} is configured with writeTools it does not advertise: ` +
          `${unknown.join(", ")}. Nothing uses those names, so check the spelling — a ` +
          "tool that writes but is not listed leaves no record in the Thread when it does.",
      );
    }
  }
}
