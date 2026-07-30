# 13 — Setup story: manifest, configuration, and documented traps

**What to build:** Someone unfamiliar with the project can go from nothing to a running
coworker against their own Slack, GitHub, and Linear credentials without help.

**One manifest and one connector registry.**
[ADR-0007](../../../docs/adr/0007-github-is-an-official-mcp-server.md) removed the GitHub
App path. Slack keeps its manifest; GitHub and Linear are entries in `mcp.json`.

**Blocked by:** 08 — Preflight; 09 — GitHub MCP; 10 — Branch protection

**Status:** ready-for-agent

- [ ] A Slack app manifest is provided and validated against Slack's manifest reference
- [ ] The guide explains why each self-hoster creates an internal Slack app
- [ ] Every Slack scope and Socket Mode setup step is documented
- [ ] Protecting the default branch of every connected GitHub repository is presented as a
  prerequisite, including plan-gating on private repositories
- [ ] The guide walks creation of a fine-grained GitHub PAT, selection of only the required
  repositories, and the minimum contents/issues/pull-request permissions
- [ ] GitHub token expiry and rotation are stated plainly as operator maintenance
- [ ] The official GitHub `mcp.json` entry, toolsets, automatic MCP-call auditing, and
  optional disabled merge/delete tools are documented
- [ ] Linear API-key setup and its lack of a repository-shaped third layer are documented
- [ ] The complete `open-agent.config.json` and `mcp.json` schemas are documented
- [ ] The stack's effective OpenAI-only constraint and unattended Codex authentication are
  documented
- [ ] Someone unfamiliar with the project follows the guide end to end and reaches a
  working mention
