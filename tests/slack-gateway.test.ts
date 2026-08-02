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
