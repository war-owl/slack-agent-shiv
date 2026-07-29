import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_HEARTBEAT_MS } from "../src/reporter/status.ts";
import { deferred } from "./support/fakes.ts";
import { coworkerHarness, DEFAULT_THREAD_TS } from "./support/harness.ts";

/**
 * Audit: every Write appended.
 *
 * The coworker acts unattended, so the Thread is the only account anyone ever sees of
 * what it did. These tests are about that record: that it exists, that it is
 * permanent, that it names the thing that was written, and that Progress — the other
 * output channel, with deliberately opposite semantics — never touches it.
 *
 * A Job's Thread reads: the status message, then a Write record for each action taken
 * out in the world, then the answer. So the records are the messages between the
 * first and the last.
 */
function recordsIn(texts: string[]): string[] {
  return texts.slice(1, -1);
}

describe("the audit record of a Write", () => {
  it("appends a permanent message of its own naming what was written", async () => {
    const h = await coworkerHarness();
    h.engine.script = async () => {
      // The file is really written, because a Note's record comes from the Vault's own
      // contents rather than from this event (`vault/snapshot.ts`). The event is still
      // emitted, because a real engine emits it — and it is deliberately not what the
      // record is made from.
      await mkdir(path.join(h.notesDir, "people"), { recursive: true });
      await writeFile(path.join(h.notesDir, "people", "asha.md"), "Designer on Atlas.\n", "utf8");
      return [
        {
          type: "file-change",
          changes: [{ path: path.join(h.notesDir, "people", "asha.md"), kind: "add" }],
          status: "completed",
        },
        { type: "message", text: "Filed what I learned about Asha." },
      ];
    };

    await h.mention();

    const texts = h.slack.textsIn(DEFAULT_THREAD_TS);
    // The status message, the Write record, the answer — three separate messages.
    expect(texts).toHaveLength(3);
    const [record] = recordsIn(texts);
    expect(record).toMatch(/created/i);
    expect(record).toContain("people/asha.md");
    // Not folded into the answer, and not folded into the status message either.
    expect(texts[2]).toBe("Filed what I learned about Asha.");
  });

  it("is never edited afterwards, whatever progress does next", async () => {
    const h = await coworkerHarness();
    const wrote = deferred();
    const release = deferred();
    h.engine.script = async function* () {
      yield { type: "plan", steps: [{ text: "Write the note", completed: false }] };
      yield {
        type: "command",
        command: "gh issue comment 12 --body 'looking at this'",
        status: "completed",
        output: "",
        exitCode: 0,
      };
      wrote.resolve();
      await release.promise;
      // A plan revision after the Write: the status message has more to say, and the
      // record of what was done must not be what it says it in.
      yield { type: "plan", steps: [{ text: "Write the note", completed: true }] };
      yield { type: "message", text: "Updated the deploy note." };
    };

    const delivery = await h.startMention();
    await wrote.promise;
    await h.clock.advance(3 * STATUS_HEARTBEAT_MS);
    release.resolve();
    if (delivery.accepted) await delivery.completed;

    const statusTs = h.slack.tsOf(0);
    const recordTs = h.slack.tsOf(1);
    expect(h.slack.edits.length).toBeGreaterThan(0);
    expect(h.slack.edits.every((edit) => edit.ts === statusTs)).toBe(true);
    // One version, for the life of the Thread: the post, and nothing after it.
    expect(h.slack.versionsOf(recordTs)).toHaveLength(1);
  });

  it("appears in the order the Writes happened, the Vault's own changes last", async () => {
    const h = await coworkerHarness();
    await writeFile(path.join(h.notesDir, "stale.md"), "Out of date.\n", "utf8");
    h.engine.script = async () => {
      await writeFile(path.join(h.notesDir, "atlas.md"), "The payments rewrite.\n", "utf8");
      await rm(path.join(h.notesDir, "stale.md"));
      return [
        {
          type: "command",
          command: "gh issue comment 12 --body 'noted'",
          status: "completed",
          output: "",
          exitCode: 0,
        },
        {
          type: "command",
          command: "git push origin note-fixes",
          status: "completed",
          output: "To github.com:acme/vault.git\n   9a1f2c3..4d5e6f7  note-fixes -> note-fixes\n",
          exitCode: 0,
        },
        { type: "message", text: "Done." },
      ];
    };

    await h.mention();

    const records = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(records).toHaveLength(4);
    // What happened out in the world, in the order it happened.
    expect(records[0]).toContain("gh issue comment 12");
    expect(records[1]).toContain("git push origin note-fixes");
    // Then the Vault, as one block. Its records cannot come sooner: they carry a diff,
    // and a diff is the difference between the Vault before the Job and after it, which
    // does not exist until the Job is over. Documented in `vault/snapshot.ts`.
    expect(records[2]).toContain("atlas.md");
    expect(records[3]).toContain("stale.md");
    expect(records[3]).toMatch(/deleted/i);
  });

  it("links the thing that was written when the Write hands back a link", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      {
        type: "command",
        command: "gh pr create --fill",
        status: "completed",
        output:
          "Warning: 3 uncommitted changes\nhttps://github.com/acme/platform/pull/412\n",
        exitCode: 0,
      },
      { type: "message", text: "Opened the PR." },
    ];

    await h.mention();

    const [record] = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(record).toMatch(/pull request/i);
    expect(record).toContain("<https://github.com/acme/platform/pull/412|");
    // How it was done is still on the record, under the thing that was done.
    expect(record).toContain("gh pr create --fill");
  });

  it("records a Write whose command failed, because it may have partially landed", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      {
        type: "command",
        command: "git push origin main",
        status: "failed",
        output: "! [remote rejected] main -> main (protected branch hook declined)\n",
        exitCode: 1,
      },
      { type: "message", text: "The push was rejected — main is protected." },
    ];

    await h.mention();

    const [record] = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(record).toMatch(/git push origin main/);
    expect(record).toMatch(/failed/i);
  });

  it("records each action in a command that did several", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      // What the engine actually reports: one item per shell call, and a shell call is
      // a whole script. Recording only the first action recognised in it would lose
      // the pull request.
      {
        type: "command",
        command:
          `/bin/zsh -lc "git add -- README.md && git commit -m 'Fix the note' && ` +
          `git push -u origin fix/notes && gh pr create --fill"`,
        status: "completed",
        output: "https://github.com/acme/platform/pull/413\n",
        exitCode: 0,
      },
      { type: "message", text: "Pushed and opened a PR." },
    ];

    await h.mention();

    const records = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/pushed to a git remote/i);
    expect(records[1]).toMatch(/opened a pull request/i);
    expect(records[1]).toContain("<https://github.com/acme/platform/pull/413|");
  });

  it("says nothing about reading, thinking, or working in its own workspace", async () => {
    const h = await coworkerHarness();
    h.engine.script = ({ workingDirectory }) => [
      { type: "command", command: "ls -la", status: "completed", output: "", exitCode: 0 },
      { type: "command", command: "rg deploy", status: "completed", output: "", exitCode: 0 },
      { type: "reasoning", text: "The deploy config is probably in the workspace." },
      // Its own desk: a scratch script it wrote to answer the question. Progress, not
      // a Write — nothing outside itself changed.
      {
        type: "file-change",
        changes: [{ path: path.join(workingDirectory, "analyse.py"), kind: "add" }],
        status: "completed",
      },
      { type: "message", text: "We deploy from `main`." },
    ];

    await h.mention();

    // The status message and the answer, and nothing appended in between.
    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toHaveLength(2);
  });

  it("tells a request that sends something from one that only reads", async () => {
    const h = await coworkerHarness();
    h.engine.script = () => [
      // `-D` dumps the response headers to a file and `-d` sends a body. One is a read
      // of someone else's service and the other is a Write to it, and the difference is
      // the case of a single letter.
      {
        type: "command",
        command: `/bin/zsh -lc "curl -sS -D headers.txt https://api.example.com/status"`,
        status: "completed",
        output: "",
        exitCode: 0,
      },
      {
        type: "command",
        command: `/bin/zsh -lc "curl -sS -d '{\\"ok\\":true}' https://api.example.com/hooks"`,
        status: "completed",
        output: "",
        exitCode: 0,
      },
      { type: "message", text: "Done." },
    ];

    await h.mention();

    const records = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(records).toHaveLength(1);
    expect(records[0]).toContain("api.example.com/hooks");
  });

  it("does not record a file change the engine failed to apply", async () => {
    const h = await coworkerHarness();
    // Outside the Vault on purpose: a Vault path is answered for by the Vault's contents,
    // where this is about the engine's own report of a patch that did not land.
    h.engine.script = () => [
      {
        type: "file-change",
        changes: [{ path: path.join(h.root, "elsewhere", "asha.md"), kind: "update" }],
        status: "failed",
      },
      { type: "message", text: "I could not write that note." },
    ];

    await h.mention();

    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toHaveLength(2);
  });
});

