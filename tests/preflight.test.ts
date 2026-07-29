import { describe, expect, it } from "vitest";
import { RECORDED_CODEX_VERSION, RECORDED_GH_VERSION } from "../src/config.ts";
import { coworkerHarness, type PartialConnector } from "./support/harness.ts";

/**
 * Preflight: the instance either runs, or it says exactly what is wrong.
 *
 * The whole file is about one distinction, so it is worth stating once. Some things preflight
 * finds are **reports** — an instance that will work, described so a self-hoster can see what
 * they have configured. Others are **refusals** — an instance that would run perfectly while
 * being a different instance from the one the documentation describes. Nearly every test here
 * asserts which of the two a given condition is, because getting that wrong in either
 * direction is the actual failure: a refusal where a warning belonged locks somebody out of
 * their own tool, and a warning where a refusal belonged is a silent capability gain.
 *
 * The credential store is injected (`env`), so nothing here passes or fails because of what
 * happens to be exported in the shell that ran the tests.
 */

/** Linear's real shape, cut down: some reads, an upsert, and the two blocked verbs. */
const LINEAR_TOOLS = [
  "list_issues",
  "get_issue",
  "save_issue",
  "save_comment",
  "delete_comment",
  "delete_attachment",
  "merge_diff",
  "submit_diff_review",
];

function linear(overrides: Partial<PartialConnector> = {}): PartialConnector {
  return {
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnvVar: "LINEAR_API_KEY",
    writeTools: ["save_issue", "save_comment"],
    pinnedTools: LINEAR_TOOLS,
    ...overrides,
  };
}

/** Whatever the environment has to hold for a given connector to be probed at all. */
const WITH_LINEAR_TOKEN = { LINEAR_API_KEY: "lin_api_test" };

describe("the engine and the bounds", () => {
  it("reports the installed engine version", async () => {
    const h = await coworkerHarness();
    h.engine.versionToReport = RECORDED_CODEX_VERSION;

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain(`Codex version ${RECORDED_CODEX_VERSION}`);
    expect(h.warnings).toEqual([]);
  });

  it("warns when the installed engine version has drifted from the recorded one", async () => {
    const h = await coworkerHarness();
    h.engine.versionToReport = "0.146.0-alpha.13";

    await h.coworker.preflight();

    const warning = h.warnings.join("\n");
    expect(warning).toContain("0.146.0-alpha.13");
    expect(warning).toContain(RECORDED_CODEX_VERSION);
  });

  it("reports the sandbox the engine actually puts a Job in", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    // Read off the adapter rather than restated, so this line cannot claim a posture the
    // engine does not configure. It is layer 2 for everything reached by shell.
    const logs = h.logs.join("\n");
    expect(logs).toContain("workspace-write");
    expect(logs).toMatch(/network enabled/);
    expect(logs).toMatch(/execpolicy unrestricted/);
  });

  it("reports the bounds, including one a self-hoster has lowered", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 90_000 } });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("90s per Turn");
  });

  it("says where its configuration came from", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("Configuration: the test harness");
  });
});

describe("credentials", () => {
  it("refuses to start when Slack rejects the bot token", async () => {
    const h = await coworkerHarness();
    h.slack.failIdentity = new Error("invalid_auth");

    // The alternative is a Job that accepts work in a Thread, does it, and cannot say so.
    await expect(h.coworker.preflight()).rejects.toThrow(/invalid_auth/);
  });

  it("names the workspace and the bot user it connected as", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("A Test Workspace");
  });

  it("refuses to start when a connector's bearer token variable is not set", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: {} });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Both halves named: the variable, and the connector that asked for it.
    expect(String(failure)).toContain("LINEAR_API_KEY");
    expect(String(failure)).toContain("linear");
    // And it never reached the network — a probe with no credential fails as a transport
    // error, which reads like the server being down.
    expect(h.inventoryProber.probed).toEqual([]);
  });
});

