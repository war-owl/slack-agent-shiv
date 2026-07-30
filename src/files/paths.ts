import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const JOB_FILES_DIR = ".open-agent";

export async function resetJobFileDirectory(
  workspaceDir: string,
  kind: "inputs" | "outputs",
  jobId: string,
): Promise<string> {
  const directory = path.join(workspaceDir, JOB_FILES_DIR, kind, safeSegment(jobId));
  // Slack can redeliver after a process restart. Inputs must be rebuilt from Slack, and a
  // stale partial output must never be uploaded as the new attempt's result.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

export function safeSegment(given: string): string {
  return given.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}
