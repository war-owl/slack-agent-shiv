import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

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

export const configSchema = z.object({
  slack: z.object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
  }),
  /** The Vault: Markdown Notes in a directory the human owns and opens in Obsidian. */
  vaultDir: z.string().min(1),
  /** Where per-Thread Job workspaces are created. The sandbox's writable root. */
  workspaceRoot: z.string().min(1),
  /** The shipped operating manual, copied into every Job's workspace as `AGENTS.md`. */
  operatingManualPath: z.string().min(1),
  engine: z.object({
    model: z.string().min(1),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    /** Left unset, the `codex` on `PATH` is used, falling back to the vendored one. */
    codexPath: z.string().min(1).optional(),
  }),
  /** Connectors, as MCP server configuration. Empty until the connector tickets. */
  mcpServers: z.array(
    z.object({
      name: z.string().min(1),
      url: z.string().url(),
      bearerTokenEnvVar: z.string().min(1),
    }),
  ),
});

export type Config = z.infer<typeof configSchema>;

const defaults = {
  vaultDir: path.join(repoRoot, "vault"),
  workspaceRoot: path.join(repoRoot, ".workspaces"),
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
  const parsed = configSchema.safeParse({
    slack: {
      botToken: env.SLACK_BOT_TOKEN ?? "",
      appToken: env.SLACK_APP_TOKEN ?? "",
    },
    vaultDir: env.VAULT_DIR ?? defaults.vaultDir,
    workspaceRoot: env.WORKSPACE_ROOT ?? defaults.workspaceRoot,
    operatingManualPath: env.OPERATING_MANUAL_PATH ?? defaults.operatingManualPath,
    engine: {
      model: env.CODEX_MODEL ?? defaults.model,
      reasoningEffort: env.CODEX_REASONING_EFFORT ?? defaults.reasoningEffort,
      codexPath: env.CODEX_PATH,
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
