# 09 — GitHub connector over MCP

**What to build:** The coworker can work with real GitHub data. A person asks it to look into a bug and it searches issues, reads the relevant pull requests, and comments — with every action it takes landing in the Thread's audit record, and the actions it must not take genuinely unavailable rather than merely discouraged.

Connectors are configuration, not code: GitHub is an MCP server named in the config, and the wrapper is not in the tool path.

**Blocked by:** 04 — Audit: every Write appended; 08 — Preflight

**Status:** ready-for-agent

- [ ] GitHub is configured as an MCP server authenticated with a plain bearer token — a **classic PAT**, since fine-grained PATs are ruled out
- [ ] The token grants `repo` and withholds `delete_repo`, `admin:org`, and `workflow`; the reasoning for each exclusion is documented
- [ ] The coworker can read issues, pull requests, and code, and can **search** — a capability the classic PAT preserves and a fine-grained one would have cost
- [ ] Writes — commenting, opening a pull request, updating an issue — each appear in the Thread's audit channel naming the thing written and linking to it
- [ ] Denied tools are genuinely unavailable, and an attempt to use one fails visibly rather than silently
- [ ] The connector's tool inventory is pinned and checked by preflight
- [ ] The org-approval trap is documented: an unapproved token authenticates successfully and then silently reads only public data
