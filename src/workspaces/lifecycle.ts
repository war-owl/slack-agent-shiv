import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Clock, Stoppable } from "../ports/clock.ts";
import type { Logger } from "../ports/log.ts";
import type { RepositoryRestoration } from "../repositories/checkout.ts";

const run = promisify(execFile);
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RESTORATIONS_FILE = "workspace-restorations.json";

const DISPOSABLE_DIRECTORIES = new Set([
  "node_modules",
  ".pnpm-store",
  ".svelte-kit",
  ".next",
  ".nuxt",
  "coverage",
  "dist",
  "build",
  ".turbo",
  ".vite",
  ".open-agent-hooks",
]);

interface SavedWorkspace {
  repositories: Record<string, RepositoryRestoration>;
}

type SavedWorkspaces = Record<string, SavedWorkspace>;

export interface WorkspaceLease {
  /** Refresh inactivity after every last piece of Job work, including the Librarian. */
  release(): Promise<void>;
}

export interface SweepReport {
  cachesRemoved: number;
  workspacesRemoved: number;
  workspacesPreserved: number;
}

/**
 * Own inactive workspace reclamation behind one interface.
 *
 * Callers say only when a workspace is in use. The implementation owns the clock,
 * cache allowlist, Git safety proof, restoration state, periodic sweep, and logging.
 */
export interface WorkspaceLifecycle {
  use(directory: string): Promise<WorkspaceLease>;
  restorationFor(directory: string): Promise<Record<string, RepositoryRestoration>>;
  sweep(): Promise<SweepReport>;
  stop(): void;
}

export function startWorkspaceLifecycle(options: {
  workspaceRoot: string;
  stateDir: string;
  inactivityMs: number;
  clock: Clock;
  log: Logger;
}): WorkspaceLifecycle {
  const active = new Set<string>();
  let sweeping: Promise<SweepReport> | undefined;

  const sweep = (): Promise<SweepReport> => {
    if (sweeping !== undefined) return sweeping;
    sweeping = sweepInactive({ ...options, active }).finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };

  const timer: Stoppable = options.clock.every(
    Math.min(SWEEP_INTERVAL_MS, options.inactivityMs),
    async () => {
      try {
        const report = await sweep();
        if (report.cachesRemoved > 0 || report.workspacesRemoved > 0) {
          options.log.info(
            `Workspace sweep removed ${report.cachesRemoved} cache ` +
              `${report.cachesRemoved === 1 ? "directory" : "directories"} and ` +
              `${report.workspacesRemoved} inactive ` +
              `${report.workspacesRemoved === 1 ? "workspace" : "workspaces"}.`,
          );
        }
      } catch (error) {
        options.log.warn(`Workspace sweep failed: ${reasonFor(error)}`);
      }
    },
  );

  return {
    async use(directory): Promise<WorkspaceLease> {
      const resolved = path.resolve(directory);
      // A sweep that already chose this workspace must finish before preparation starts.
      // Conversely, adding the lease before the first filesystem await makes a sweep that
      // starts afterwards observe it. This closes the only deletion-vs-Job race.
      if (sweeping !== undefined) await sweeping;
      active.add(resolved);
      await touchDirectory(resolved, options.clock.now());
      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            await touchDirectory(resolved, options.clock.now());
          } finally {
            active.delete(resolved);
          }
        },
      };
    },

    async restorationFor(directory) {
      const saved = await readRestorations(options.stateDir);
      return saved[path.basename(directory)]?.repositories ?? {};
    },

    sweep,
    stop: () => timer.stop(),
  };
}

async function sweepInactive(options: {
  workspaceRoot: string;
  stateDir: string;
  inactivityMs: number;
  clock: Clock;
  active: ReadonlySet<string>;
}): Promise<SweepReport> {
  let cachesRemoved = 0;
  let workspacesRemoved = 0;
  let workspacesPreserved = 0;
  const entries = await directoryEntries(options.workspaceRoot);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspace = path.resolve(options.workspaceRoot, entry.name);
    if (options.active.has(workspace)) continue;
    const details = await stat(workspace);
    if (options.clock.now() - details.mtimeMs < options.inactivityMs) continue;

    cachesRemoved += await removeDisposableDirectories(workspace);
    if (await isDirectory(path.join(workspace, ".open-agent", "inputs"))) {
      await rm(path.join(workspace, ".open-agent", "inputs"), { recursive: true, force: true });
      cachesRemoved += 1;
    }
    const safe = await safeToEvict(workspace);
    if (safe === undefined) {
      workspacesPreserved += 1;
      continue;
    }

    await saveRestoration(options.stateDir, entry.name, safe);
    await rm(workspace, { recursive: true, force: true });
    workspacesRemoved += 1;
  }

  return { cachesRemoved, workspacesRemoved, workspacesPreserved };
}