describe("a connector's tool inventory", () => {
  it("reports it, and the fingerprint it matched", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    const logs = h.logs.join("\n");
    expect(logs).toContain(`Connector linear: ${LINEAR_TOOLS.length} tools`);
    expect(logs).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("does not read a reordered inventory as a change", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: [...LINEAR_TOOLS].reverse() });

    // A false alarm here is worse than none: the remedy for an alarm is "re-pin", and an
    // operator who has learned that re-pinning is routine will re-pin the day it matters.
    await h.coworker.preflight();

    expect(h.warnings).toEqual([]);
  });

  it("fails loudly, naming the tool that appeared, when the server has grown one", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", {
      tools: [...LINEAR_TOOLS, "merge_and_deploy"],
    });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Not survivable: a connector growing a tool is a silent capability gain, and Linear
    // shipping `merge_diff` unannounced is the measured evidence that it happens.
    expect(String(failure)).toContain("merge_and_deploy");
    // With the new fingerprint in hand, because re-pinning is the intended outcome of an
    // informed review and nobody should have to compute a hash to act on this.
    expect(String(failure)).toMatch(/sha256:[0-9a-f]{64}/);
  });

  it("fails loudly, naming the tool that went away, when the server has dropped one", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", {
      tools: LINEAR_TOOLS.filter((tool) => tool !== "get_issue"),
    });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    expect(String(failure)).toContain("get_issue");
  });

  it("refuses to start an unpinned connector, and hands over the inventory to pin", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ pinnedTools: [] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Adopting whatever the server says on first run would make the mechanism worthless:
    // the one moment a human is certainly watching is the moment they add the connector.
    expect(String(failure)).toMatch(/no pinned tool inventory/i);
    // Costing a paste rather than a script.
    expect(String(failure)).toContain("save_issue");
  });

  it("warns when a connector names a writing tool it does not have", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ writeTools: ["save_issue", "save_issues"] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // The cost of the typo is silence: Writes through the tool that was meant would never
    // reach the Thread, and nothing else would ever mention it.
    const warning = h.warnings.join("\n");
    expect(warning).toContain("save_issues");
    expect(warning).not.toContain("list_issues");
  });

  it("says so plainly when nothing is configured", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toMatch(/Connectors: none configured/);
  });
});

describe("the generated deny-list", () => {
  it("covers the irreversible tools without being asked to", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // Generated from the pin rather than configured, so it cannot be forgotten and cannot
    // be mistyped — a deny-list entry naming a tool that does not exist is a boundary that
    // silently is not there.
    const logs = h.logs.join("\n");
    expect(logs).toContain("merge_diff");
    expect(logs).toContain("submit_diff_review");
    expect(logs).toContain("delete_comment");
    expect(logs).toContain("delete_attachment");
  });

  it("leaves the tools the coworker is meant to have", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // The criterion is "can a human undo this after noticing it in the Thread?", not
    // "is it a write" — `save_issue` is an upsert and stays available.
    const disabled = h.logs.join("\n").match(/tool\(s\) disabled.*/)?.[0] ?? "";
    expect(disabled).not.toContain("save_issue");
    expect(disabled).not.toContain("list_issues");
  });

  it("takes anything else a self-hoster adds", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ disabledTools: ["save_comment"] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    const disabled = h.logs.join("\n").match(/tool\(s\) disabled.*/)?.[0] ?? "";
    expect(disabled).toContain("save_comment");
    // Configuration adds to the floor; it cannot lower it.
    expect(disabled).toContain("merge_diff");
  });

  it("warns about a configured deny-list entry the server does not advertise", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ disabledTools: ["delete_evrything"] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // Harmless to Codex, and worth saying: somebody wrote that name believing it was
    // protecting them.
    expect(h.warnings.join("\n")).toContain("delete_evrything");
  });

  it("routes a newly added connector through the same floor", async () => {
    const h = await coworkerHarness({
      mcpServers: [
        linear(),
        {
          name: "wiki",
          url: "https://mcp.example.com/mcp",
          bearerTokenEnvVar: "WIKI_TOKEN",
          writeTools: ["save_page"],
          pinnedTools: ["get_page", "save_page", "delete_page"],
        },
      ],
      env: { ...WITH_LINEAR_TOKEN, WIKI_TOKEN: "wiki_test" },
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });
    h.inventoryProber.inventories.set("wiki", {
      tools: ["get_page", "save_page", "delete_page"],
    });

    await h.coworker.preflight();

    // Extension cannot quietly widen the blast radius: a connector nobody wrote a policy
    // for still arrives with `delete_*` disabled.
    expect(h.logs.join("\n")).toMatch(/Connector wiki: 1 tool\(s\) disabled.*delete_page/);
  });
});

