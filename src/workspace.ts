import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPERATING_MANUAL_MAX_BYTES, type Config } from "./config.ts";
import type { Logger } from "./ports/log.ts";
import {
  prepareRepositories,
  type PreparedRepository,
} from "./repositories/checkout.ts";
import type { Thread } from "./thread.ts";

/**
 * Create the Thread's workspace if it does not exist and write the operating manual
 * into it.
 *
 * The workspace is where a Thread's Jobs do their work: the sandbox's writable root,
 * and the directory the engine looks in for its operating manual. One per Thread, so
 * a follow-up three days later finds the files its predecessor left behind.
 *
 * The manual is **re-imposed on every run** rather than written once. The workspace
 * is writable by the agent, so a manual left in place is a manual the agent — or an
 * instruction injected into it from outside — could rewrite for every future Job in
 * this Thread. Adjusting the coworker's persona means editing the shipped file, not
 * the copy in the workspace.
 */
export async function prepareWorkspace(
  config: Config,
  thread: Thread,
  log: Logger,
  options: {
    env: NodeJS.ProcessEnv;
    remoteFor?: ((repository: string) => string) | undefined;
  },
): Promise<{ directory: string; repositories: PreparedRepository[] }> {
  const directory = path.join(
    config.workspaceRoot,
    `${slug(thread.channel)}-${slug(thread.ts)}`,
  );
  await mkdir(directory, { recursive: true });

  const manual = await readFile(config.operatingManualPath, "utf8");
  const bytes = Buffer.byteLength(manual, "utf8");
  if (bytes > OPERATING_MANUAL_MAX_BYTES) {
    // Not truncated here: Codex truncates instruction files silently at this size,
    // and a warning a human can act on beats a manual that quietly lost its tail.
    log.warn(
      `The operating manual at ${config.operatingManualPath} is ${bytes} bytes, over the ` +
        `${OPERATING_MANUAL_MAX_BYTES}-byte limit the engine silently truncates at. ` +
        "It has not been shortened — shorten it yourself, or the coworker will stop " +
        "seeing the end of it.",
    );
  }
  await writeFile(path.join(directory, "AGENTS.md"), manual, "utf8");

  const repositories = await prepareRepositories({
    workspace: directory,
    repositories: config.repositories,
    credentialEnvVar: config.repositoryProtectionTokenEnvVar,
    env: options.env,
    remoteFor: options.remoteFor,
  });

  return { directory, repositories };
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
