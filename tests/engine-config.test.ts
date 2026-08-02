import { describe, expect, it } from "vitest";
import { engineConfig } from "../src/engine/codex.ts";
import type { McpHttpServerConfig } from "../src/ports/mcp.ts";

const github: McpHttpServerConfig = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  bearerTokenEnvVar: "GITHUB_TOKEN",
  httpHeaders: {},
  envHttpHeaders: {},
  enabled: true,
  disabledTools: [],
  startupTimeoutSec: undefined,
  toolTimeoutSec: undefined,
};

describe("the engine's external tools", () => {
  it("never asks for interactive approval because Slack Jobs have no approval channel", () => {
    expect(engineConfig([]).approval_policy).toBe("never");
  });

  it("disables inherited Codex Apps while preserving explicitly configured MCP servers", () => {
    const config = engineConfig([github]);

    expect(config.features).toEqual({ apps: false });
    expect(config.mcp_servers).toMatchObject({
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        bearer_token_env_var: "GITHUB_TOKEN",
        enabled: true,
      },
    });
  });

  it("auto-approves only a server explicitly trusted for unattended tool calls", () => {
    const schedules: McpHttpServerConfig = {
      ...github,
      name: "schedules",
      defaultToolsApprovalMode: "approve",
    };

    const config = engineConfig([github, schedules]);

    expect(config.mcp_servers).toMatchObject({
      schedules: { default_tools_approval_mode: "approve" },
    });
    expect((config.mcp_servers as Record<string, unknown>).github)
      .not.toHaveProperty("default_tools_approval_mode");
  });

  it("still disables Codex Apps when no MCP server is configured", () => {
    const config = engineConfig([]);

    expect(config.features).toEqual({ apps: false });
    expect(config).not.toHaveProperty("mcp_servers");
  });
});
