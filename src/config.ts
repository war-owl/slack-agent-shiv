import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { McpServerConfig } from "./ports/mcp.ts";
import { NOTES_DIRNAME, SKILLS_DIRNAME } from "./vault/skills.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Configuration: one file, and secrets in the environment.
 *
 * **The file holds no credentials — it holds their names.** A connector says which
 * environment variable carries its bearer token, exactly as a Skill does (CONTEXT.md:
 * "A Skill names an environment variable where a credential is needed; it never contains
 * one"), and for the same reason: this file describes an instance and is safe to commit,
 * diff, and paste into an issue. What must not be committed lives in `.env`, which is not
 * configuration — it is the keyring.
 *
 * **The environment configures nothing else.** Two sources for one setting is how an
 * instance ends up running with bounds nobody wrote down, so the paths, the bounds, the
 * model, and the connectors come from the file and only the file. The single exception is
 * `CONFIG_PATH`, which says where the file is and cannot itself live in it.
 *
 * Relative paths in the file resolve against the file's own directory, so a checkout that
 * moves stays configured.
 */

/**
 * The Codex version this project was built and tested against.
 *
 * v1 deliberately ships **no version pin** — the instance runs against whatever is
 * installed. This constant is the *recorded* version: startup reports what is
 * actually installed and warns when it has drifted from this. Codex ships multiple
 * alphas a day and has already removed flags a wrapper would plausibly depend on,
 * so the report is not optional even though the pin does not exist.
 */
export const RECORDED_CODEX_VERSION = "0.145.0";

/**
 * And the `gh` version, on the same terms.
 *
 * [ADR-0006](../docs/adr/0006-github-is-a-skill-over-gh.md) moved GitHub out of the MCP
 * tool path and into a Skill over the `gh` CLI, which turned GitHub capability into a
 * **CLI dependency** — a program somebody else upgrades, on somebody else's schedule,
 * that this project's Skills issue commands to. That drifts the way Codex does, so it is
 * reported the way Codex is: warn on difference, run anyway. What it is not is a floor;
 * `gh` is stable in a way Codex is not, and refusing to start over a minor version would
 * be a lock-out with nothing behind it.
 */
export const RECORDED_GH_VERSION = "2.96.0";

/**
 * Codex's `project_doc_max_bytes` default. Past this it stops adding instruction
 * files — silently. The wrapper warns rather than truncating, because a silently
 * shortened operating manual is a coworker that quietly stops following half of it.
 */
export const OPERATING_MANUAL_MAX_BYTES = 32 * 1024;

/** Where the configuration file lives unless `CONFIG_PATH` says otherwise. */
export const DEFAULT_CONFIG_FILENAME = "open-agent.config.json";

/**
 * The bounds, and why these numbers.
 *
 * Codex supplies none of this — it reports usage after the fact and offers no
 * ceiling, no max-Turns and no kill switch — so every one of these is the wrapper's,
 * and the default is what almost every self-hoster will actually run with. The brief
 * is that a runaway Job is an annoyance rather than a bill, without making
 * "delegate and walk away" into a three-minute timeout.
 */
export const BOUND_DEFAULTS = {
  /**
   * An hour on one Turn.
   *
   * Under `exec` a Job is normally **one** Turn, so this is in practice the ceiling
   * on a whole Job — and the product promise is work that takes "minutes or hours".
   * Ten minutes would be a wedge detector that also killed real work.
   *
   * **Which makes this the only bound on a single runaway Turn, and an hour of one is
   * not nothing.** Usage arrives at turn completion and nowhere else, so the budget
   * below cannot stop a Turn that is already spending — it can only refuse the next
   * one. If an hour of unattended spend is not acceptable, this is the number to
   * lower, and lowering it costs long Jobs rather than safety.
   */
  turnTimeoutMs: 60 * 60 * 1000,
  /**
   * Eight Turns.
   *
   * A Job is one Turn today, and gains a second when the Librarian pass arrives. The
   * cap is not tuned to that: it exists so that a Job which has started looping has
   * somewhere to stop, and eight is far enough above any legitimate shape that
   * hitting it is information.
   */
  maxTurnsPerJob: 8,
  /**
   * A million tokens across the Job.
   *
   * Counted exactly as the engine reports them, cached input included. That
   * over-counts against price — cached input is roughly a tenth the cost — and it is
   * deliberately the safe direction for a bound to be wrong in. This is a ceiling on
   * volume, not a budget in currency, and the instance cannot compute the latter: it
   * does not know the price of the model it was pointed at.
   */
  tokenBudgetPerJob: 1_000_000,
  /**
   * Four Jobs at once, across the whole instance.
   *
   * The other three bounds are each a bound on *one* Job; this is the one that answers
   * for the instance, because ten Threads mentioning the coworker at the same time is
   * otherwise ten subprocesses and ten of every budget above.
   *
   * Four rather than a round ten because Slack sets the ceiling before the machine
   * does. A Job's status message can be rewritten up to twelve times a minute
   * (`STATUS_POLL_MS` in `reporter/status.ts`) and `chat.update` is Tier 3 — roughly 50
   * a minute, **per app rather than per Job** — so four churning Jobs sit just inside
   * the limit and five do not. It is also about as many Codex subprocesses as a
   * self-hoster's laptop will run without noticing.
   *
   * Unlike the three above, no Job can see this one: it is enforced by the queue, which
   * decides *whether* a Job runs, not by the bounds, which decide when one has run for
   * too long. It sits in the same group because it is the same question for whoever is
   * writing the configuration — what will this instance let itself do.
   */
  maxConcurrentJobs: 4,
  /**
   * Five minutes for the Librarian's closing pass.
   *
   * Its own bound, and much shorter than a Turn's, because it is doing something small
   * and known: search the Vault, decide, write at most one Note. A pass still going after
   * five minutes is not being thorough — it is reorganising the library, or looping.
   *
   * The reason it needs a bound of its own at all is that it is best-effort. Every other
   * bound here protects the human from spend; this one protects the *Job* from its own
   * curation, because the work is already finished and reported by the time this runs and
   * a slow pass would hold the Thread's next Job behind a tidy-up nobody asked about.
   * Expiring abandons the pass and never fails the Job.
   */
  librarianTimeoutMs: 5 * 60 * 1000,
} as const;

const boundsSchema = z.object({
  /** Wall clock on a single Turn. Expiring hard-kills the engine's process. */
  turnTimeoutMs: z.number().int().positive(),
  /** How many Turns one Job may run before it is stopped. */
  maxTurnsPerJob: z.number().int().positive(),
  /** Cumulative tokens across the Job, accumulated from turn-completion usage. */
  tokenBudgetPerJob: z.number().int().positive(),
  /** How many Jobs may run at once across every Thread. The one instance-wide bound. */
  maxConcurrentJobs: z.number().int().positive(),
  /** Wall clock on the Librarian's closing pass. Expiring abandons it, silently to Slack. */
  librarianTimeoutMs: z.number().int().positive(),
});

export type Bounds = z.infer<typeof boundsSchema>;

/**
 * The GitHub App, as the instance resolves it.
 *
 * Absent means GitHub is simply not configured: the coworker has no `gh` credential and
 * the Skill that drives it will not work, which is a legitimate way to run this — a
 * Slack-and-Vault coworker with no repository at all.
 */
export interface GitHubAppConfig {
  appId: string;
  /** The PEM itself, read at startup from the file the environment names. Never logged. */
  privateKeyPem: string;
  /** Where it was read from, so a startup failure can name the file rather than the key. */
  privateKeyPath: string;
  /**
   * Which account's installation to use, when the App is installed on more than one.
   *
   * Optional because the common case is one installation, and asking a self-hoster to
   * name it would be asking them to repeat what GitHub already knows.
   */
  owner?: string | undefined;
  /**
   * Repositories this instance expects to work in, as `owner/name`.
   *
   * **Not an allow-list** — it cannot be one, because nothing of ours is in the path
   * between the coworker and `gh` (ADR-0006). It is a *statement of intent*, and preflight
   * compares it against what the installation actually grants: a repository named here and
   * missing there is the likeliest setup mistake on this path, and one that would otherwise
   * surface as a Job failing to find a repository a human is certain it has.
   *
   * Empty means "whatever the installation grants", reported at startup either way.
   */
  repositories: readonly string[];
}

export interface Config {
  /** Where this configuration came from, in words, for the startup line. */
  source: string;
  slack: {
    botToken: string;
    appToken: string;
  };
  /**
   * The Vault's **Notes** — the half the coworker writes, and the only directory outside
   * a Job's own workspace that the engine is given write access to.
   *
   * A subdirectory of the Obsidian vault rather than the whole of it, because its sibling
   * {@link skillsDir} has to be readable and *not* writable and the sandbox grants by
   * directory tree: there is no carving a read-only hole out of a writable root. The
   * parent holds both, and the parent is what a human opens in Obsidian — so wikilinks
   * resolve from a Note to a Skill and back, in one vault.
   */
  notesDir: string;
  /**
   * The Vault's **Skills** — procedures a human wrote down, which the coworker follows
   * and cannot edit.
   *
   * Passed to the engine as writable nowhere, which is the entire enforcement mechanism
   * (ADR-0004 as amended; see `vault/skills.ts`). It must be a sibling of
   * {@link notesDir} rather than inside it, and it must not sit in a temporary directory,
   * because `workspace-write` grants those unconditionally. Both are checked at startup
   * and both are fatal — an instance whose Skills are agent-writable is not the instance
   * the documentation describes.
   */
  skillsDir: string;
  /** Where per-Thread Job workspaces are created. The sandbox's writable root. */
  workspaceRoot: string;
  /**
   * The wrapper's own durable state — which is only the Session mapping. Deliberately
   * outside the Vault and outside every workspace: the Vault is the human's, and a
   * workspace is writable by the agent, which must not be able to rewrite which
   * Session another Thread resumes into.
   */
  stateDir: string;
  /** The shipped operating manual, copied into every Job's workspace as `AGENTS.md`. */
  operatingManualPath: string;
  engine: {
    model: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
    /** Left unset, the `codex` on `PATH` is used, falling back to the vendored one. */
    codexPath?: string | undefined;
  };
  /**
   * What stops a Job that does not stop by itself, and how many may run at once. See
   * {@link BOUND_DEFAULTS}.
   */
  bounds: Bounds;
  /** The GitHub App, or nothing. See {@link GitHubAppConfig}. */
  github?: GitHubAppConfig | undefined;
  /** Connectors, as MCP server configuration (ADR-0005). */
  mcpServers: readonly McpServerConfig[];
}

/**
 * The configuration file, as it is written.
 *
 * `.strict()` throughout, and that is a decision rather than a default: a misspelled key
 * that parsed and did nothing would be an instance running with a bound its operator
 * believes they set. Every unknown key is named and refused.
 */
const connectorSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    bearerTokenEnvVar: z.string().min(1),
    /**
     * The tools on this server that act on the world. See `McpServerConfig`.
     *
     * Required rather than defaulted to empty. An absent list means every Write
     * through this connector leaves no trace, which is not a thing to fall into by
     * omission — naming them (or naming none, deliberately) is part of configuring a
     * connector, like pinning its inventory.
     */
    writeTools: z.array(z.string().min(1)),
    /** The reviewed inventory. Preflight refuses to start without one. */
    pinnedTools: z.array(z.string().min(1)).default([]),
    /** Extra tools to disable, on top of the ones the wrapper denies anyway. */
    disabledTools: z.array(z.string().min(1)).default([]),
  })
  .strict();