describe("GitHub — an installation, not an inventory", () => {
  it("says nothing is configured when nothing is", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toMatch(/GitHub: not configured/);
    // And it does not go looking: an instance with no App has no GitHub problems.
    expect(h.github.probes).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("mints a test installation token at startup", async () => {
    const h = await coworkerHarness({ github: {} });

    await h.coworker.preflight();

    // The credential that matters is the one derived at runtime, so validating the private
    // key alone would prove the half that never expires.
    expect(h.github.probes).toHaveLength(1);
    expect(h.logs.join("\n")).toMatch(/Test token minted/);
  });

  it("reports the resolved repository list rather than the configured one", async () => {
    const h = await coworkerHarness({ github: { repositories: ["acme/web"] } });

    await h.coworker.preflight();

    // The coworker's actual reach, chosen in GitHub's UI at some point in the past by
    // somebody who may not be reading this.
    const logs = h.logs.join("\n");
    expect(logs).toContain("acme/web");
    expect(logs).toContain("acme/infra");
  });

  it("refuses to start when configuration names a repository the installation lacks", async () => {
    const h = await coworkerHarness({ github: { repositories: ["acme/web", "acme/billing"] } });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Both sides named, because either could be the mistake — and its natural failure is a
    // 404 deep inside a `gh` call that reads like the repository not existing.
    expect(String(failure)).toContain("acme/billing");
    expect(String(failure)).toContain("acme/infra");
  });

  it("warns when the installation covers every repository in the account", async () => {
    const h = await coworkerHarness({ github: {} });
    h.github.installation = {
      ...h.github.installation,
      repositorySelection: "all",
      repositories: ["acme/web", "acme/infra", "acme/secrets"],
    };

    await h.coworker.preflight();

    // Repository selection is the one boundary this design does have, and "all" declines it.
    expect(h.warnings.join("\n")).toMatch(/all\*{0,2} of acme's/i);
    // And the list is still named. A count alone would make the report least informative
    // exactly where the reach is widest.
    expect(h.logs.join("\n")).toContain("acme/secrets");
  });

  it("still catches a misspelled repository on an all-repositories installation", async () => {
    const h = await coworkerHarness({ github: { repositories: ["acme/websites"] } });
    h.github.installation = { ...h.github.installation, repositorySelection: "all" };

    // Tempting to skip — "all" surely covers anything named — and wrong: the grant list came
    // back moments ago, so a name missing from it is a repository that does not exist under
    // that name, which is the same typo this check is for.
    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    expect(String(failure)).toContain("acme/websites");
  });

  it("warns when the installation grants no repositories at all", async () => {
    const h = await coworkerHarness({ github: {} });
    h.github.installation = { ...h.github.installation, repositories: [] };

    await h.coworker.preflight();

    expect(h.warnings.join("\n")).toMatch(/no repositories at all/);
  });

  it("refuses to start when the App is not installed", async () => {
    const h = await coworkerHarness({ github: {} });
    h.github.failure = new Error("the App exists but is not installed anywhere");

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Visibly, rather than degrading to public-only reads the way an unapproved PAT did.
    expect(String(failure)).toMatch(/not installed anywhere/);
    expect(String(failure)).toMatch(/approve/i);
  });

  it("reports the permissions the App carries", async () => {
    const h = await coworkerHarness({ github: {} });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toMatch(/permissions:.*contents: write/);
  });

  it("refuses to start when the App carries a permission the manifest must not declare", async () => {
    const h = await coworkerHarness({ github: {} });
    h.github.installation = {
      ...h.github.installation,
      permissions: { contents: "write", workflows: "write" },
    };

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // A writable CI definition is an execution path around every other control.
    expect(String(failure)).toContain("workflows");
    expect(String(failure)).not.toMatch(/^.*contents: write.*$/m);
  });

  it("states that GitHub has no layer-2 deny-list", async () => {
    const h = await coworkerHarness({ github: {} });

    await h.coworker.preflight();

    // Said in the same place, at the same moment, as build/10's branch-protection warning:
    // the two halves of the weakened boundary being visible apart is how an operator
    // concludes only one of them applies to them.
    const warning = h.warnings.join("\n");
    expect(warning).toMatch(/no layer-2 deny-list/i);
    expect(warning).toContain("ADR-0006");
  });

  it("states it even when a later GitHub check refuses to start", async () => {
    const h = await coworkerHarness({ github: {} });
    h.github.failure = new Error("the App exists but is not installed anywhere");

    await h.coworker.preflight().catch(() => undefined);

    // Printed before anything that can throw, on purpose: a statement made after the
    // failing checks is a statement the self-hoster with a broken App never reads — and
    // they are the one who most needs to know what is not protecting them.
    expect(h.warnings.join("\n")).toMatch(/no layer-2 deny-list/i);
  });
});

describe("the gh CLI, which is now a dependency", () => {
  it("reports the installed version", async () => {
    const h = await coworkerHarness({ github: {} });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain(`gh version ${RECORDED_GH_VERSION}`);
  });

  it("warns when it has drifted from the recorded one", async () => {
    const h = await coworkerHarness({ github: {} });
    h.gh.versionToReport = "2.40.0";

    await h.coworker.preflight();

    // No pin: a lock-out over a minor version would have nothing behind it. But a Skill
    // issuing a flag this version removed fails inside a Job, unattended.
    const warning = h.warnings.join("\n");
    expect(warning).toContain("2.40.0");
    expect(warning).toContain(RECORDED_GH_VERSION);
  });

  it("refuses to start when GitHub is configured and there is no gh at all", async () => {
    const h = await coworkerHarness({ github: {} });
    h.gh.versionToReport = undefined;

    // Since ADR-0006 the coworker reaches GitHub by running `gh`, so this is a missing
    // dependency rather than a missing convenience.
    await expect(h.coworker.preflight()).rejects.toThrow(/no `gh` on PATH/);
  });

  it("does not care when GitHub is not configured", async () => {
    const h = await coworkerHarness();
    h.gh.versionToReport = undefined;

    await h.coworker.preflight();

    expect(h.warnings).toEqual([]);
  });
});
