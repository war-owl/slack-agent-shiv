import { loadConfig } from "./config.ts";
import { createCoworker } from "./coworker.ts";
import { createCodexEngine } from "./engine/codex.ts";
import { createGitHubRepositoryProtectionProbe } from "./github/protection.ts";
import { createMcpInventoryProber } from "./mcp/prober.ts";
import { systemClock } from "./ports/clock.ts";
import type { Logger } from "./ports/log.ts";
import { openSessionStore, sessionStoreFile } from "./sessions/store.ts";
import { createSlackApp, slackClientFor, subscribeToMentions } from "./slack/gateway.ts";
import { createMentionGateway } from "./slack/mentions.ts";

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`WARNING: ${message}`),
};

async function main(): Promise<void> {
  const config = await loadConfig();
  const app = createSlackApp(config);
  const githubTokenVariable = config.repositoryProtectionTokenEnvVar;
  const githubToken =
    githubTokenVariable === undefined ? undefined : process.env[githubTokenVariable]?.trim();

  const coworker = createCoworker({
    config,
    slack: slackClientFor(app, config.slack.botToken),
    // The connectors reach the engine as *generated Codex configuration*, deny-list
    // included — the wrapper is not in the tool path (ADR-0005), so this is the only way
    // layer 2 exists at all.
    engine: await createCodexEngine({ ...config.engine, mcpServers: config.mcpServers }),
    clock: systemClock,
    sessions: await openSessionStore({ filePath: sessionStoreFile(config.stateDir) }),
    // One credential store, handed to everything that reads one — so the check and the thing
    // it checks cannot end up reading different environments.
    inventoryProber: createMcpInventoryProber(process.env),
    repositoryProtection:
      githubToken === undefined || githubToken === ""
        ? {
            check: async (repository) => {
              throw new Error(
                `Repository ${repository} is configured, but the enabled GitHub MCP ` +
                  "connector does not name a usable bearer token. Branch protection cannot " +
                  "be verified.",
              );
            },
          }
        : createGitHubRepositoryProtectionProbe({ token: githubToken }),
    env: process.env,
    log,
  });

  // Before the first mention, not on it: a self-hoster should learn about a problem
  // at startup rather than from a Job that quietly did the wrong thing.
  await coworker.preflight();

  subscribeToMentions(app, createMentionGateway({ coworker, log }), log);
  await app.start();
  log.info(`Listening for @-mentions over Socket Mode. Vault: ${config.notesDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