describe("a connector's Writes", () => {
  const withLinear = () =>
    coworkerHarness({
      mcpServers: [
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          bearerTokenEnvVar: "LINEAR_API_KEY",
          // Which of a connector's tools write is configuration, not code (ADR-0005).
          writeTools: ["save_issue", "save_comment"],
        },
      ],
    });

  it("flows through the same reporting path as a local one", async () => {
    const h = await withLinear();
    h.engine.script = () => [
      {
        type: "tool-call",
        server: "linear",
        tool: "save_issue",
        status: "completed",
        error: undefined,
        result: '{"identifier":"ENG-412","url":"https://linear.app/acme/issue/ENG-412"}',
      },
      { type: "message", text: "Filed ENG-412." },
    ];

    await h.mention();

    const [record] = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(record).toContain("linear");
    expect(record).toContain("save_issue");
    expect(record).toContain("<https://linear.app/acme/issue/ENG-412|");
  });

  it("links where a human would look, not where the API answered", async () => {
    const h = await coworkerHarness({
      mcpServers: [
        {
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          bearerTokenEnvVar: "GH_PAT",
          writeTools: ["create_pull_request"],
        },
      ],
    });
    h.engine.script = () => [
      {
        type: "tool-call",
        server: "github",
        tool: "create_pull_request",
        status: "completed",
        error: undefined,
        // GitHub answers with the API address first and the page second. A record
        // pointing at `api.github.com` identifies the pull request without being
        // somewhere anyone can go and read it.
        result:
          '{"url":"https://api.github.com/repos/acme/platform/pulls/9",' +
          '"html_url":"https://github.com/acme/platform/pull/9","number":9}',
      },
      { type: "message", text: "Opened the PR." },
    ];

    await h.mention();

    const [record] = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    expect(record).toContain("<https://github.com/acme/platform/pull/9|");
    expect(record).not.toContain("api.github.com");
  });

  it("leaves reads out of the record", async () => {
    const h = await withLinear();
    h.engine.script = () => [
      {
        type: "tool-call",
        server: "linear",
        tool: "list_issues",
        status: "completed",
        error: undefined,
        result: '[{"identifier":"ENG-1"}]',
      },
      { type: "message", text: "Twelve open issues." },
    ];

    await h.mention();

    expect(h.slack.textsIn(DEFAULT_THREAD_TS)).toHaveLength(2);
  });

  it("records an attempted Write the connector refused", async () => {
    const h = await withLinear();
    h.engine.script = () => [
      {
        type: "tool-call",
        server: "linear",
        tool: "save_issue",
        status: "failed",
        error: "team not found",
        result: undefined,
      },
      { type: "message", text: "I could not file that." },
    ];

    await h.mention();

    const [record] = recordsIn(h.slack.textsIn(DEFAULT_THREAD_TS));
    // A connector answers for one call, so this record can say plainly that it did not
    // happen — where a shell command's exit code cannot say that about a chain.
    expect(record).toMatch(/refused/i);
    expect(record).toContain("team not found");
  });
});

describe("when the record itself cannot be posted", () => {
  it("finishes the Job and says the trail has a hole in it", async () => {
    const h = await coworkerHarness();
    h.engine.script = async () => {
      await writeFile(path.join(h.notesDir, "asha.md"), "Designer on Atlas.\n", "utf8");
      // The status message is already posted, so this refusal lands on the record.
      h.slack.failNextPost = new Error("slack is down");
      return [{ type: "message", text: "Filed what I learned about Asha." }];
    };

    await h.mention();

    const texts = h.slack.textsIn(DEFAULT_THREAD_TS);
    // The work is still reported — a Slack refusal does not fail a Job — but the
    // answer says the record is incomplete rather than letting the gap pass silently.
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("Filed what I learned about Asha.");
    expect(texts[1]).toMatch(/record/i);
    // And the record that could not be posted is in the instance's own log, so it is
    // recoverable by the person who runs it.
    expect(h.warnings.join("\n")).toContain("asha.md");
  });
});
