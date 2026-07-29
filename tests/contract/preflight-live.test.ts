import { describe, expect, it } from "vitest";
import { createMcpInventoryProber } from "../../src/mcp/prober.ts";
import type { McpServerConfig } from "../../src/ports/mcp.ts";

/**
 * Real MCP transport checks. Each block skips when its credential is absent, so a skipped
 * test is honest and a fake cannot claim an external deployment works.
 */

const linearToken = process.env.LINEAR_API_KEY?.trim();
const githubToken = process.env.GITHUB_TOKEN?.trim();

describe.skipIf(!linearToken)("probing the real Linear MCP server", () => {
  const linear: McpServerConfig = {
    name: "linear",
    transport: "http",
    enabled: true,
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnvVar: "LINEAR_API_KEY",
    httpHeaders: {},
    envHttpHeaders: {},
    disabledTools: [],
  };

  it("reads the live tool inventory", async () => {
    const inventory = await createMcpInventoryProber(process.env).probe(linear);

    expect(inventory.tools.length).toBeGreaterThan(20);
    expect(inventory.tools).toContain("list_issues");
    expect(inventory.tools).toContain("merge_diff");
  });

  it("names the credential variable when authentication fails", async () => {
    const prober = createMcpInventoryProber({ LINEAR_API_KEY: "lin_api_definitely_not_valid" });

    await expect(prober.probe(linear)).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe.skipIf(!githubToken)("probing the official GitHub MCP server", () => {
  const github: McpServerConfig = {
    name: "github",
    transport: "http",
    enabled: true,
    url: "https://api.githubcopilot.com/mcp/",
    bearerTokenEnvVar: "GITHUB_TOKEN",
    httpHeaders: {
      "X-MCP-Toolsets": "repos,issues,pull_requests",
      "X-MCP-Exclude-Tools": "merge_pull_request,delete_file",
    },
    envHttpHeaders: {},
    disabledTools: ["merge_pull_request", "delete_file"],
  };

  it("reads tools while server-side exclusions remain absent", async () => {
    const inventory = await createMcpInventoryProber(process.env).probe(github);

    expect(inventory.tools.length).toBeGreaterThan(5);
    expect(inventory.tools).toContain("create_pull_request");
    expect(inventory.tools).not.toContain("merge_pull_request");
    expect(inventory.tools).not.toContain("delete_file");
  });
});
