import { execFile } from "node:child_process";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareRepositoryCheckout } from "../src/repositories/checkout.ts";
import { startWorkspaceLifecycle } from "../src/workspaces/lifecycle.ts";
import { FakeClock } from "./support/fakes.ts";
import { testTempDir } from "./support/test-root.ts";

const run = promisify(execFile);
const HOUR = 60 * 60 * 1000;

async function git(...args: string[]): Promise<string> {
  const result = await run("git", args, { encoding: "utf8" });
  return result.stdout.trim();
}

async function repositoryAt(workspace: string): Promise<{ checkout: string; remote: string }> {
  const fixture = await testTempDir("workspace-lifecycle-repository-");
  const seed = path.join(fixture, "seed");
  const remote = path.join(fixture, "remote.git");
  const checkout = path.join(workspace, "repositories", "acme", "platform");
  await mkdir(seed, { recursive: true });
  await git("init", "-b", "main", seed);
  await git("-C", seed, "config", "user.email", "fixture@example.com");
  await git("-C", seed, "config", "user.name", "Fixture");
  await git("-C", seed, "config", "commit.gpgsign", "false");
  await writeFile(path.join(seed, "README.md"), "hello\n", "utf8");
  await git("-C", seed, "add", ".");
  await git("-C", seed, "commit", "-m", "initial");
  await git("clone", "--bare", seed, remote);
  await mkdir(path.dirname(checkout), { recursive: true });
  await git("clone", remote, checkout);
  return { checkout, remote };
}

function lifecycle(root: string, clock: FakeClock) {
  return startWorkspaceLifecycle({
    workspaceRoot: path.join(root, "workspaces"),
    stateDir: path.join(root, "state"),
    inactivityMs: HOUR,
    clock,
    log: { info: () => {}, warn: () => {} },
  });
}

async function makeStale(directory: string, clock: FakeClock): Promise<void> {
  const stale = new Date(clock.now() - HOUR - 1);
  await utimes(directory, stale, stale);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("inactive Thread workspaces", () => {
  it("removes reproducible caches but preserves a checkout with local work", async () => {
    const root = await testTempDir("workspace-lifecycle-");
    const clock = new FakeClock();
    const workspace = path.join(root, "workspaces", "thread-dirty");
    const { checkout } = await repositoryAt(workspace);
    const dependencies = path.join(checkout, "node_modules", "package");
    const store = path.join(workspace, ".pnpm-store", "v10", "files");
    await mkdir(dependencies, { recursive: true });
    await mkdir(store, { recursive: true });
    await writeFile(path.join(checkout, "unfinished.txt"), "do not lose me\n", "utf8");
    await makeStale(workspace, clock);

    const manager = lifecycle(root, clock);
    const report = await manager.sweep();

    expect(report).toEqual({ cachesRemoved: 2, workspacesRemoved: 0, workspacesPreserved: 1 });
    expect(await exists(workspace)).toBe(true);
    expect(await exists(path.join(checkout, "unfinished.txt"))).toBe(true);
    expect(await exists(path.join(checkout, "node_modules"))).toBe(false);
    expect(await exists(path.join(workspace, ".pnpm-store"))).toBe(false);
    manager.stop();
  });

  it("evicts a clean pushed feature branch and restores its exact commit on demand", async () => {
    const root = await testTempDir("workspace-lifecycle-");
    const clock = new FakeClock();
    const workspace = path.join(root, "workspaces", "thread-clean");
    const { checkout, remote } = await repositoryAt(workspace);
    await git("-C", checkout, "config", "user.email", "fixture@example.com");
    await git("-C", checkout, "config", "user.name", "Fixture");
    await git("-C", checkout, "config", "commit.gpgsign", "false");
    await git("-C", checkout, "switch", "-c", "feature/answer");
    await writeFile(path.join(checkout, "answer.txt"), "forty two\n", "utf8");
    await git("-C", checkout, "add", ".");
    await git("-C", checkout, "commit", "-m", "answer");
    await git("-C", checkout, "push", "-u", "origin", "HEAD");
    const head = await git("-C", checkout, "rev-parse", "HEAD");
    await makeStale(workspace, clock);

    const manager = lifecycle(root, clock);
    const report = await manager.sweep();
    const restoration = (await manager.restorationFor(workspace))["acme/platform"];

    expect(report.workspacesRemoved).toBe(1);
    expect(await exists(workspace)).toBe(false);
    expect(restoration).toEqual({ branch: "feature/answer", head });

    const restored = await prepareRepositoryCheckout({
      workspace,
      repository: "acme/platform",
      remote,
      credentialEnvVar: undefined,
      env: process.env,
      restoration,
    });
    expect(await git("-C", restored.checkout, "branch", "--show-current")).toBe(
      "feature/answer",
    );
    expect(await git("-C", restored.checkout, "rev-parse", "HEAD")).toBe(head);
    manager.stop();
  });

  it("never sweeps a workspace while a Job holds its lease", async () => {
    const root = await testTempDir("workspace-lifecycle-");
    const clock = new FakeClock();
    const workspace = path.join(root, "workspaces", "thread-running");
    await mkdir(path.join(workspace, "node_modules"), { recursive: true });
    const manager = lifecycle(root, clock);
    const lease = await manager.use(workspace);

    await clock.advance(HOUR + 5 * 60 * 1000);

    expect(await exists(path.join(workspace, "node_modules"))).toBe(true);
    await lease.release();
    manager.stop();
  });

  it("preserves a result file that was left in the Job workspace", async () => {
    const root = await testTempDir("workspace-lifecycle-");
    const clock = new FakeClock();
    const workspace = path.join(root, "workspaces", "thread-result");
    const result = path.join(workspace, ".open-agent", "outputs", "job-1", "report.csv");
    await mkdir(path.dirname(result), { recursive: true });
    await writeFile(result, "answer,42\n", "utf8");
    await makeStale(workspace, clock);

    const manager = lifecycle(root, clock);
    const report = await manager.sweep();

    expect(report.workspacesPreserved).toBe(1);
    expect(await exists(result)).toBe(true);
    manager.stop();
  });

  it("preserves an initialized repository whose HEAD has no commit", async () => {
    const root = await testTempDir("workspace-lifecycle-");
    const clock = new FakeClock();
    const workspace = path.join(root, "workspaces", "thread-unborn-head");
    const checkout = path.join(workspace, "repositories", "acme", "platform");
    await mkdir(checkout, { recursive: true });
    await git("init", "-b", "main", checkout);
    await makeStale(workspace, clock);

    const manager = lifecycle(root, clock);
    const report = await manager.sweep();

    expect(report.workspacesPreserved).toBe(1);
    expect(await exists(checkout)).toBe(true);
    manager.stop();
  });
});
