import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";
import { BOUND_DEFAULTS, type Config } from "../../src/config.ts";
import { NOTES_DIRNAME, SKILLS_DIRNAME } from "../../src/vault/skills.ts";
import { createCoworker, type Coworker } from "../../src/coworker.ts";
import type { SessionStore } from "../../src/ports/sessions.ts";
import { openSessionStore, sessionStoreFile } from "../../src/sessions/store.ts";
import {
  createMentionGateway,
  type AppMentionEvent,
  type Delivery,
} from "../../src/slack/mentions.ts";
import { FakeClock, FakeEngine, FakeInventoryProber, FakeSlack } from "./fakes.ts";
import { testTempDir } from "./test-root.ts";

export const BOT_USER_ID = "U0COWORKER";
export const DEFAULT_THREAD_TS = "1700000000.000100";

export interface HarnessOptions {
  operatingManual?: string;
  mcpServers?: Config["mcpServers"];
  /** Overrides on the shipped defaults, so a test can name only the bound it is about. */
  bounds?: Partial<Config["bounds"]>;
  /**
   * Reuse an existing temporary root instead of making a new one. This is how a
   * process restart is modelled: same directories on disk, everything in memory gone.
   */
  root?: string;
  /**
   * Put the Skills somewhere other than beside the Notes.
   *
   * Only the tests for the startup checks want this: the point of those checks is that
   * every arrangement other than the sibling one voids the authorship rule, so testing
   * them means building an instance that is wrong on purpose.
   */
  skillsDir?: string;
}

export interface CoworkerHarness {
  /** The temporary directory holding everything this instance keeps on disk. */
  root: string;
  notesDir: string;
  /** The read-only half of the Vault. A test writes here as the *human* would. */
  skillsDir: string;
  workspaceRoot: string;
  stateDir: string;
  operatingManualPath: string;
  clock: FakeClock;
  slack: FakeSlack;
  engine: FakeEngine;
  sessions: SessionStore;
  inventoryProber: FakeInventoryProber;
  /** What a self-hoster would see in the instance's output. */
  logs: string[];
  warnings: string[];
  coworker: Coworker;
  /** Deliver a mention and wait for its Job to finish. */
  mention(overrides?: MentionOverrides): Promise<Delivery>;
  /** Deliver a mention and return as soon as it has been acknowledged. */
  startMention(overrides?: MentionOverrides): Promise<Delivery>;
  /**
   * The instance stopped and started again: the same directories on disk, and nothing
   * carried over in memory — a new engine, a new Slack client, and a Session store
   * reopened from the file the previous process left behind.
   */
  restart(): Promise<CoworkerHarness>;
}

type MentionOverrides = Partial<AppMentionEvent> & { eventId?: string };

/**
 * The one seam, at the top.
 *
 * The coworker is constructed with its external edges injected — a fake Slack, a
 * scripted engine, a controllable clock, a fake MCP inventory prober — and *real*
 * files in a temporary location for the two things whose promise is about files: the
 * Vault, which ADR-0003 says a human can open in Obsidian, and the Session store,
 * whose whole claim is that it survives a restart.
 *
 * Mentions arrive as synthetic `app_mention` events through the real Slack
 * translation and the real dedupe, so what the tests drive is what Slack delivers.
 */
export async function coworkerHarness(options: HarnessOptions = {}): Promise<CoworkerHarness> {
  const root = options.root ?? (await testTempDir("open-agent-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  // The Obsidian vault, and its two halves. Siblings rather than one directory because
  // that split *is* the write boundary on Skills — see `src/vault/skills.ts` — so a
  // harness that flattened it would be testing an instance nobody runs.
  const obsidianDir = path.join(root, "vault");
  const notesDir = path.join(obsidianDir, NOTES_DIRNAME);
  const skillsDir = options.skillsDir ?? path.join(obsidianDir, SKILLS_DIRNAME);
  const workspaceRoot = path.join(root, "workspaces");
  const stateDir = path.join(root, "state");
  await mkdir(notesDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  const operatingManualPath = path.join(root, "operating-manual.md");
  await writeFile(
    operatingManualPath,
    options.operatingManual ?? "# Operating manual\n\nYou are a coworker in Slack.\n",
    "utf8",
  );

  const config: Config = {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    notesDir,
    skillsDir,
    workspaceRoot,
    stateDir,
    operatingManualPath,
    engine: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    // The shipped defaults unless a test says otherwise: a bound test that invented
    // its own numbers would pass while the numbers a self-hoster actually runs with
    // went untested.
    bounds: { ...BOUND_DEFAULTS, ...options.bounds },
    mcpServers: options.mcpServers ?? [],
  };

  // A real file, like the Vault: "the mapping survives a restart" is a claim about
  // disk, and an in-memory double would let it pass without being true.
  const sessions = await openSessionStore({ filePath: sessionStoreFile(stateDir) });

  const clock = new FakeClock();
  // Stamped by the same clock the coworker uses, so "refreshed inside two minutes" is
  // measurable rather than a guess about wall-clock timing.
  const slack = new FakeSlack(clock);
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
    sessions,
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
    overrides: MentionOverrides = {},
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
    overrides: MentionOverrides = {},
  ): Promise<Delivery> => {
    const { event, envelope } = appMention(overrides);
    const delivery = await mentions.deliver(event, envelope);
    if (delivery.accepted) await delivery.completed;
    return delivery;
  };

  /** Deliver a mention and return as soon as it has been acknowledged. */
  const startMention = (
    overrides: MentionOverrides = {},
  ): Promise<Delivery> => {
    const { event, envelope } = appMention(overrides);
    return mentions.deliver(event, envelope);
  };

  return {
    root,
    notesDir,
    skillsDir,
    workspaceRoot,
    stateDir,
    operatingManualPath,
    clock,
    slack,
    engine,
    sessions,
    inventoryProber,
    logs,
    warnings,
    coworker,
    mention,
    startMention,
    restart: () => coworkerHarness({ ...options, root }),
  };
}
