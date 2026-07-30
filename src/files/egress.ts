import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { reasonFor } from "../failure.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { Thread } from "../thread.ts";
import { resetJobFileDirectory } from "./paths.ts";

export async function prepareOutputDirectory(input: {
  workspaceDir: string;
  jobId: string;
}): Promise<string> {
  return resetJobFileDirectory(input.workspaceDir, "outputs", input.jobId);
}

export interface SharedResult {
  filename: string;
  permalink: string | undefined;
}

export interface UnsharedResult {
  filename: string;
  reason: string;
}

export async function shareResultFiles(input: {
  slack: SlackClient;
  thread: Thread;
  outputDir: string;
  maxBytes: number;
}): Promise<{ shared: SharedResult[]; unshared: UnsharedResult[] }> {
  let entries;
  try {
    entries = (await readdir(input.outputDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    if (isMissing(error)) return { shared: [], unshared: [] };
    return {
      shared: [],
      unshared: [{ filename: "the result-file directory", reason: reasonFor(error) }],
    };
  }

  const shared: SharedResult[] = [];
  const unshared: UnsharedResult[] = [];

  for (const entry of entries) {
    // A flat, regular-file-only dropbox. Directories and links are workspace organization,
    // not an instruction to walk an arbitrary tree and send it to Slack.
    if (!entry.isFile()) continue;
    const filename = entry.name;
    const filePath = path.join(input.outputDir, filename);
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (stat.size > input.maxBytes) {
        throw new Error(
          `${stat.size} bytes is over the ${input.maxBytes}-byte result-file limit`,
        );
      }
      const bytes = await handle.readFile();
      if (bytes.length > input.maxBytes) {
        throw new Error(
          `${bytes.length} bytes is over the ${input.maxBytes}-byte result-file limit`,
        );
      }
      const uploaded = await input.slack.uploadFile({
        thread: input.thread,
        filename,
        bytes,
        comment: "Result file attached.",
      });
      shared.push({ filename, permalink: uploaded.permalink });
    } catch (error) {
      unshared.push({ filename, reason: reasonFor(error) });
    } finally {
      await handle?.close();
    }
  }
  return { shared, unshared };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
