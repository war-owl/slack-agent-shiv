import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { NOTES_DIRNAME, SKILLS_DIRNAME } from "./vault/skills.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
 * Codex's `project_doc_max_bytes` default. Past this it stops adding instruction
 * files — silently. The wrapper warns rather than truncating, because a silently
 * shortened operating manual is a coworker that quietly stops following half of it.
 */
export const OPERATING_MANUAL_MAX_BYTES = 32 * 1024;

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
   * writing the `.env` — what will this instance let itself do.
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

export const configSchema = z.object({
  slack: z.object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
  }),
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
  notesDir: z.string().min(1),
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
  skillsDir: z.string().min(1),
  /** Where per-Thread Job workspaces are created. The sandbox's writable root. */
  workspaceRoot: z.string().min(1),
  /**
   * The wrapper's own durable state — which is only the Session mapping. Deliberately
   * outside the Vault and outside every workspace: the Vault is the human's, and a
   * workspace is writable by the agent, which must not be able to rewrite which
   * Session another Thread resumes into.
   */
  stateDir: z.string().min(1),
  /** The shipped operating manual, copied into every Job's workspace as `AGENTS.md`. */
  operatingManualPath: z.string().min(1),
  engine: z.object({
    model: z.string().min(1),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    /** Left unset, the `codex` on `PATH` is used, falling back to the vendored one. */
    codexPath: z.string().min(1).optional(),
  }),
  /**
   * What stops a Job that does not stop by itself, and how many may run at once. See
   * {@link BOUND_DEFAULTS}.
   */
  bounds: boundsSchema,
  /** Connectors, as MCP server configuration. Empty until the connector tickets. */
  mcpServers: z.array(
    z.object({
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
    }),
  ),
});

export type Config = z.infer<typeof configSchema>;

const defaults = {
  /**
   * `vault/` is the Obsidian vault; `Notes` and `Skills` are its two halves.
   *
   * The split is not organisational — it is the write boundary. Skills are not listed
   * here because they are derived from this: they sit next to the Notes unless
   * `SKILLS_DIR` says otherwise. See {@link configSchema}'s `skillsDir`, and
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

/**
 * Read configuration from the environment.
 *
 * Ticket 08 replaces this with a single configuration file naming the tokens, the
 * Vault, the connectors, and the bounds; the shape above is what that file will
 * parse into.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `NOTES_DIR` rather than `VAULT_DIR`, because it names the Notes half rather than the
  // vault: the vault is what a human opens in Obsidian and it holds Skills too. Renamed
  // on build/15, when the write boundary split the two.
  const notesDir = env.NOTES_DIR ?? defaults.notesDir;
  const parsed = configSchema.safeParse({
    slack: {
      botToken: env.SLACK_BOT_TOKEN ?? "",
      appToken: env.SLACK_APP_TOKEN ?? "",
    },
    notesDir,
    // Next to the Notes rather than at the shipped default, when only one of the two has
    // been moved. Someone who points `NOTES_DIR` at their own Obsidian vault means their
    // Skills to be there too — leaving them at `<repo>/vault/Skills` would be an empty
    // directory the coworker is told about and a real one nobody reads. The sibling
    // relationship is the layout the write boundary depends on, so it is what a partial
    // configuration falls back to.
    skillsDir: env.SKILLS_DIR ?? path.join(path.dirname(notesDir), SKILLS_DIRNAME),
    workspaceRoot: env.WORKSPACE_ROOT ?? defaults.workspaceRoot,
    stateDir: env.STATE_DIR ?? defaults.stateDir,
    operatingManualPath: env.OPERATING_MANUAL_PATH ?? defaults.operatingManualPath,
    engine: {
      model: env.CODEX_MODEL ?? defaults.model,
      reasoningEffort: env.CODEX_REASONING_EFFORT ?? defaults.reasoningEffort,
      codexPath: env.CODEX_PATH,
    },
    bounds: {
      turnTimeoutMs: numberFromEnv(env.TURN_TIMEOUT_MS, BOUND_DEFAULTS.turnTimeoutMs),
      maxTurnsPerJob: numberFromEnv(env.MAX_TURNS_PER_JOB, BOUND_DEFAULTS.maxTurnsPerJob),
      tokenBudgetPerJob: numberFromEnv(env.TOKEN_BUDGET_PER_JOB, BOUND_DEFAULTS.tokenBudgetPerJob),
      maxConcurrentJobs: numberFromEnv(
        env.MAX_CONCURRENT_JOBS,
        BOUND_DEFAULTS.maxConcurrentJobs,
      ),
      librarianTimeoutMs: numberFromEnv(
        env.LIBRARIAN_TIMEOUT_MS,
        BOUND_DEFAULTS.librarianTimeoutMs,
      ),
    },
    mcpServers: [],
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Configuration is incomplete, so the instance is stopping now rather than on the first mention:\n${problems}\n\n` +
        "SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required. See docs/setup.md.",
    );
  }

  return parsed.data;
}

/**
 * A number from the environment, or the default when it was not set.
 *
 * Something unparseable is passed through as `NaN` rather than quietly falling back
 * to the default: a self-hoster who typed `TOKEN_BUDGET_PER_JOB=1_000_000` has said
 * what they want, and running with a different bound than the one they wrote is the
 * silent kind of wrong. The schema rejects it and the startup message names the field.
 */
function numberFromEnv(value: string | undefined, fallback: number): number {
  return value === undefined || value.trim() === "" ? fallback : Number(value);
}
