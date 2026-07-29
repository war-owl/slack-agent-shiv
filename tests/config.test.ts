import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  BOUND_DEFAULTS,
  DEFAULT_CONFIG_FILENAME,
  loadConfig,
  type ConfigFile,
} from "../src/config.ts";
import { NOTES_DIRNAME, SKILLS_DIRNAME } from "../src/vault/skills.ts";
import { testTempDir } from "./support/test-root.ts";

/**
 * Configuration: **one file, and secrets in the environment.**
 *
 * The property under test throughout is that the two never swap places. The file names
 * credentials and never contains them, so it is safe to commit; the environment holds them
 * and configures nothing else, so an instance cannot end up running with a bound nobody
 * wrote down. Every test here is about one edge of that split, or about a message being
 * good enough to act on — which for a startup failure is the whole feature.
 *
 * A real file in a real directory, because "relative paths resolve against the file" is a
 * claim about the filesystem.
 */

/** A configuration file on disk, and the environment that goes with it. */
async function configFile(
  contents: ConfigFile | string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await testTempDir("open-agent-config-");
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, DEFAULT_CONFIG_FILENAME);
  await writeFile(
    filePath,
    typeof contents === "string" ? contents : JSON.stringify(contents, undefined, 2),
    "utf8",
  );
  return { dir, filePath };
}

/** The two credentials every instance needs, under the names the defaults expect. */
const SLACK_TOKENS = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" };

