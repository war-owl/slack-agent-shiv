import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import { slackClientFor } from "../src/slack/gateway.ts";

describe("Slack channel resolution", () => {
  it("uses an explicit channel ID without requiring channel-directory scopes", async () => {
    const list = vi.fn(async () => { throw new Error("missing_scope"); });
    const app = { client: { conversations: { list } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await expect(slack.resolveWritableChannel("<#C0347LT2MR6|random>"))
      .resolves.toEqual({ id: "C0347LT2MR6", name: "random" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("Slack message formatting", () => {
  it("sends model answers through Slack's standard Markdown field", async () => {
    const postMessage = vi.fn(async () => ({ ts: "1700000000.000100" }));
    const app = { client: { chat: { postMessage } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await slack.postMessage({
      thread: { channel: "C_PLATFORM", ts: "1699999999.000100" },
      text: "## Result\n\n| State | Count |\n| --- | ---: |\n| Open | 3 |",
      format: "markdown",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_PLATFORM",
      thread_ts: "1699999999.000100",
      markdown_text: "## Result\n\n| State | Count |\n| --- | ---: |\n| Open | 3 |",
    });
  });

  it("keeps app-authored operational messages on mrkdwn by default", async () => {
    const postMessage = vi.fn(async () => ({ ts: "1700000000.000100" }));
    const app = { client: { chat: { postMessage } } } as unknown as App;
    const slack = slackClientFor(app, "xoxb-test");

    await slack.postMessage({
      thread: { channel: "C_PLATFORM", ts: "1699999999.000100" },
      text: "*Working*",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_PLATFORM",
      thread_ts: "1699999999.000100",
      text: "*Working*",
    });
  });
});
