import { constants } from "node:fs";
import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { reasonFor } from "../failure.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { Thread } from "../thread.ts";
import type { IngestedFile, MentionFile } from "./types.ts";

const JOB_FILES_DIR = ".open-agent";
const INPUTS_DIR = "inputs";
const OUTPUTS_DIR = "outputs";

export async function ingestMentionFiles(input: {
  slack: SlackClient;
  workspaceDir: string;
  jobId: string;
  files: readonly MentionFile[];
  maxBytes: number;
}): Promise<readonly IngestedFile[]> {
  if (input.files.length === 0) return [];

  for (const file of input.files) {
    if (file.size > input.maxBytes) {
      throw new Error(
        `I cannot read ${file.name}: Slack says it is ${file.size} bytes, over the ` +
          `${input.maxBytes}-byte attachment limit.`,
      );
    }
    assertSupported(file);
    assertSlackDownloadUrl(file);
  }

  const directory = path.join(
    input.workspaceDir,
    JOB_FILES_DIR,
    INPUTS_DIR,
    safeSegment(input.jobId),
  );
  // The event id is normally unique, but Slack can redeliver after a process restart.
  // Rebuild this attempt's input set from authenticated Slack bytes.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const used = new Set<string>();
  const ingested: IngestedFile[] = [];
  for (const file of input.files) {
    const downloaded = await input.slack.downloadFile({ url: file.privateDownloadUrl });
    assertDownloaded(file, downloaded.bytes, downloaded.contentType, input.maxBytes);

    const name = uniqueFilename(safeFilename(file.name, file.id), used);
    const destination = path.join(directory, name);
    await writeFile(destination, downloaded.bytes, { flag: "wx" });
    ingested.push({
      name,
      path: destination,
      mimetype: file.mimetype,
      size: downloaded.bytes.length,
    });
  }
  return ingested;
}

export async function prepareOutputDirectory(input: {
  workspaceDir: string;
  jobId: string;
}): Promise<string> {
  const directory = path.join(
    input.workspaceDir,
    JOB_FILES_DIR,
    OUTPUTS_DIR,
    safeSegment(input.jobId),
  );
  // Never upload a stale partial artifact left by an interrupted attempt as this run's
  // result if Slack redelivers the event after a process restart.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
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
  const entries = (await readdir(input.outputDir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
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

function assertSlackDownloadUrl(file: MentionFile): void {
  let url: URL;
  try {
    url = new URL(file.privateDownloadUrl);
  } catch {
    throw new Error(`I cannot read ${file.name}: Slack supplied an invalid download URL.`);
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) {
    throw new Error(`I cannot read ${file.name}: its private URL is not hosted by Slack.`);
  }
}

function assertSupported(file: MentionFile): void {
  const extension = path.extname(file.name).toLowerCase();
  if (
    file.mimetype.startsWith("text/") ||
    SUPPORTED_MIME_TYPES.has(file.mimetype) ||
    SUPPORTED_EXTENSIONS.has(extension)
  ) {
    return;
  }
  throw new Error(
    `I cannot read ${file.name} (${file.mimetype || "unknown type"}). ` +
      "Attach a text, data, document, archive, or database file instead.",
  );
}

const SUPPORTED_MIME_TYPES = new Set([
  "application/csv",
  "application/gzip",
  "application/json",
  "application/ld+json",
  "application/pdf",
  "application/sql",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-7z-compressed",
  "application/x-gzip",
  "application/x-ndjson",
  "application/x-sqlite3",
  "application/x-tar",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "application/zip",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ".7z",
  ".csv",
  ".db",
  ".gz",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".ndjson",
  ".pdf",
  ".sql",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
]);

function assertDownloaded(
  file: MentionFile,
  bytes: Buffer,
  contentType: string | undefined,
  maxBytes: number,
): void {
  if (bytes.length > maxBytes) {
    throw new Error(
      `I cannot read ${file.name}: Slack returned ${bytes.length} bytes, over the ` +
        `${maxBytes}-byte attachment limit.`,
    );
  }
  const beginning = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (
    contentType?.toLowerCase().startsWith("text/html") ||
    beginning.startsWith("<!doctype html") ||
    beginning.startsWith("<html")
  ) {
    throw new Error(
      `I could not download ${file.name}: Slack returned an HTML sign-in page instead ` +
        "of the file. Check the bot's files:read permission and reinstall the app.",
    );
  }
}

function safeFilename(given: string, fallback: string): string {
  const base = path.basename(given).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_");
  if (safe === "" || safe === "." || safe === "..") return `${safeSegment(fallback)}.bin`;
  return safe;
}

function uniqueFilename(given: string, used: Set<string>): string {
  if (!used.has(given)) {
    used.add(given);
    return given;
  }
  const extension = path.extname(given);
  const stem = given.slice(0, given.length - extension.length);
  let n = 2;
  while (used.has(`${stem}-${n}${extension}`)) n++;
  const unique = `${stem}-${n}${extension}`;
  used.add(unique);
  return unique;
}

function safeSegment(given: string): string {
  return given.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}
