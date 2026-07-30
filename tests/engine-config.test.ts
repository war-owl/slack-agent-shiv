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

  it("still disables Codex Apps when no MCP server is configured", () => {
    const config = engineConfig([]);

    expect(config.features).toEqual({ apps: false });
    expect(config).not.toHaveProperty("mcp_servers");
  });
});
