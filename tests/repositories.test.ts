import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";
import { testTempDir } from "./support/test-root.ts";

const run = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const result = await run("git", args, { encoding: "utf8" });
  return result.stdout.trim();
}

async function repositoryFixture(): Promise<{ remote: string }> {
  const root = await testTempDir("open-agent-repository-");
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await mkdir(source);
  await git("init", "-b", "main", source);
  await git("-C", source, "config", "user.email", "fixture@example.com");
  await git("-C", source, "config", "user.name", "Fixture");
  await git("-C", source, "config", "commit.gpgsign", "false");
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  await writeFile(
    path.join(source, "repository.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert';\ntest('works', () => assert.ok(true));\n",
    "utf8",
  );
  await git("-C", source, "add", ".");
  await git("-C", source, "commit", "-m", "initial");
  await git("clone", "--bare", source, remote);
  return { remote };
}

function recordsIn(texts: string[]): string[] {
  return texts.slice(1, -1);
}

describe("a configured code repository", () => {
  it("is a usable checkout whose git push and MCP pull request stay in the Thread", async () => {
    const fixture = await repositoryFixture();
    const h = await coworkerHarness({
      repositories: ["acme/platform"],
      repositoryRemotes: { "acme/platform": fixture.remote },
      env: { GITHUB_TOKEN: "github-token-for-test" },
    });
    const checkout = path.join(
      h.workspaceRoot,
      `C_GENERAL-${DEFAULT_THREAD_TS}`,
      "repositories",
      "acme-platform",
    );

    h.engine.script = async ({ prompt }) => {
      expect(prompt).toContain("acme/platform");
      expect(prompt).toContain(checkout);
      expect(await readFile(path.join(checkout, "repository.test.js"), "utf8")).toContain(
        "assert.ok(true)",
      );
      await run("node", ["--test"], { cwd: checkout });
      await git("-C", checkout, "config", "user.email", "coworker@example.com");
      await git("-C", checkout, "config", "user.name", "Coworker");
      await git("-C", checkout, "config", "commit.gpgsign", "false");
      await git("-C", checkout, "switch", "-c", "open-agent/EV1");
      await writeFile(path.join(checkout, "answer.txt"), "done\n", "utf8");
      await git("-C", checkout, "add", "answer.txt");
      await git("-C", checkout, "commit", "-m", "Add the answer");
      await git("-C", checkout, "push", "-u", "origin", "HEAD");

      return [
        {
          type: "command",
          command: "git push -u origin HEAD",
          status: "completed",
          output: "open-agent/EV1 -> open-agent/EV1",
          exitCode: 0,
        },
        {
          type: "tool-call",
          server: "github",
          tool: "create_pull_request",
          status: "completed",
          error: undefined,
          result:
            '{"html_url":"https://github.com/acme/platform/pull/42","number":42}',
        },
        { type: "message", text: "Pushed the branch and opened pull request 42." },
      ] as const;
    };

    await h.mention({ text: "<@U0COWORKER> fix the repository and open a pull request" });

    expect(await git("--git-dir", fixture.remote, "show-ref", "open-agent/EV1")).toContain(
      "refs/heads/open-agent/EV1",
    );
    expect(await git("-C", checkout, "config", "--get", "core.hooksPath")).toBe(
      ".open-agent-hooks",
    );
    expect(await git("-C", checkout, "remote", "get-url", "origin")).not.toContain(
      "github-token-for-test",
    );
    expect(await git("-C", checkout, "config", "--get", "credential.helper")).toContain(
      "git-credential-open-agent",
    );
    expect(
      await readFile(
        path.join(checkout, ".open-agent-hooks", "git-credential-open-agent"),
        "utf8",
      ),
    ).toContain("GITHUB_TOKEN");
    expect(
      await readFile(
        path.join(checkout, ".open-agent-hooks", "git-credential-open-agent"),
        "utf8",
      ),
    ).not.toContain("github-token-for-test");

    const records = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/pushed to a git remote/i);
    expect(records[1]).toContain("create_pull_request");
    expect(records[1]).toContain(
      "<https://github.com/acme/platform/pull/42|github.com/acme/platform/pull/42>",
    );
  });

  it("refreshes the remote and restores the checkout guardrails before every Job", async () => {
    const fixture = await repositoryFixture();
    const h = await coworkerHarness({
      repositories: ["acme/platform"],
      repositoryRemotes: { "acme/platform": fixture.remote },
      env: { GITHUB_TOKEN: "github-token-for-test" },
    });
    const checkout = path.join(
      h.workspaceRoot,
      `C_GENERAL-${DEFAULT_THREAD_TS}`,
      "repositories",
      "acme-platform",
    );

    await h.mention();
    const hook = path.join(checkout, ".open-agent-hooks", "pre-push");
    await writeFile(hook, "#!/usr/bin/env bash\nexit 0\n", "utf8");

    const updater = path.join(await testTempDir("open-agent-updater-"), "checkout");
    await git("clone", fixture.remote, updater);
    await git("-C", updater, "config", "user.email", "human@example.com");
    await git("-C", updater, "config", "user.name", "Human");
    await git("-C", updater, "config", "commit.gpgsign", "false");
    await writeFile(path.join(updater, "from-human.txt"), "new upstream work\n", "utf8");
    await git("-C", updater, "add", "from-human.txt");
    await git("-C", updater, "commit", "-m", "human update");
    await git("-C", updater, "push", "origin", "main");
    const upstream = await git("-C", updater, "rev-parse", "HEAD");

    h.engine.script = () => [{ type: "message", text: "Ready." }];
    await h.mention();

    expect(await git("-C", checkout, "rev-parse", "refs/remotes/origin/main")).toBe(upstream);
    expect(await readFile(hook, "utf8")).toContain(
      "blocked: push to protected ref '$remote_ref'",
    );
  });
});
