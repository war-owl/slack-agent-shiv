import { describe, expect, it } from "vitest";
import { createGitHubAppProbe } from "../../src/github/app.ts";
import { ghCli } from "../../src/github/cli.ts";
import { createMcpInventoryProber } from "../../src/mcp/prober.ts";
import { systemClock } from "../../src/ports/clock.ts";
import type { McpServerConfig } from "../../src/ports/mcp.ts";

/**
 * The other two contract seams: a real MCP server, and a real GitHub App.
 *
 * Same reasoning as `codex-exec.test.ts`. Preflight's whole value is that it tells the truth
 * about somebody else's deployment, and the two adapters that go and ask — `mcp/prober.ts`
 * and `github/app.ts` — are exactly where a fake can be confidently wrong. A `FakeGitHubApp`
 * that returns a tidy installation proves that `preflight/github.ts` reads it correctly and
 * proves nothing whatsoever about whether an installation token can be minted.
 *
 * **Each block skips when its credential is absent**, so this file is useful to run with one
 * of them, both, or neither. A skipped test is honest; a passing one against a fake would
 * not be. See `docs/configuration.md` for what these variables are.
 */

const linearToken = process.env.LINEAR_API_KEY?.trim();
const appId = process.env.GITHUB_APP_ID?.trim();
const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();

describe.skipIf(!linearToken)("probing a real MCP server", () => {
  const linear: McpServerConfig = {
    name: "linear",
    transport: "http",
    enabled: true,
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnvVar: "LINEAR_API_KEY",
    httpHeaders: {},
    envHttpHeaders: {},
    writeTools: [],
    disabledTools: [],
  };

  it("reads the tool inventory over streamable HTTP", async () => {
    const inventory = await createMcpInventoryProber(process.env).probe(linear);

    // Measured at 57 on 2026-07-27. Asserted as a floor rather than an equality because
    // this test proves the transport works; inventory changes are deliberately accepted.
    expect(inventory.tools.length).toBeGreaterThan(20);
    expect(inventory.tools).toContain("list_issues");
    // The two the deny-list is generated to cover. If either name has gone, `mcp/denylist.ts`
    // is guarding something that no longer exists and needs re-deriving from the real surface.
    expect(inventory.tools).toContain("merge_diff");
    expect(inventory.tools).toContain("submit_diff_review");
  });

  it("fails with the variable's name when the credential is wrong", async () => {
    const prober = createMcpInventoryProber({ LINEAR_API_KEY: "lin_api_definitely_not_valid" });

    // The failure a self-hoster is most likely to hit, and the one most likely to be
    // mistaken for the server being down.
    await expect(prober.probe(linear)).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe.skipIf(!appId || !privateKeyPath)("a real GitHub App installation", () => {
  it("mints an installation token and reports what it reaches", async () => {
    const { readFile } = await import("node:fs/promises");
    const probe = createGitHubAppProbe({
      credentials: {
        appId: appId ?? "",
        privateKeyPem: await readFile(privateKeyPath ?? "", "utf8"),
      },
      clock: systemClock,
    });

    const reach = await probe.probe({ owner: process.env.GITHUB_APP_OWNER });

    // The load-bearing assertion: a token was actually derived. ADR-0006 rests on the
    // credential being minted at runtime, so a probe that validated only the private key
    // would be checking the half that never expires.
    expect(reach.tokenExpiresAt).toMatch(/^\d{4}-/);
    expect(reach.installation.id).toBeGreaterThan(0);
    expect(reach.installation.repositorySelection).toMatch(/^(all|selected)$/);
    // And that the permission set is readable, since startup refuses on three of its keys.
    expect(Object.keys(reach.installation.permissions).length).toBeGreaterThan(0);
  });

  it("says so when the App is not installed on the named account", async () => {
    const { readFile } = await import("node:fs/promises");
    const probe = createGitHubAppProbe({
      credentials: {
        appId: appId ?? "",
        privateKeyPem: await readFile(privateKeyPath ?? "", "utf8"),
      },
      clock: systemClock,
    });

    await expect(probe.probe({ owner: "an-org-that-does-not-exist-here" })).rejects.toThrow(
      /not installed on/,
    );
  });
});

describe("the gh CLI", () => {
  it("reports a version, or nothing at all", async () => {
    const version = await ghCli.version();

    // Either shape is a real answer: `undefined` is what "not on PATH" looks like, and
    // preflight treats that as fatal only when GitHub is configured. What must not happen is
    // a throw, which would take startup down over a program that is allowed to be absent.
    expect(version === undefined || /^\d+\.\d+/.test(version)).toBe(true);
  });
});
