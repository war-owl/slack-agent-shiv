# 08 — Preflight: credentials, dependencies, and connector connectivity

**What to build:** A self-hoster starts the instance and either it runs or it names the
configuration problem. Missing credentials and unreachable MCP servers fail before the
first mention. Changes to an upstream tool inventory do not stop startup.

**Amended 2026-07-30:** GitHub now uses the same generic MCP path as Linear and every
third-party connector. The GitHub App and `gh`-specific probes were removed by
[ADR-0007](../../../docs/adr/0007-github-is-an-official-mcp-server.md).

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

## Acceptance criteria

- [x] `open-agent.config.json` names the Vault, Skills, bounds, model, and the path to the
  single `mcp.json` connector registry
- [x] Missing named credentials fail with a message that identifies the environment variable
- [x] The installed Codex version is reported; drift from the recorded version warns
- [x] The sandbox is `workspace-write` with network enabled and exec policy unrestricted
- [x] Every enabled MCP server is connected at startup with the official TypeScript SDK
- [x] Startup reports each connector's current tool count
- [x] Tool additions, removals, and renames are accepted without operator approval
- [x] Known irreversible tools are removed through a fixed exact-name floor plus each
  connector's `disabledTools`
- [x] An explicitly configured disabled tool missing from the live inventory warns, because
  that usually indicates drift or a typo, but does not prevent startup
- [x] The Skills directory is verified readable and outside every writable sandbox root

## Decisions

### Inventory changes are intentionally forgiving

The first implementation pinned every server's complete `tools/list` response. That made
unrelated upstream releases an availability dependency. Preflight now verifies transport,
credentials, the MCP handshake, and `tools/list`, then treats the inventory as information.
New tools are allowed automatically.

The cost is explicit: a newly introduced irreversible tool is available until the project
or operator names it. The fixed floor therefore contains only exact tool names that have
been reviewed, including GitHub merge/file deletion and known Linear deletion tools.
MCP annotations and name patterns are not treated as a portable safety policy.

### One connector path

`mcp.json` is open-agent's validated client configuration format; MCP standardizes the
protocol and transports, not this file. It supports Streamable HTTP and stdio. The official
MCP TypeScript SDK owns probing and Codex receives the same validated server definitions.
There is no connector-specific authentication or preflight module.

GitHub's official remote MCP server is therefore configured exactly like Linear. A
fine-grained PAT is named by `bearerTokenEnvVar`, server toolsets/exclusions are ordinary
headers, and the fixed disabled-tool floor applies to its inventory. Local `git` remains a
shell concern and is not a connector.

### Configuration and credentials stay separate

`open-agent.config.json` and `mcp.json` contain behavior and environment-variable names.
`.env` contains secret values. `CONFIG_PATH` is the only environmental configuration
because it cannot be placed inside the file it locates. Unknown keys fail validation so a
misspelled bound cannot silently do nothing.

### Measurement

Unit tests exercise successful and failed probes, disabled-tool generation, inventory
drift, transports, and configuration validation against fakes. The opt-in live contract
test probes Linear when `LINEAR_API_KEY` is present and GitHub when `GITHUB_TOKEN` is
present; absence is reported as a skip rather than represented as live coverage.
