import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import { installGitSafetyHook } from "../git/safety.ts";
import { parseRepositoryName } from "./name.ts";

const run = promisify(execFile);
const CHECKOUTS_DIR = "repositories";
const OPEN_AGENT_HOOKS_DIR = ".open-agent-hooks";
const CREDENTIAL_HELPER = "git-credential-open-agent";
const CHECKOUT_COMMAND_DIR = ".open-agent";
const CHECKOUT_COMMAND = "checkout";
const CHECKOUT_CONFIG = "repositories.json";

export interface PreparedRepository {
  repository: string;
  checkout: string;
  defaultBranch: string;
}

/** The exact clean, pushed checkout point recorded before inactive eviction. */
export interface RepositoryRestoration {
  branch: string;
  head: string;
}

/**
 * The capability handed to a Job before it starts.
 *
 * It names what can be checked out and how to ask for one, but performs no Git operation.
 * That distinction is the point: a normal conversation must not depend on repository
 * availability merely because the instance also handles code work.
 */
export interface RepositoryAccess {
  repositories: readonly string[];
  checkoutCommand: string | undefined;
}

export async function installCheckoutCommand(options: {
  workspace: string;
  repositories: readonly string[];
  credentialEnvVar: string | undefined;
  remoteFor?: ((repository: string) => string) | undefined;
  restorations?: Readonly<Record<string, RepositoryRestoration>> | undefined;
}): Promise<RepositoryAccess> {
  if (options.repositories.length === 0) {
    return { repositories: [], checkoutCommand: undefined };
  }

  const commandRoot = path.join(options.workspace, CHECKOUT_COMMAND_DIR);
  const command = path.join(commandRoot, "bin", CHECKOUT_COMMAND);
  const config = path.join(commandRoot, CHECKOUT_CONFIG);
  await mkdir(path.dirname(command), { recursive: true });
  await writeFile(
    config,
    JSON.stringify(
      {
        workspace: options.workspace,
        credentialEnvVar: options.credentialEnvVar,
        repositories: Object.fromEntries(
          options.repositories.map((repository) => {
            const parsed = parseRepositoryName(repository);
            return [
              repository,
              options.remoteFor?.(repository) ??
                `https://github.com/${parsed.owner}/${parsed.name}.git`,
            ];
          }),
        ),
        restorations: options.restorations ?? {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(command, checkoutCommand(config), "utf8");
  await chmod(command, 0o755);
  return { repositories: [...options.repositories], checkoutCommand: command };
}

/**
 * Materialize or refresh exactly one configured repository.
 *
 * The command module calls this only after the engine has decided local code access is
 * required. The checkout remains under the Thread workspace, so concurrent Threads never
 * share a working tree and a follow-up in one Thread finds its earlier branch and files.
 */
export async function prepareRepositoryCheckout(options: {
  workspace: string;
  repository: string;
  remote: string;
  credentialEnvVar: string | undefined;
  env: NodeJS.ProcessEnv;
  restoration?: RepositoryRestoration | undefined;
}): Promise<PreparedRepository> {
  const parsed = parseRepositoryName(options.repository);
  const checkout = path.join(
    options.workspace,
    CHECKOUTS_DIR,
    parsed.owner,
    parsed.name,
  );
  const gitDirectory = path.join(checkout, ".git");
  const fresh = !(await exists(gitDirectory));
  if (fresh) {
    await mkdir(checkout, { recursive: true });
    await git(options.env, "init", checkout);
    await git(options.env, "-C", checkout, "remote", "add", "origin", options.remote);
  } else {
    const configured = await git(
      options.env,
      "-C",
      checkout,
      "remote",
      "get-url",
      "origin",
    );
    if (configured !== options.remote) {
      throw new Error(
        `The checkout for ${options.repository} at ${checkout} points at ` +
          `${configured}, not ${options.remote}. It was left untouched.`,
      );
    }
  }

  await installCredentialHelper({
    checkout,
    credentialEnvVar: options.credentialEnvVar,
    env: options.env,
  });
  await git(options.env, "-C", checkout, "fetch", "--prune", "origin");
  await git(options.env, "-C", checkout, "remote", "set-head", "origin", "--auto");

  const branch = await defaultBranchAt(checkout, options.env);
  if (fresh && options.restoration !== undefined) {
    await restoreCheckout(checkout, options.restoration, options.env);
  } else if (!(await hasLocalBranch(checkout, branch, options.env))) {
    await git(
      options.env,
      "-C",
      checkout,
      "switch",
      "--track",
      "-c",
      branch,
      `origin/${branch}`,
    );
  }

  // Re-imposed on every Job. The checkout is writable by the agent, so trusting the copy
  // left by the previous Job would turn an editable hook into a one-time promise.
  await installGitSafetyHook({ checkout, defaultBranch: branch });
  return { repository: options.repository, checkout, defaultBranch: branch };
}

async function restoreCheckout(
  checkout: string,
  restoration: RepositoryRestoration,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await git(env, "-C", checkout, "cat-file", "-e", `${restoration.head}^{commit}`);
  await git(env, "-C", checkout, "switch", "-c", restoration.branch, restoration.head);
  await git(
    env,
    "-C",
    checkout,
    "branch",
    "--set-upstream-to",
    `origin/${restoration.branch}`,
    restoration.branch,
  );
}

function checkoutCommand(config: string): string {
  const module = fileURLToPath(new URL("./checkout-command.ts", import.meta.url));
  return `#!/usr/bin/env bash
set -euo pipefail
exec ${shellSingleQuote(process.execPath)} --experimental-strip-types ${shellSingleQuote(module)} ${shellSingleQuote(config)} "$@"
`;
}

async function installCredentialHelper(options: {
  checkout: string;
  credentialEnvVar: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const hooks = path.join(options.checkout, OPEN_AGENT_HOOKS_DIR);
  const helper = path.join(hooks, CREDENTIAL_HELPER);
  await mkdir(hooks, { recursive: true });
  await writeFile(helper, credentialHelper(options.credentialEnvVar), "utf8");
  await chmod(helper, 0o755);
  // The empty entry resets every helper inherited from system and global config. Without
  // it, a developer's own GitHub credential can answer first and the configured
  // fine-grained token is never consulted.
  await git(
    options.env,
    "-C",
    options.checkout,
    "config",
    "--replace-all",
    "credential.helper",
    "",
  );
  // Git runs a `!` helper as a shell command and appends the operation (`get`, `store`,
  // `erase`). Quote the absolute path here: instance paths routinely contain spaces.
  await git(
    options.env,
    "-C",
    options.checkout,
    "config",
    "--add",
    "credential.helper",
    `!${shellSingleQuote(helper)}`,
  );
}

function credentialHelper(variable: string | undefined): string {
  const token = variable === undefined ? "" : `token="$(printenv ${shellSingleQuote(variable)} || true)"`;
  return `#!/usr/bin/env bash
set -u
[ "\${1:-}" = "get" ] || exit 0
host=""
while IFS='=' read -r key value; do
  [ "$key" = "host" ] && host="$value"
done
[ "$host" = "github.com" ] || exit 0
${token}
[ -n "\${token:-}" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$token"
`;
}

async function defaultBranchAt(checkout: string, env: NodeJS.ProcessEnv): Promise<string> {
  const remoteHead = await git(
    env,
    "-C",
    checkout,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  const prefix = "origin/";
  if (!remoteHead.startsWith(prefix) || remoteHead.length === prefix.length) {
    throw new Error(`Could not determine the default branch for the checkout at ${checkout}.`);
  }
  return remoteHead.slice(prefix.length);
}

async function hasLocalBranch(
  checkout: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await git(env, "-C", checkout, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

async function git(env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const result = await run("git", args, {
    encoding: "utf8",
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
