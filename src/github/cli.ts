import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubCli } from "../ports/github.ts";

/**
 * The `gh` binary, which since [ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md)
 * is how the coworker reaches GitHub at all.
 *
 * The wrapper never runs `gh` itself — the agent does, from inside a Skill — so the only
 * thing this exists for is to establish at startup that the program is there and to say
 * which version it is. That is the same treatment Codex gets, for the same reason: a
 * capability that lives in somebody else's CLI drifts on somebody else's schedule.
 */
export const ghCli: GitHubCli = {
  async version(): Promise<string | undefined> {
    try {
      const { stdout } = await promisify(execFile)("gh", ["--version"], { timeout: 10_000 });
      // `gh --version` prints `gh version 2.96.0 (2026-07-02)` and then a release URL.
      return /gh version (\S+)/.exec(stdout)?.[1] ?? stdout.trim().split("\n")[0];
    } catch {
      // Not on PATH, or not runnable. Either way there is no version, and whether that
      // matters is a question about configuration rather than about this module.
      return undefined;
    }
  },
};
