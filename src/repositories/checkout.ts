import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { installGitSafetyHook } from "../git/safety.ts";

const run = promisify(execFile);
const CHECKOUTS_DIR = "repositories";
const OPEN_AGENT_HOOKS_DIR = ".open-agent-hooks";
const CREDENTIAL_HELPER = "git-credential-open-agent";

export interface PreparedRepository {
  name: string;
  checkout: string;
  defaultBranch: string;
}

/**
 * Give one Thread its own persistent checkout of every configured repository.
 *
 * Threads run concurrently, so they cannot share a working tree. Keeping each checkout
 * under that Thread's workspace makes the sandbox boundary and the concurrency boundary
 * the same thing, while a follow-up in the Thread finds the branch and files left before.
 */
export async function prepareRepositories(options: {
  workspace: string;
  repositories: readonly string[];
  credentialEnvVar: string | undefined;
  env: NodeJS.ProcessEnv;
  remoteFor?: ((repository: string) => string) | undefined;
}): Promise<PreparedRepository[]> {
  const prepared: PreparedRepository[] = [];
  for (const repository of options.repositories) {
    const checkout = path.join(options.workspace, CHECKOUTS_DIR, slug(repository));
    const remote = options.remoteFor?.(repository) ?? githubRemote(repository);
    await prepareRepository({
      checkout,
      repository,
      remote,
      credentialEnvVar: options.credentialEnvVar,
      env: options.env,
    });
    prepared.push({
      name: repository,
      checkout,
      defaultBranch: await defaultBranchAt(checkout, options.env),
    });
  }
  return prepared;
}

async function prepareRepository(options: {
  checkout: string;
  repository: string;
  remote: string;
  credentialEnvVar: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const gitDirectory = path.join(options.checkout, ".git");
  if (!(await exists(gitDirectory))) {
    await mkdir(options.checkout, { recursive: true });
    await git(options.env, "init", options.checkout);
    await git(options.env, "-C", options.checkout, "remote", "add", "origin", options.remote);
  } else {
    const configured = await git(
      options.env,
      "-C",
      options.checkout,
      "remote",
      "get-url",
      "origin",
    );
    if (configured !== options.remote) {
      throw new Error(
        `The checkout for ${options.repository} at ${options.checkout} points at ` +
          `${configured}, not ${options.remote}. It was left untouched.`,
      );
    }
  }

  await installCredentialHelper({
    checkout: options.checkout,
    credentialEnvVar: options.credentialEnvVar,
  });
  await git(options.env, "-C", options.checkout, "fetch", "--prune", "origin");
  await git(options.env, "-C", options.checkout, "remote", "set-head", "origin", "--auto");

  const branch = await defaultBranchAt(options.checkout, options.env);
  if (!(await hasLocalBranch(options.checkout, branch, options.env))) {
    await git(
      options.env,
      "-C",
      options.checkout,
      "switch",
      "--track",
      "-c",
      branch,
      `origin/${branch}`,
    );
  }

  // Re-imposed on every Job. The checkout is writable by the agent, so trusting the copy
  // left by the previous Job would turn an editable hook into a one-time promise.
  await installGitSafetyHook({ checkout: options.checkout, defaultBranch: branch });
}

async function installCredentialHelper(options: {
  checkout: string;
  credentialEnvVar: string | undefined;
}): Promise<void> {
  const hooks = path.join(options.checkout, OPEN_AGENT_HOOKS_DIR);
  const helper = path.join(hooks, CREDENTIAL_HELPER);
  await mkdir(hooks, { recursive: true });
  await writeFile(helper, credentialHelper(options.credentialEnvVar), "utf8");
  await chmod(helper, 0o755);
  await git(process.env, "-C", options.checkout, "config", "--replace-all", "credential.helper", helper);
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
    env: { ...process.env, ...env },
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

function githubRemote(repository: string): string {
  return `https://github.com/${repository}.git`;
}

function slug(repository: string): string {
  return repository.replace("/", "-");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
