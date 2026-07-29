---
status: accepted
supersedes: 0006-github-is-a-skill-over-gh.md
---

# GitHub is an official MCP server configured in `mcp.json`

GitHub uses GitHub's official MCP server through the same `mcp.json` interface as Linear
and every other connector. Authentication is a fine-grained personal access token named by
`bearerTokenEnvVar`, restricted in GitHub to the repositories and permissions the coworker
needs.

**Amended by build/10:** connector connectivity and Job tools still use only the official
MCP server, but startup has one narrow direct GitHub REST path for the repository boundary.
The official server does not expose effective branch rules or
`current_user_can_bypass`, while ADR-0002 requires those exact checks. Preflight therefore
uses the bearer variable named by the GitHub MCP entry to read repository metadata,
effective rules, and contributing rulesets. This is a read-only safety verifier, not a
second connector surface: Jobs cannot call it and GitHub work still goes through MCP.

This restores the original deep module: callers learn one connector interface and the
official server hides GitHub protocol behavior. Open-agent owns only generic MCP transport,
tool-call auditing, exact disabled-tool policy, and startup connectivity. It does not own
a GitHub API client, App JWT signing, installation discovery, token refresh, a `gh` adapter,
or special GitHub preflight.

The build/10 amendment narrows the “no GitHub API client or special preflight” statement:
open-agent owns the three read-only branch-protection requests needed to verify the
server-side boundary, and no general GitHub capability path.

## Why

The superseded design built a shallow parallel path around GitHub before a Job could
perform one authenticated GitHub action. GitHub now maintains an official remote and local
MCP server with repository, issue, and pull-request toolsets. Reusing it gives open-agent
more capability behind less project-specific interface and keeps connector changes local
to `mcp.json`.

A fine-grained token supplies the property that motivated the GitHub App: it can be limited
to selected repositories and narrowly chosen permissions. It may require expiry or
rotation; v1 accepts that operational cost instead of maintaining an installation-token
control plane.

## Configuration

The recommended remote entry:

```json
{
  "type": "streamable-http",
  "url": "https://api.githubcopilot.com/mcp/",
  "bearerTokenEnvVar": "GITHUB_TOKEN",
  "httpHeaders": {
    "X-MCP-Toolsets": "repos,issues,pull_requests",
    "X-MCP-Exclude-Tools": "merge_pull_request,delete_file"
  },
  "disabledTools": ["merge_pull_request", "delete_file"]
}
```

The server-side exclusion header and Codex `disabled_tools` intentionally repeat the two
known irreversible names. The former asks GitHub's server not to expose them; the latter
keeps the project policy visible and effective at the host.

Tool inventories may evolve without blocking startup. Operators add exact names to the
optional `disabledTools` when they want further exclusions. Every completed MCP call,
including newly introduced tools and reads, appears in the Slack audit automatically.

## Consequences

- GitHub configuration is removable and extensible in exactly the same way as any MCP
  server. Removing its entry removes the capability.
- GitHub MCP calls are recorded exactly from engine tool-call events rather than inferred
  from shell strings.
- `merge_pull_request` and `delete_file` return to layer 2. Branch protection remains the
  server-side defense for shell access and credential bypasses.
- Local checkout, editing, tests, and branch push remain shell work. MCP handles GitHub
  metadata and pull-request operations; build/12 owns the git credential and checkout
  workflow.
- The special `github` section in `open-agent.config.json`, App ID/private key variables,
  `gh` startup dependency, App manifest, installation probe, and token helper are removed.
- OAuth can be added later as another authentication source without changing the connector
  interface. It is not required for v1.

## Rejected alternatives

- **Keep the GitHub App plus `gh` Skill.** Strong repository installation semantics, but it
  requires a custom token lifecycle, two audit paths, and a special connector interface.
- **Own a GitHub proxy MCP server.** More control, but duplicates the official server and
  makes open-agent responsible for GitHub surface drift.
- **Classic PAT.** Easy, but broader than necessary. Fine-grained tokens are the v1 default.

Supersedes [ADR-0006](0006-github-is-a-skill-over-gh.md) and restores
[ADR-0005](0005-connectors-are-mcp-config.md) as the single connector decision.