async function removeDisposableDirectories(root: string): Promise<number> {
  let removed = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await directoryEntries(directory)) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === ".git") continue;
      if (DISPOSABLE_DIRECTORIES.has(entry.name)) {
        await rm(child, { recursive: true, force: true });
        removed += 1;
      } else {
        await visit(child);
      }
    }
  };
  await visit(root);
  return removed;
}

/** Return restoration data only when deleting the entire workspace is proven safe. */
async function safeToEvict(
  workspace: string,
): Promise<Record<string, RepositoryRestoration> | undefined> {
  const allowed = new Set(["AGENTS.md", ".DS_Store", ".open-agent", "repositories"]);
  const entries = await directoryEntries(workspace);
  if (entries.some((entry) => !allowed.has(entry.name))) return undefined;
  if (!(await safeOpenAgentDirectory(path.join(workspace, ".open-agent")))) return undefined;

  const repositoriesRoot = path.join(workspace, "repositories");
  if (!(await isDirectory(repositoriesRoot))) return {};

  const restorations: Record<string, RepositoryRestoration> = {};
  for (const owner of await directoryEntries(repositoriesRoot)) {
    if (!owner.isDirectory()) return undefined;
    const ownerRoot = path.join(repositoriesRoot, owner.name);
    for (const repository of await directoryEntries(ownerRoot)) {
      if (!repository.isDirectory()) return undefined;
      const checkout = path.join(ownerRoot, repository.name);
      const restoration = await safeRepositoryState(checkout);
      if (restoration === undefined) return undefined;
      restorations[`${owner.name}/${repository.name}`] = restoration;
    }
  }
  return restorations;
}

async function safeOpenAgentDirectory(directory: string): Promise<boolean> {
  if (!(await isDirectory(directory))) return true;
  const allowed = new Set(["bin", "repositories.json", "outputs"]);
  for (const entry of await directoryEntries(directory)) {
    if (!allowed.has(entry.name)) return false;
    if (entry.name === "outputs" && (await containsFile(path.join(directory, entry.name)))) {
      return false;
    }
  }
  return true;
}

async function containsFile(directory: string): Promise<boolean> {
  for (const entry of await directoryEntries(directory)) {
    if (!entry.isDirectory()) return true;
    if (await containsFile(path.join(directory, entry.name))) return true;
  }
  return false;
}

async function safeRepositoryState(
  checkout: string,
): Promise<RepositoryRestoration | undefined> {
  if (!(await isDirectory(path.join(checkout, ".git")))) return undefined;

  try {
    const status = await git(
      checkout,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    );
    if (status !== "") return undefined;

    const branch = await git(checkout, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (branch === "") return undefined;
    const head = await git(checkout, "rev-parse", "--verify", "HEAD");
    const refs = await git(
      checkout,
      "for-each-ref",
      "--format=%(refname:short)%00%(upstream:short)",
      "refs/heads",
    );
    for (const line of refs.split("\n").filter(Boolean)) {
      const [local, upstream] = line.split("\0");
      if (local === undefined || upstream === undefined || upstream === "") return undefined;
      const ahead = await git(checkout, "rev-list", "--count", `${upstream}..${local}`);
      if (ahead !== "0") return undefined;
    }
    return { branch, head };
  } catch {
    // An unborn HEAD, interrupted clone, stale upstream, or damaged repository is never
    // evidence that deletion is safe. Preserve it and let the next Job or a human repair
    // it; one unusual checkout must not abort reclamation for every other Thread.
    return undefined;
  }
}

async function saveRestoration(
  stateDir: string,
  workspace: string,
  repositories: Record<string, RepositoryRestoration>,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const saved = await readRestorations(stateDir);
  saved[workspace] = { repositories };
  const destination = path.join(stateDir, RESTORATIONS_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function readRestorations(stateDir: string): Promise<SavedWorkspaces> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, RESTORATIONS_FILE), "utf8")) as SavedWorkspaces;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function touchDirectory(directory: string, now: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  const at = new Date(now);
  await utimes(directory, at, at);
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function git(checkout: string, ...args: string[]): Promise<string> {
  const result = await run("git", ["-C", checkout, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
