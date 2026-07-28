import { loadConfig } from "./config.ts";
import { createCoworker, type Logger } from "./coworker.ts";
import { createCodexEngine } from "./engine/codex.ts";
import { unimplementedInventoryProber } from "./mcp/prober.ts";
import { systemClock } from "./ports/clock.ts";
import { createSlackApp, slackClientFor, subscribeToMentions } from "./slack/gateway.ts";
import { createMentionGateway } from "./slack/mentions.ts";

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`WARNING: ${message}`),
};

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createSlackApp(config);

  const coworker = createCoworker({
    config,
    slack: slackClientFor(app),
    engine: await createCodexEngine(config.engine),
    clock: systemClock,
    inventoryProber: unimplementedInventoryProber,
    log,
  });

  // Before the first mention, not on it: a self-hoster should learn about a problem
  // at startup rather than from a Job that quietly did the wrong thing.
  await coworker.preflight();

  subscribeToMentions(app, createMentionGateway({ coworker, log }), log);
  await app.start();
  log.info(`Listening for @-mentions over Socket Mode. Vault: ${config.vaultDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