describe("the configuration file", () => {
  it("needs no configuration file at all", async () => {
    // The walking skeleton's shape — a Slack bot with a Vault and no connectors. Requiring
    // an empty file to say so would be ceremony. Asserted on the source rather than on the
    // values, because whether this developer's checkout happens to have a real
    // `open-agent.config.json` in it is not this test's business.
    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: "" });

    expect(config.source).toContain(DEFAULT_CONFIG_FILENAME);
  });

  it("runs on the shipped defaults when the file says nothing", async () => {
    const { filePath } = await configFile({});

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.bounds).toEqual(BOUND_DEFAULTS);
    expect(config.mcpServers).toEqual([]);
    expect(config.github).toBeUndefined();
    expect(path.basename(config.notesDir)).toBe(NOTES_DIRNAME);
    expect(config.engine.reasoningEffort).toBe("low");
  });

  it("refuses to start when it was told where the file is and there is nothing there", async () => {
    const missing = path.join(await testTempDir("open-agent-config-"), "nope.json");

    // Silently running defaults instead would hide the typo in the one place it matters.
    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: missing })).rejects.toThrow(
      /cannot be read/,
    );
  });

  it("resolves relative paths against the file rather than the working directory", async () => {
    const { dir, filePath } = await configFile({ vault: { notes: "./brain/Notes" } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    // So a checkout that moves stays configured, and so `./` in a config file means what
    // somebody reading that file would assume.
    expect(config.notesDir).toBe(path.join(dir, "brain", "Notes"));
  });

  it("keeps the Skills beside the Notes when only the Notes have moved", async () => {
    const { dir, filePath } = await configFile({ vault: { notes: "./brain/Notes" } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    // The sibling relationship is the layout the write boundary depends on, so it is what a
    // partial configuration falls back to — never the shipped default, which would be an
    // empty directory the coworker is told about and a real one nobody reads.
    expect(config.skillsDir).toBe(path.join(dir, "brain", SKILLS_DIRNAME));
  });

  it("takes the bounds a self-hoster wrote and defaults the rest", async () => {
    const { filePath } = await configFile({ bounds: { turnTimeoutMs: 90_000 } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.bounds.turnTimeoutMs).toBe(90_000);
    expect(config.bounds.maxTurnsPerJob).toBe(BOUND_DEFAULTS.maxTurnsPerJob);
  });

  it("refuses a key it does not recognise, naming it", async () => {
    const { filePath } = await configFile({ bounds: { turnTimeutMs: 90_000 } } as ConfigFile);

    // A misspelled key that parsed and did nothing would be an instance running with a
    // bound its operator believes they set.
    const failure = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("turnTimeutMs");
  });

  it("refuses a bound that is not a number", async () => {
    const { filePath } = await configFile({
      bounds: { turnTimeoutMs: "an hour" },
    } as unknown as ConfigFile);

    const failure = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("bounds.turnTimeoutMs");
  });

  it("parses the example this project ships", async () => {
    // The example is documentation that runs, and a shipped example that does not validate
    // is worse than none: it is the first thing a self-hoster copies.
    const example = path.resolve(import.meta.dirname, "..", "open-agent.config.example.json");
    const dir = await testTempDir("open-agent-config-");
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const keyPath = path.join(dir, "app.pem");
    await writeFile(keyPath, "-----BEGIN RSA PRIVATE KEY-----\nnot-real\n-----END…\n", "utf8");

    const config = await loadConfig({
      ...SLACK_TOKENS,
      CONFIG_PATH: example,
      GITHUB_APP_ID: "1234567",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      LINEAR_API_KEY: "lin_api_test",
    });

    // And its Linear pin is the real measured inventory, so a self-hoster who copies it
    // either matches what Linear serves today or is told, loudly, that it has changed.
    expect(config.mcpServers[0]?.pinnedTools).toHaveLength(57);
    expect(config.mcpServers[0]?.pinnedTools).toContain("merge_diff");
  });

  it("says which file was not valid JSON", async () => {
    const { filePath } = await configFile('{ "bounds": { }');

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("credentials, which the file names and never holds", () => {
  it("refuses to start when a named credential is not in the environment", async () => {
    const { filePath } = await configFile({});

    const failure = await loadConfig({
      CONFIG_PATH: filePath,
      SLACK_APP_TOKEN: "xapp-test",
    }).catch((error: unknown) => error);

    // Both halves named, because either could be the mistake and the reader cannot tell
    // which from "SLACK_BOT_TOKEN is not set" alone.
    expect(String(failure)).toContain("SLACK_BOT_TOKEN");
    expect(String(failure)).toContain(filePath);
  });

  it("reads a credential out of whatever variable the file names", async () => {
    const { filePath } = await configFile({
      slack: { botTokenEnvVar: "WORK_SLACK_BOT_TOKEN" },
    });

    const config = await loadConfig({
      CONFIG_PATH: filePath,
      WORK_SLACK_BOT_TOKEN: "xoxb-work",
      SLACK_APP_TOKEN: "xapp-test",
    });

    // Which is how one machine runs two instances against two workspaces.
    expect(config.slack.botToken).toBe("xoxb-work");
  });

  it("reads the GitHub App's private key from the file the environment points at", async () => {
    const { dir, filePath } = await configFile({ github: { repositories: ["acme/web"] } });
    const keyPath = path.join(dir, "app.pem");
    await writeFile(keyPath, "-----BEGIN RSA PRIVATE KEY-----\nnot-real\n-----END…\n", "utf8");

    const config = await loadConfig({
      ...SLACK_TOKENS,
      CONFIG_PATH: filePath,
      GITHUB_APP_ID: "1234567",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    });

    // A path rather than the PEM itself: asking for a multi-line key inside a `.env` is
    // asking for a credential to be mangled by quoting, and every mangling looks like a
    // signing bug.
    expect(config.github?.appId).toBe("1234567");
    expect(config.github?.privateKeyPem).toContain("PRIVATE KEY");
    expect(config.github?.repositories).toEqual(["acme/web"]);
  });

  it("refuses to start when the private key file is not there", async () => {
    const { dir, filePath } = await configFile({ github: {} });

    const failure = await loadConfig({
      ...SLACK_TOKENS,
      CONFIG_PATH: filePath,
      GITHUB_APP_ID: "1234567",
      GITHUB_APP_PRIVATE_KEY_PATH: path.join(dir, "absent.pem"),
    }).catch((error: unknown) => error);

    expect(String(failure)).toContain("absent.pem");
  });

  it("refuses a private key file that is not a private key", async () => {
    const { dir, filePath } = await configFile({ github: {} });
    const keyPath = path.join(dir, "app.pem");
    await writeFile(keyPath, "ghp_a_personal_access_token\n", "utf8");

    const failure = await loadConfig({
      ...SLACK_TOKENS,
      CONFIG_PATH: filePath,
      GITHUB_APP_ID: "1234567",
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    }).catch((error: unknown) => error);

    // Names the file and nothing of its contents: a preflight message is read in a
    // terminal that scrolls into somebody's screenshot.
    expect(String(failure)).toContain(keyPath);
    expect(String(failure)).not.toContain("ghp_");
  });
});

describe("connectors, which the file is the only record of", () => {
  it("carries the pin, the write tools, and the token's variable name", async () => {
    const { filePath } = await configFile({
      connectors: [
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          bearerTokenEnvVar: "LINEAR_API_KEY",
          writeTools: ["save_issue"],
          pinnedTools: ["save_issue", "list_issues", "merge_diff"],
        },
      ],
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    const [linear] = config.mcpServers;
    expect(linear?.bearerTokenEnvVar).toBe("LINEAR_API_KEY");
    expect(linear?.pinnedTools).toContain("merge_diff");
    // Nothing resolved the token here. The wrapper is not in the tool path (ADR-0005) —
    // Codex reads the variable itself, so the credential never enters this process.
    expect(JSON.stringify(config)).not.toContain("lin_api");
  });

  it("insists a connector says which of its tools write", async () => {
    const { filePath } = await configFile({
      connectors: [
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          bearerTokenEnvVar: "LINEAR_API_KEY",
        },
      ],
    } as ConfigFile);

    // An absent list means every Write through this connector leaves no trace, which is not
    // a thing to fall into by omission.
    const failure = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("connectors.0.writeTools");
  });
});