const configFileSchema = z
  .object({
    slack: z
      .object({
        botTokenEnvVar: z.string().min(1).default("SLACK_BOT_TOKEN"),
        appTokenEnvVar: z.string().min(1).default("SLACK_APP_TOKEN"),
      })
      .strict()
      // `prefault` rather than `default`: an absent section is parsed as `{}` and picks up
      // each field's own default, so "no `engine` section" and "an empty one" agree.
      .prefault({}),
    vault: z
      .object({
        /** The Notes. Its parent is the directory a human opens in Obsidian. */
        notes: z.string().min(1).optional(),
        /** The Skills. Defaults to a sibling of the Notes — see `vault/skills.ts`. */
        skills: z.string().min(1).optional(),
      })
      .strict()
      // `prefault` rather than `default`: an absent section is parsed as `{}` and picks up
      // each field's own default, so "no `engine` section" and "an empty one" agree.
      .prefault({}),
    workspaceRoot: z.string().min(1).optional(),
    stateDir: z.string().min(1).optional(),
    operatingManual: z.string().min(1).optional(),
    engine: z
      .object({
        model: z.string().min(1).optional(),
        reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
        codexPath: z.string().min(1).optional(),
      })
      .strict()
      // `prefault` rather than `default`: an absent section is parsed as `{}` and picks up
      // each field's own default, so "no `engine` section" and "an empty one" agree.
      .prefault({}),
    bounds: boundsSchema.partial().strict().prefault({}),
    github: z
      .object({
        appIdEnvVar: z.string().min(1).default("GITHUB_APP_ID"),
        privateKeyPathEnvVar: z.string().min(1).default("GITHUB_APP_PRIVATE_KEY_PATH"),
        owner: z.string().min(1).optional(),
        repositories: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    connectors: z.array(connectorSchema).default([]),
  })
  .strict();

export type ConfigFile = z.input<typeof configFileSchema>;

/**
 * Read the configuration.
 *
 * Order of business: find the file, parse it, resolve the paths against it, then resolve
 * the credentials it names out of the environment. Anything wrong at any step throws with
 * the file, the key, and the environment variable named — a startup message is read by
 * somebody who has just typed something wrong, and the useful message is the one that says
 * which thing.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const found = await findConfigFile(env);
  const parsed = configFileSchema.safeParse(found.contents);
  if (!parsed.success) {
    throw new Error(
      `${found.source} is not valid configuration, so the instance is stopping now rather ` +
        `than on the first mention:\n${problemsIn(parsed.error)}\n\n` +
        "See docs/configuration.md, and open-agent.config.example.json for a worked example.",
    );
  }

  const file = parsed.data;
  // Relative to the file rather than to the process's working directory: `./vault/Notes`
  // in a configuration file means next to that file, which is what someone reading it
  // would assume and what survives being started from a different directory.
  const from = (given: string): string => path.resolve(found.directory, given);

  // `notes` rather than `vault`, because it names the Notes half rather than the vault: the
  // vault is what a human opens in Obsidian and it holds Skills too.
  const notesDir = file.vault.notes === undefined ? defaults.notesDir : from(file.vault.notes);

  return {
    source: found.source,
    slack: {
      botToken: credential(env, file.slack.botTokenEnvVar, found.source, "Slack bot token"),
      appToken: credential(env, file.slack.appTokenEnvVar, found.source, "Slack app token"),
    },
    notesDir,
    // Next to the Notes rather than at the shipped default, when only one of the two has
    // been moved. Someone who points the Notes at their own Obsidian vault means their
    // Skills to be there too — leaving them at `<repo>/vault/Skills` would be an empty
    // directory the coworker is told about and a real one nobody reads. The sibling
    // relationship is the layout the write boundary depends on, so it is what a partial
    // configuration falls back to.
    skillsDir:
      file.vault.skills === undefined
        ? path.join(path.dirname(notesDir), SKILLS_DIRNAME)
        : from(file.vault.skills),
    workspaceRoot:
      file.workspaceRoot === undefined ? defaults.workspaceRoot : from(file.workspaceRoot),
    stateDir: file.stateDir === undefined ? defaults.stateDir : from(file.stateDir),
    operatingManualPath:
      file.operatingManual === undefined
        ? defaults.operatingManualPath
        : from(file.operatingManual),
    engine: {
      model: file.engine.model ?? defaults.model,
      reasoningEffort: file.engine.reasoningEffort ?? defaults.reasoningEffort,
      codexPath: file.engine.codexPath === undefined ? undefined : from(file.engine.codexPath),
    },
    // Named one by one rather than spread over the defaults, so that a bound left out of the
    // file is the shipped number and a bound written into it is exactly what was written.
    bounds: {
      turnTimeoutMs: file.bounds.turnTimeoutMs ?? BOUND_DEFAULTS.turnTimeoutMs,
      maxTurnsPerJob: file.bounds.maxTurnsPerJob ?? BOUND_DEFAULTS.maxTurnsPerJob,
      tokenBudgetPerJob: file.bounds.tokenBudgetPerJob ?? BOUND_DEFAULTS.tokenBudgetPerJob,
      maxConcurrentJobs: file.bounds.maxConcurrentJobs ?? BOUND_DEFAULTS.maxConcurrentJobs,
      librarianTimeoutMs: file.bounds.librarianTimeoutMs ?? BOUND_DEFAULTS.librarianTimeoutMs,
    },
    github:
      file.github === undefined
        ? undefined
        : await gitHubAppFrom(file.github, env, found.source, from),
    mcpServers: file.connectors,
  };
}

interface FoundConfig {
  /** Named in messages: the file's path, or why there is no file. */
  source: string;
  /** What relative paths inside it resolve against. */
  directory: string;
  contents: unknown;
}

/**
 * The configuration file, or the shipped defaults.
 *
 * A missing file at the default location is **fine** — it is the walking skeleton's
 * shape, a Slack bot with a Vault and no connectors, and requiring an empty file to say so
 * would be ceremony. A missing file at a path somebody *named* is not: they said where it
 * was, and quietly running defaults instead would hide the typo in the one place it
 * matters.
 */
async function findConfigFile(env: NodeJS.ProcessEnv): Promise<FoundConfig> {
  const named = env.CONFIG_PATH?.trim();
  const filePath = path.resolve(named === undefined || named === "" ? defaultConfigPath : named);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (named !== undefined && named !== "") {
      throw new Error(
        `CONFIG_PATH names ${filePath}, which cannot be read: ${reasonFor(error)}. Nothing ` +
          "was assumed in its place — an instance running the defaults when it was told to " +
          "run something else is worse than one that does not start.",
      );
    }
    return {
      source: `the shipped defaults (no ${DEFAULT_CONFIG_FILENAME})`,
      directory: repoRoot,
      contents: {},
    };
  }

  try {
    return { source: filePath, directory: path.dirname(filePath), contents: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${reasonFor(error)}`);
  }
}

/**
 * One credential, out of the environment variable the configuration file named.
 *
 * The message names both halves — the variable and the file that asked for it — because
 * either could be the mistake, and the reader cannot tell which from "SLACK_BOT_TOKEN is
 * not set" alone.
 */
function credential(
  env: NodeJS.ProcessEnv,
  variable: string,
  source: string,
  what: string,
): string {
  const value = env[variable]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `The ${what} is missing: ${source} says it is in ${variable}, and ${variable} is not ` +
        "set. The instance is stopping now rather than failing on the first mention. " +
        "Credentials belong in .env (see .env.example), never in the configuration file.",
    );
  }
  return value;
}

/** The App's id and private key, resolved the same way and reported the same way. */
async function gitHubAppFrom(
  file: {
    appIdEnvVar: string;
    privateKeyPathEnvVar: string;
    owner?: string | undefined;
    repositories: string[];
  },
  env: NodeJS.ProcessEnv,
  source: string,
  from: (given: string) => string,
): Promise<GitHubAppConfig> {
  const appId = credential(env, file.appIdEnvVar, source, "GitHub App id");
  // A path in the environment rather than the key itself, because what GitHub hands you is
  // a `.pem` file download: asking for a multi-line PEM inside a `.env` is asking for a
  // credential to be mangled by quoting, and every mangling looks like a signing bug.
  const privateKeyPath = from(
    credential(env, file.privateKeyPathEnvVar, source, "GitHub App private key path"),
  );
  let privateKeyPem: string;
  try {
    privateKeyPem = await readFile(privateKeyPath, "utf8");
  } catch (error) {
    throw new Error(
      `The GitHub App private key cannot be read from ${privateKeyPath} (named by ` +
        `${file.privateKeyPathEnvVar}): ${reasonFor(error)}`,
    );
  }
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error(
      `${privateKeyPath} does not look like a private key — GitHub's download is a PEM file ` +
        'beginning "-----BEGIN RSA PRIVATE KEY-----". Nothing of its contents is logged, so ' +
        "check the file itself.",
    );
  }
  return {
    appId,
    privateKeyPem,
    privateKeyPath,
    owner: file.owner,
    repositories: file.repositories,
  };
}

function problemsIn(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultConfigPath = path.join(repoRoot, DEFAULT_CONFIG_FILENAME);

const defaults = {
  /**
   * `vault/` is the Obsidian vault; `Notes` and `Skills` are its two halves.
   *
   * The split is not organisational — it is the write boundary. Skills are not listed
   * here because they are derived from this: they sit next to the Notes unless the
   * configuration file says otherwise. See {@link Config}'s `skillsDir`, and
   * `vault/skills.ts` for why it cannot be one directory.
   */
  notesDir: path.join(repoRoot, "vault", NOTES_DIRNAME),
  workspaceRoot: path.join(repoRoot, ".workspaces"),
  stateDir: path.join(repoRoot, ".state"),
  operatingManualPath: path.join(repoRoot, "assets", "operating-manual.md"),
  model: "gpt-5.6-sol",
  // `low` is the right default for cost and latency across the many shallow Jobs.
  // If considered answers come back thin, this is the first dial to turn.
  reasoningEffort: "low",
} as const;
