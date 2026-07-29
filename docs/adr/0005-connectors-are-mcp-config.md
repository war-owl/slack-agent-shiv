---
status: accepted
---

# Connectors are MCP servers in configuration — there is no plugin interface

**Amended by [ADR-0006](0006-github-is-a-skill-over-gh.md): GitHub is a carve-out.** GitHub is no longer an MCP connector — it is a Skill over the `gh` CLI, authenticated by a GitHub App, because repository selection had nowhere to live in this ADR's shape (outside the tool path, nothing of ours can narrow what Codex calls). This ADR continues to govern Linear and every third-party service. The project now has **two** extension routes rather than one: point it at an MCP server, or write a Skill. Read the consequences below with GitHub excepted throughout — in particular, the MCP deny-list does not cover it, and the git/MCP seam described at the end is withdrawn.

**Amended 2026-07-29: all MCP servers now live in one project-owned `mcp.json`.** MCP and
its TypeScript SDK do not define a portable host configuration format, so the file is not
presented as an MCP standard. It is a small validated seam that supports the specification's
two transports—Streamable HTTP and stdio—and translates the same entries into Codex
configuration. Preflight now uses the official `@modelcontextprotocol/client` v2 SDK rather
than maintaining a parallel implementation of initialization, sessions, SSE parsing, and
pagination. Write classification and optional exact-name exclusions remain beside each
server because they are open-agent policy, not transport configuration. Tool inventories
are intentionally not pinned: additions and removals do not prevent startup. Research:
[`mcp-typescript-sdk-client-config.md`](../../.scratch/slack-coworker/research/mcp-typescript-sdk-client-config.md).

"Connect it to various apps" is delivered by pointing Codex at MCP servers, not by a connector API this project defines. Two facts settled it. First, **the wrapper is not in the tool path**: under [ADR-0001](0001-codex-cli-via-exec-and-sdk.md) Codex reads MCP servers from its own config and calls them directly, so any normalising layer would mean shipping a **proxy MCP server** — a whole component to build, secure, and keep synchronised with upstreams that change without notice. Second, **normalisation would have to lie**: GitHub's binary `open`/`closed` against Linear's team-scoped `WorkflowState`, no lattice between Project/Team/Repo/Cycle/Initiative, flat comments against threaded-and-polymorphic ones, and a `save_*` upsert idiom against `create_*`/`update_*`. A uniform surface flattens to a lowest common denominator and misrepresents the difference; a capable model is better served by each service's real vocabulary.

## Consequences

- **Third-party extension is "point it at an MCP server"** — no interface to author, version, or document, and the ecosystem does the work.
- **Both Streamable HTTP and stdio are supported.** Credentials stay as per-server
  environment-variable references; stdio commands are executable software and receive a
  startup warning.
- **The [ADR-0002](0002-unattended-action-boundary.md) deny-list is Codex config**
  (`disabled_tools` per server), not wrapper enforcement.
- **Argument-level constraints are structurally unavailable.** Nothing can inspect the arguments to Linear's `save_issue` to distinguish creating from overwriting. Already accepted in ADR-0002; now a property of the architecture rather than a choice.
- **Connector inventories are live and may evolve.** Preflight reports the current count
  for visibility but does not require an operator to approve changes.
- ~~**Git stays outside MCP**: a checkout costs no new credentials and the API can neither grep nor run tests, so the seam is git for the filesystem, MCP for the pull request.~~ **Withdrawn by [ADR-0006](0006-github-is-a-skill-over-gh.md).** The first half holds — a checkout still costs no new credentials and the API still cannot grep or run tests — but there is no longer an MCP half to seam against. Both the branch push and the pull request are now shell, under one installation token.
- Posting to the Thread is the wrapper's job via the event stream, and the Vault is the filesystem — neither needs a tool.

Decided in [ticket 07](../../.scratch/slack-coworker/issues/07-connector-interface.md); inventories measured in [ticket 05](../../.scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md).
