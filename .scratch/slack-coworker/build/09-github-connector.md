# 09 — GitHub through the official MCP server

**What to build:** The coworker searches GitHub, reads issues and pull requests, comments,
and opens pull requests through GitHub's official MCP server. GitHub is one `mcp.json`
entry, not a special integration module.

**Decision:** [ADR-0007](../../../docs/adr/0007-github-is-an-official-mcp-server.md)
supersedes the unbuilt GitHub-App-plus-`gh` design. A fine-grained PAT provides repository
and permission scope. The official server owns GitHub protocol behavior; open-agent owns
generic MCP transport, write audit classification, and exact disabled tools.

**Blocked by:** 08 — Preflight

**Status:** ready-for-agent

## Acceptance criteria

- [x] `mcp.example.json` contains a disabled-by-default official GitHub remote server entry
  using `GITHUB_TOKEN`
- [x] The entry selects the `repos`, `issues`, and `pull_requests` toolsets
- [x] `merge_pull_request` and `delete_file` are excluded at the server and disabled in
  Codex configuration
- [x] Known GitHub mutating tools are listed in `writeTools` so their MCP calls use the exact
  permanent Slack audit path
- [x] Adding or removing GitHub tools does not block startup; the live count is reported like
  every other MCP server
- [x] No GitHub-specific configuration schema, App ID, private key, installation probe,
  `gh` port, or startup branch exists
- [ ] A live contract run searches issues, reads a pull request, and creates a reversible
  test comment using a fine-grained PAT
- [ ] The live inventory confirms `merge_pull_request` and `delete_file` are absent

## Authentication

Create a fine-grained PAT, select only the repositories the coworker needs, and grant the
minimum repository permissions required by the chosen tools. Put the value in
`GITHUB_TOKEN`. Rotation or expiry is explicit operator maintenance in v1.

The remote GitHub MCP server accepts a valid bearer token. A self-hoster preferring the
local official server can replace this entry with a stdio/Docker entry without changing
open-agent.

## Safety

Layer 2 applies again because GitHub is in the MCP tool path. The known merge and file
deletion tools are absent. This does not constrain raw shell access or a token used outside
MCP, so branch protection remains the server-side merge boundary and build/10 still warns
when it is missing.
