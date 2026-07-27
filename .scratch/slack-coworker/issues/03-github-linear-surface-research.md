# What is the real integration surface for GitHub and Linear?

Type: research
Status: resolved
Blocked by: —

## Question

GitHub and Linear are the two named connectors, and they are usefully different in shape — which makes them a good pair to design the connector interface against. Establish what each actually offers before deciding how connectors work.

Investigate against primary documentation and report with citations:

- **MCP servers.** Do GitHub and Linear each publish a hosted MCP server? What are the endpoint URLs, transports, and tool inventories? What can each actually *do* — read issues, comment, open pull requests, move tickets, query by filter?
- **Auth.** What does each require — OAuth, a personal access token, a fine-grained PAT with specific scopes? What is the minimum a self-hoster must create for a working install, and what are the least-privilege scopes for read-only versus write?
- **Token lifecycle.** Which tokens expire, which refresh, and what does that mean for a long-running self-hosted process?
- **Falling back.** Where an MCP server is missing or too coarse, what does the REST/GraphQL surface look like, and is a hand-written client warranted for anything in v1?
- **Repo access specifically.** For GitHub, distinguish *talking to the API* from *having a checkout on disk*. Which does a coworker need for the tasks in v1, and what does each cost to set up?
- **Shape mismatch.** Where do the two services disagree structurally — issue vs ticket, label vs state, project vs team, comment threading? These mismatches are the real design pressure on the connector interface.

Deliverable: a cited Markdown file in the repo. Feeds *Connector interface: MCP servers, a plugin API, or both?* and the identity-mapping fog.

## Answer

Findings: [`research/github-linear-surface.md`](../research/github-linear-surface.md) — ~1,190 lines, fully cited. Ten "could not establish" items are listed explicitly rather than guessed.

**Both publish MCP servers, but they are not comparable products.** GitHub's is **open source** (MIT, Go), available *both* hosted at `https://api.githubcopilot.com/mcp/` and self-runnable via Docker or binary, with an exhaustively documented inventory — 86 tools, 42 in the default toolset, per-tool parameters published. Linear's is **hosted-only and closed-source** at `https://mcp.linear.app/mcp` (Streamable HTTP, with a `/mcp/readonly` variant). Both vendors ship Codex-specific setup instructions, which is a point in favour of the engine choice.

**Two findings that change the picture:**

1. **A GitHub fine-grained PAT cannot call the Search API** — only `/search/labels`. Verified against GitHub's own docs-generating dataset and cross-checked against the MCP server's source: all six search tools route through REST search. So **"least-privilege token" and "the agent can search issues" are mutually exclusive**, unless GraphQL `search` works for fine-grained PATs, which GitHub's docs do not confirm either way. This is a v1 decision, not a detail: it determines what the setup guide tells people to create.
2. **Linear publishes no tool inventory at all.** Only five tool names are first-party confirmed (`save_issue`, `save_project`, `save_document`, `list_comments`, `save_customer_need`), all from changelog bug-fix notes. The naming suggests a `save_*` upsert pattern rather than separate create/update. The real list requires authenticating and calling `tools/list` — an empirical check now added to [Provision a Slack app, a test workspace, and GitHub/Linear tokens](05-provision-accounts-and-tokens.md).

**Auth is simpler than feared.** Minimum working install is **one GitHub PAT plus one Linear API key** — both static, no OAuth app, no callback URL, no refresh loop. Linear API keys have no documented expiry; Linear OAuth would mean 24-hour tokens with rotating refresh, so avoid it unless something forces it. The trap: GitHub's org-approval default ("Require administrator approval") means an unapproved token **authenticates fine and then silently reads only public data** — a self-hoster will hit this and have no idea why the agent is blind.

**Repo access — decisive, and it favours a checkout.** The API cannot run tests and cannot grep, and `push_files` requires the model to reproduce every byte of every touched file. A local checkout costs **zero new credentials**, since the PAT doubles as the git password. Clean seam: **push a branch with git, open the pull request over MCP.** This plays directly to Codex CLI's filesystem-native strengths.

**Shape mismatch — the section that matters most for ticket 07.** Nine sub-sections with a summary table. The load-bearing ones:

- GitHub's binary `open`/`closed` versus Linear's **team-scoped `WorkflowState` machine** — only the state *category* is portable across the two.
- Project, Team, Repo, Cycle and Initiative **form no lattice**. There is no clean containment mapping between the two products' organisational units.
- GitHub issue comments are **flat**; Linear's are **threaded and polymorphic across seven parent types**.
- Identity has no automatic join — but there is a lead worth probing: **`User.gitHubUserId` exists in Linear's schema.**

Two ten-minute empirical checks are flagged as gating any interface freeze; both need live tokens and have been moved onto ticket 05.
