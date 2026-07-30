import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SlackClient } from "../ports/slack.ts";
import type { IngestedFile, MentionFile } from "./types.ts";
import { resetJobFileDirectory, safeSegment } from "./paths.ts";

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

  const directory = await resetJobFileDirectory(input.workspaceDir, "inputs", input.jobId);

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
  if (file.mimetype.startsWith("text/") || SUPPORTED_MIME_TYPES.has(file.mimetype)) {
    return;
  }
  // Slack sometimes reports an otherwise useful file as a generic binary. Only that
  // non-claim may fall back to the filename; an explicit `image/png` must not be
  // overridden by the attacker-controlled name `dashboard.csv`.
  if (
    (file.mimetype === "" ||
      file.mimetype === "unknown" ||
      file.mimetype === "application/octet-stream") &&
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
