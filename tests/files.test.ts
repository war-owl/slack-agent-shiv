import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";

describe("files carried into a Job from Slack", () => {
  it("downloads an attached CSV into the workspace and names it in the prompt", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_TEST/quarterly.csv";
    const bytes = Buffer.from("region,revenue\nwest,4200\n", "utf8");
    h.slack.downloadableFiles.set(url, { bytes, contentType: "text/csv" });

    await h.mention({
      eventId: "Ev_FILES",
      files: [
        {
          id: "F_TEST",
          name: "quarterly.csv",
          mimetype: "text/csv",
          size: bytes.length,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    const workspace = h.engine.startedSessions[0]!.workingDirectory;
    const ingested = path.join(workspace, ".open-agent", "inputs", "Ev_FILES", "quarterly.csv");
    await expect(readFile(ingested)).resolves.toEqual(bytes);
    expect(h.engine.turns[0]).toContain(ingested);
    expect(h.engine.turns[0]).toContain("text/csv");
  });

  it("downloads a file shared earlier in the same Slack Thread", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_EARLIER/brief.pdf";
    const bytes = Buffer.from("%PDF-thread-brief");
    h.slack.downloadableFiles.set(url, {
      bytes,
      contentType: "application/pdf",
    });
    h.slack.threadFilesByThread.set(DEFAULT_THREAD_TS, [
      {
        id: "F_EARLIER",
        name: "brief.pdf",
        mimetype: "application/pdf",
        size: bytes.length,
        privateDownloadUrl: url,
      },
    ]);

    await h.mention({ eventId: "Ev_THREAD_FILE", files: [] });

    const workspace = h.engine.startedSessions[0]!.workingDirectory;
    const ingested = path.join(
      workspace,
      ".open-agent",
      "inputs",
      "Ev_THREAD_FILE",
      "brief.pdf",
    );
    await expect(readFile(ingested)).resolves.toEqual(bytes);
    expect(h.engine.turns[0]).toContain(ingested);
    expect(h.engine.turns[0]).toContain("Files shared in this Slack Thread");
    expect(h.slack.threadQueries).toEqual([
      {
        thread: { channel: "C_GENERAL", ts: DEFAULT_THREAD_TS },
        latestMessageTs: "1700000001.000200",
      },
    ]);
  });

  it("does not let an old unsupported Thread file block later work", async () => {
    const h = await coworkerHarness();
    h.slack.threadFilesByThread.set(DEFAULT_THREAD_TS, [
      {
        id: "F_OLD_SKETCH",
        name: "old-design.sketch",
        mimetype: "application/x-sketch",
        size: 100,
        privateDownloadUrl:
          "https://files.slack.com/files-pri/T_TEST-F_OLD_SKETCH/old-design.sketch",
      },
    ]);

    await h.mention({ eventId: "Ev_AFTER_SKETCH", files: [] });

    expect(h.engine.turns).toHaveLength(1);
    expect(h.slack.downloadAttempts).toHaveLength(0);
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toContain("Done.");
  });

  it("rejects Slack's HTML sign-in page instead of writing it as the attachment", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_LOGIN/data.csv";
    h.slack.downloadableFiles.set(url, {
      bytes: Buffer.from("<!doctype html><html><title>Sign in to Slack</title></html>"),
      contentType: "text/html; charset=utf-8",
    });

    await h.mention({
      eventId: "Ev_LOGIN",
      files: [
        {
          id: "F_LOGIN",
          name: "data.csv",
          mimetype: "text/csv",
          size: 100,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    expect(h.engine.turns).toHaveLength(0);
    expect(h.slack.textsIn("1700000000.000100").join("\n")).toMatch(
      /HTML sign-in page.*files:read/s,
    );
  });

  it("rejects an oversized attachment from metadata before asking Slack for its bytes", async () => {
    const h = await coworkerHarness({ fileTransfer: { maxDownloadBytes: 8 } });

    await h.mention({
      eventId: "Ev_LARGE",
      files: [
        {
          id: "F_LARGE",
          name: "large.csv",
          mimetype: "text/csv",
          size: 9,
          url_private_download: "https://files.slack.com/files-pri/T_TEST-F_LARGE/large.csv",
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    expect(h.slack.downloadAttempts).toHaveLength(0);
    expect(h.engine.turns).toHaveLength(0);
    expect(h.slack.textsIn("1700000000.000100").join("\n")).toContain(
      "over the 8-byte attachment limit",
    );
  });

  it("sanitizes an attacker-controlled Slack filename before writing it", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_PATH/data.csv";
    const bytes = Buffer.from("safe,data\n", "utf8");
    h.slack.downloadableFiles.set(url, { bytes, contentType: "text/csv" });

    await h.mention({
      eventId: "Ev_PATH",
      files: [
        {
          id: "F_PATH",
          name: "../../../../outside.csv",
          mimetype: "text/csv",
          size: bytes.length,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    const workspace = h.engine.startedSessions[0]!.workingDirectory;
    const safePath = path.join(
      workspace,
      ".open-agent",
      "inputs",
      "Ev_PATH",
      "outside.csv",
    );
    await expect(readFile(safePath)).resolves.toEqual(bytes);
    expect(h.engine.turns[0]).toContain(safePath);
  });

  it("downloads an attached image and passes it to Codex as a visual input", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_IMAGE/dashboard.png";
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    h.slack.downloadableFiles.set(url, { bytes, contentType: "image/png" });

    await h.mention({
      eventId: "Ev_IMAGE",
      files: [
        {
          id: "F_IMAGE",
          name: "dashboard.png",
          mimetype: "image/png",
          size: bytes.length,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    const workspace = h.engine.startedSessions[0]!.workingDirectory;
    const imagePath = path.join(
      workspace,
      ".open-agent",
      "inputs",
      "Ev_IMAGE",
      "dashboard.png",
    );
    await expect(readFile(imagePath)).resolves.toEqual(bytes);
    expect(h.engine.ranTurns[0]).toEqual(
      expect.objectContaining({ imagePaths: [imagePath] }),
    );
    expect(h.engine.turns[0]).toContain(imagePath);
  });

  it("uses the filename to recognize a visual input when Slack reports a generic MIME type", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_JPEG/screenshot.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    h.slack.downloadableFiles.set(url, {
      bytes,
      contentType: "application/octet-stream",
    });

    await h.mention({
      eventId: "Ev_GENERIC_IMAGE",
      files: [
        {
          id: "F_JPEG",
          name: "screenshot.jpg",
          mimetype: "application/octet-stream",
          size: bytes.length,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    const workspace = h.engine.startedSessions[0]!.workingDirectory;
    const imagePath = path.join(
      workspace,
      ".open-agent",
      "inputs",
      "Ev_GENERIC_IMAGE",
      "screenshot.jpg",
    );
    expect(h.engine.ranTurns[0]).toEqual(
      expect.objectContaining({ imagePaths: [imagePath] }),
    );
  });

  it("does not let a supported filename extension override an explicitly unsupported MIME type", async () => {
    const h = await coworkerHarness();

    await h.mention({
      eventId: "Ev_DISGUISED_IMAGE",
      files: [
        {
          id: "F_DISGUISED_SKETCH",
          name: "dashboard.csv",
          mimetype: "application/x-sketch",
          size: 100,
          url_private_download:
            "https://files.slack.com/files-pri/T_TEST-F_IMAGE/dashboard.csv",
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    expect(h.slack.downloadAttempts).toHaveLength(0);
    expect(h.engine.turns).toHaveLength(0);
    expect(h.slack.textsIn("1700000000.000100").join("\n")).toContain(
      "I cannot read dashboard.csv (application/x-sketch)",
    );
  });

  it("tells the Librarian which Slack source file could have informed a Note", async () => {
    const h = await coworkerHarness();
    const url = "https://files.slack.com/files-pri/T_TEST-F_SOURCE/source.csv";
    const bytes = Buffer.from("fact,value\nretention,92\n", "utf8");
    h.slack.downloadableFiles.set(url, { bytes, contentType: "text/csv" });
    h.engine.script = async () => {
      await writeFile(path.join(h.notesDir, "Retention.md"), "# Retention\n\n92%\n");
      return [{ type: "message", text: "Retention is 92%." }];
    };

    await h.mention({
      eventId: "Ev_SOURCE",
      files: [
        {
          id: "F_SOURCE",
          name: "source.csv",
          mimetype: "text/csv",
          size: bytes.length,
          url_private_download: url,
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    expect(h.engine.librarianPrompts[0]).toContain("source.csv");
    expect(h.engine.librarianPrompts[0]).toContain("Slack Thread files");
    expect(await readFile(path.join(h.notesDir, "Retention.md"), "utf8")).toContain(
      'source-files: ["source.csv"]',
    );
  });
});

describe("result files shared back to Slack", () => {
  it("uploads a file deliberately placed in the Job output directory to the same Thread", async () => {
    const h = await coworkerHarness();
    const bytes = Buffer.from("region,revenue\nwest,4200\n", "utf8");
    h.engine.script = async ({ workingDirectory }) => {
      const output = path.join(
        workingDirectory,
        ".open-agent",
        "outputs",
        "Ev_OUTPUT",
        "revenue.csv",
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
      return [{ type: "message", text: "I attached the revenue export." }];
    };

    await h.mention({
      eventId: "Ev_OUTPUT",
      channel: "C_FINANCE",
      thread_ts: "1700000042.000100",
    });

    expect(h.slack.uploads).toEqual([
      expect.objectContaining({
        thread: { channel: "C_FINANCE", ts: "1700000042.000100" },
        filename: "revenue.csv",
        bytes,
      }),
    ]);
    const thread = h.slack.textsIn("1700000042.000100");
    expect(thread).toHaveLength(2);
    expect(thread.join("\n")).not.toContain("Uploaded a result file");
    expect(h.engine.turns[0]).toContain(
      path.join(
        h.engine.startedSessions[0]!.workingDirectory,
        ".open-agent",
        "outputs",
        "Ev_OUTPUT",
      ),
    );
  });

  it("performs no file upload when the Job produces no result artifact", async () => {
    const h = await coworkerHarness();

    await h.mention({ eventId: "Ev_NO_OUTPUT" });

    expect(h.slack.uploads).toHaveLength(0);
  });

  it("reports an upload failure instead of claiming the artifact was shared", async () => {
    const h = await coworkerHarness();
    h.slack.failUploads = new Error("missing_scope: files:write");
    h.engine.script = async ({ workingDirectory }) => {
      const output = path.join(
        workingDirectory,
        ".open-agent",
        "outputs",
        "Ev_UPLOAD_FAIL",
        "report.pdf",
      );
      await writeFile(output, Buffer.from("%PDF-result"));
      return [{ type: "message", text: "I attached report.pdf." }];
    };

    await h.mention({ eventId: "Ev_UPLOAD_FAIL" });

    expect(h.slack.uploads).toHaveLength(0);
    const thread = h.slack.textsIn("1700000000.000100").join("\n");
    expect(thread).toContain("missing_scope: files:write");
    expect(thread).toContain("I could not share a result file");
    expect(thread).not.toContain("I attached report.pdf");
  });

  it("rejects an oversized result before asking Slack to upload it", async () => {
    const h = await coworkerHarness({ fileTransfer: { maxUploadBytes: 4 } });
    h.engine.script = async ({ workingDirectory }) => {
      await writeFile(
        path.join(workingDirectory, ".open-agent", "outputs", "Ev_BIG_RESULT", "large.bin"),
        Buffer.from("12345"),
      );
      return [{ type: "message", text: "The export is ready." }];
    };

    await h.mention({ eventId: "Ev_BIG_RESULT" });

    expect(h.slack.uploads).toHaveLength(0);
    const thread = h.slack.textsIn("1700000000.000100").join("\n");
    expect(thread).toContain("over the 4-byte result-file limit");
    expect(thread).toContain("I could not share a result file");
  });

  it("does not follow a symlink placed in the output directory", async () => {
    const h = await coworkerHarness();
    h.engine.script = async ({ workingDirectory }) => {
      const outputDir = path.join(
        workingDirectory,
        ".open-agent",
        "outputs",
        "Ev_LINK",
      );
      const privateFile = path.join(workingDirectory, "private.txt");
      await writeFile(privateFile, "do not upload");
      await symlink(privateFile, path.join(outputDir, "result.txt"));
      return [{ type: "message", text: "Done." }];
    };

    await h.mention({ eventId: "Ev_LINK" });

    expect(h.slack.uploads).toHaveLength(0);
  });

  it("still answers and releases the Thread when the agent removes its output directory", async () => {
    const h = await coworkerHarness();
    h.engine.script = async ({ workingDirectory }) => {
      await rm(path.join(workingDirectory, ".open-agent", "outputs", "Ev_REMOVED"), {
        recursive: true,
        force: true,
      });
      return [{ type: "message", text: "No artifact was needed." }];
    };

    await h.mention({ eventId: "Ev_REMOVED" });
    await h.mention({ eventId: "Ev_AFTER_REMOVED" });

    expect(h.slack.textsIn("1700000000.000100")).toContain("No artifact was needed.");
    expect(h.engine.turns).toHaveLength(2);
  });
});
