import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { Config } from "../../src/config.ts";
import { createCoworker } from "../../src/coworker.ts";
import type { McpServerConfig } from "../../src/ports/mcp.ts";
import {
  createMentionGateway,
  type AppMentionEvent,
  type Delivery,
} from "../../src/slack/mentions.ts";
import { FakeClock, FakeEngine, FakeInventoryProber, FakeSlack } from "./fakes.ts";

export const BOT_USER_ID = "U0COWORKER";
export const DEFAULT_THREAD_TS = "1700000000.000100";

export interface HarnessOptions {
  operatingManual?: string;
  mcpServers?: McpServerConfig[];
}

/**
 * The one seam, at the top.
 *
 * The coworker is constructed with its external edges injected — a fake Slack, a
 * scripted engine, a controllable clock, a fake MCP inventory prober — and a *real*
 * Vault directory in a temporary location, because ADR-0003's whole promise is that
 * a human can open that same directory in Obsidian.
 *
 * Mentions arrive as synthetic `app_mention` events through the real Slack
 * translation and the real dedupe, so what the tests drive is what Slack delivers.
 */
export async function coworkerHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-agent-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const vaultDir = path.join(root, "vault");
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(vaultDir, { recursive: true });

  const operatingManualPath = path.join(root, "operating-manual.md");
  await writeFile(
    operatingManualPath,
    options.operatingManual ?? "# Operating manual\n\nYou are a coworker in Slack.\n",
    "utf8",
  );

  const config: Config = {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    vaultDir,
    workspaceRoot,
    operatingManualPath,
    engine: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    mcpServers: options.mcpServers ?? [],
  };

  const clock = new FakeClock();
  const slack = new FakeSlack();
  const engine = new FakeEngine();
  const inventoryProber = new FakeInventoryProber();
  /** What a self-hoster would see at startup and in the instance's output. */
  const logs: string[] = [];
  const warnings: string[] = [];

  const coworker = createCoworker({
    config,
    slack,
    engine,
    clock,
    inventoryProber,
    log: {
      info: (message) => logs.push(message),
      warn: (message) => {
        logs.push(message);
        warnings.push(message);
      },
    },
  });

  const mentions = createMentionGateway({
    coworker,
    log: { info: (message) => logs.push(message), warn: (message) => warnings.push(message) },
  });

  let nextEvent = 1;

  /** A synthetic `app_mention` as Slack delivers it, with an envelope around it. */
  const appMention = (
    overrides: Partial<AppMentionEvent> & { eventId?: string } = {},
  ): { event: AppMentionEvent; envelope: { event_id: string } } => {
    const n = nextEvent++;
    const { eventId, ...event } = overrides;
    return {
      envelope: { event_id: eventId ?? `Ev${n}` },
      event: {
        channel: "C_GENERAL",
        thread_ts: DEFAULT_THREAD_TS,
        ts: `170000000${n}.000200`,
        user: "U_ASKER",
        text: `<@${BOT_USER_ID}> what is our deploy process?`,
        ...event,
      },
    };
  };

  /** Deliver a mention and wait for its Job to finish. */
  const mention = async (
    overrides: Partial<AppMentionEvent> & { eventId?: string } = {},
  ): Promise<Delivery> => {
    const { event, envelope } = appMention(overrides);
    const delivery = await mentions.deliver(event, envelope);
    if (delivery.accepted) await delivery.completed;
    return delivery;
  };

  /** Deliver a mention and return as soon as it has been acknowledged. */
  const startMention = (
    overrides: Partial<AppMentionEvent> & { eventId?: string } = {},
  ): Promise<Delivery> => {
    const { event, envelope } = appMention(overrides);
    return mentions.deliver(event, envelope);
  };

  return {
    vaultDir,
    workspaceRoot,
    operatingManualPath,
    clock,
    slack,
    engine,
    inventoryProber,
    logs,
    warnings,
    coworker,
    mention,
    startMention,
  };
}
