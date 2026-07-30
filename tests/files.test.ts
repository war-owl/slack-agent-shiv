import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coworkerHarness } from "./support/harness.ts";

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

  it("fails honestly for an image type the headless engine has not been verified to read", async () => {
    const h = await coworkerHarness();

    await h.mention({
      eventId: "Ev_IMAGE",
      files: [
        {
          id: "F_IMAGE",
          name: "dashboard.png",
          mimetype: "image/png",
          size: 100,
          url_private_download: "https://files.slack.com/files-pri/T_TEST-F_IMAGE/dashboard.png",
        },
      ],
    } as Parameters<typeof h.mention>[0]);

    expect(h.slack.downloadAttempts).toHaveLength(0);
    expect(h.engine.turns).toHaveLength(0);
    expect(h.slack.textsIn("1700000000.000100").join("\n")).toContain(
      "I cannot read dashboard.png (image/png)",
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
    expect(h.engine.librarianPrompts[0]).toContain("Slack attachment");
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
    expect(h.slack.textsIn("1700000042.000100").join("\n")).toContain(
      "Uploaded a result file",
    );
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
      return [{ type: "message", text: "The report is ready." }];
    };

    await h.mention({ eventId: "Ev_UPLOAD_FAIL" });

    expect(h.slack.uploads).toHaveLength(0);
    const thread = h.slack.textsIn("1700000000.000100").join("\n");
    expect(thread).toContain("Tried to upload a result file");
    expect(thread).toContain("missing_scope: files:write");
    expect(thread).toContain("I could not share a result file");
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
});
