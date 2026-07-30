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
  if (supportsMentionFile(file)) return;
  throw new Error(
    `I cannot read ${file.name} (${file.mimetype || "unknown type"}). ` +
      "Attach a supported text, data, document, archive, database, or image file instead.",
  );
}

export function supportsMentionFile(file: MentionFile): boolean {
  const extension = path.extname(file.name).toLowerCase();
  const mimetype = file.mimetype.toLowerCase();
  if (mimetype.startsWith("text/") || SUPPORTED_MIME_TYPES.has(mimetype)) {
    return true;
  }
  // Slack sometimes reports an otherwise useful file as a generic binary. Only that
  // non-claim may fall back to the filename; an explicit `application/x-sketch` must
  // not be overridden by the attacker-controlled name `dashboard.csv`.
  if (
    GENERIC_MIME_TYPES.has(mimetype) &&
    SUPPORTED_EXTENSIONS.has(extension)
  ) {
    return true;
  }
  return false;
}

const SUPPORTED_MIME_TYPES = new Set([
  "application/csv",
  "application/gzip",
  "application/json",
  "application/ld+json",
  "application/pdf",
  "application/msword",
  "application/rtf",
  "application/sql",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-7z-compressed",
  "application/x-gzip",
  "application/x-ndjson",
  "application/x-sqlite3",
  "application/x-tar",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "application/zip",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ".7z",
  ".csv",
  ".db",
  ".doc",
  ".docx",
  ".gz",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".ndjson",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rtf",
  ".sql",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tsv",
  ".txt",
  ".webp",
  ".xls",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
]);

export function isVisualInput(file: IngestedFile): boolean {
  const mimetype = file.mimetype.toLowerCase();
  return (
    VISUAL_MIME_TYPES.has(mimetype) ||
    (GENERIC_MIME_TYPES.has(mimetype) &&
      VISUAL_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
  );
}

const VISUAL_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const GENERIC_MIME_TYPES = new Set(["", "unknown", "application/octet-stream"]);
const VISUAL_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

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
