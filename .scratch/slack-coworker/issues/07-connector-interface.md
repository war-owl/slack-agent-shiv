# Connector interface: MCP servers, a plugin API, or both?

Type: grilling
Status: resolved
Blocked by: 11

## Question

"Connect it to various apps" is a headline promise, and for an open-source project it is also the extension point other people will build against. Decide its shape — this is a deep-module question, so run it with `/codebase-design` vocabulary.

The candidate positions:

1. **MCP is the connector interface.** Adding an app means adding an MCP server to config. Nothing to author, no plugin API to version, and the ecosystem does the work. But you inherit whatever tool surface each server exposes, including inconsistency between them.
2. **A first-class plugin API of your own**, with MCP as one implementation behind it. Lets you normalise across services and offer capabilities MCP servers do not. Costs you an interface to design, document, and keep stable.
3. **Both, layered** — MCP for reach, a thin internal abstraction for the handful of things the agent needs uniformly.

Force these into the open:

- **What does the agent actually need from a connector?** Enumerate it concretely against GitHub and Linear, using the shape mismatches found in the research. If the answer is "just call whatever tools exist", option 1 wins on the spot.
- **How does a third party add a connector?** Edit a config file, drop in a package, implement an interface? This is the open-source extension story, so it is load-bearing.
- **Credentials.** Where do connector credentials live and how are they configured, given self-hosters supply their own? Does the engine decision already answer this?
- **Failure and degradation.** A connector is down or a token has expired mid-job. What does the agent see, and what does the human see in the thread?
- **The depth test.** Is this a lot of behaviour behind a small interface, or a thin wrapper that adds indirection without leverage? If it is the latter, say so and pick option 1.

Resolution names the shape, defines the interface if there is one, and states what a third-party connector author has to do.

## Fourth option, surfaced after charting

[What can Codex CLI actually do when driven headlessly?](09-codex-cli-headless-surface.md) found **`dynamicTools`** — the client registers its own tool schemas and Codex calls back via `item/tool/call`, with the client returning content items. That would make GitHub, Linear, and "post an update to Slack" **in-process TypeScript functions** rather than MCP servers: full control of the tool surface, normalisation across services for free, no separate server processes for a self-hoster to run, and ordinary TypeScript testing.

It is only available under the `app-server` interface, and it is experimental. So this ticket now waits on [Which Codex interface: `exec` + SDK, or `app-server`?](11-codex-interface.md) — if that resolves to `exec` + SDK, `dynamicTools` is off the table and the real choice narrows to MCP-only versus MCP-behind-a-thin-abstraction.

## Design pressure established by research

From [What is the real integration surface for GitHub and Linear?](03-github-linear-surface-research.md). These are the concrete mismatches any abstraction would have to absorb — read them as the case *against* normalising, and make the abstraction earn its place:

- **State.** GitHub is binary `open`/`closed`; Linear is a **team-scoped `WorkflowState` machine**. Only the state *category* is portable. An abstraction that exposes "status" has to either lose Linear's fidelity or leak it.
- **Organisational units.** Project, Team, Repo, Cycle, Initiative **form no lattice**. There is no honest containment mapping between the two products.
- **Comments.** GitHub's are flat. Linear's are **threaded and polymorphic across seven parent types**.
- **Asymmetric servers.** GitHub's MCP server is open source, self-runnable, and publishes 86 tools with parameters. Linear's is hosted-only, closed-source, and publishes nothing — its inventory has to be discovered by calling `tools/list` (ticket 05). Designing a uniform interface across a documented server and an undocumented one is itself an argument for staying close to MCP.
- **The repo seam.** The API can neither grep nor run tests, and `push_files` makes the model reproduce every byte. A checkout costs no new credentials. The clean split is **git for the filesystem, MCP for the PR** — worth encoding in whatever shape this ticket picks.

The depth test now has a sharp form: given that the two services genuinely do not agree on state, containment, or comment structure, is a normalising layer *possible* without lying to the agent — and if it is only possible by flattening to a lowest common denominator, is that worth having at all?

## Real inventories retrieved

[Ticket 05](05-provision-accounts-and-tokens.md) resolved the unknown this ticket was waiting on. Both servers were queried live:

- **Linear: 57 tools** ([inventory](../research/linear-mcp-inventory.md)) — the `save_*` upsert pattern is confirmed, there is **no `search_issues`** (filtering goes through `list_issues`), and there is an unscoped code-review surface (`get_diff`, `submit_diff_review`, `merge_diff`).
- **GitHub: 44 tools** exposed to a `repo`-scoped token ([inventory](../research/github-mcp-inventory.md)).

**Auth is symmetric and simple**: both servers accept a plain bearer token — a Linear API key and a GitHub OAuth/PAT respectively. No OAuth dance for either. That removes a large chunk of the credential-handling argument for a custom abstraction layer.

The shape mismatch, however, is now concrete rather than theoretical: 57 tools against 44, a `save_*` upsert idiom against `create_*`/`update_*`, `list_issues`-with-filters against `search_issues`. Any normalising layer has to reconcile two genuinely different tool vocabularies — which sharpens the depth test rather than settling it.

## Answer

**MCP direct. Connectors are configuration, not code.** Codex talks to the GitHub and Linear MCP servers itself; adding a connector means adding a server to Codex's config. There is no plugin interface to author, version, or document.

### Why no abstraction

The depth test asked whether a normalising layer is *possible* without lying to the agent. Given what the research measured, the honest answer is no — or not without cost exceeding the benefit:

- GitHub's binary `open`/`closed` against Linear's team-scoped `WorkflowState` machine; only the state *category* is portable.
- Project, Team, Repo, Cycle, Initiative form **no lattice** — there is no honest containment mapping.
- GitHub comments are flat; Linear's are threaded and polymorphic across seven parent types.
- 57 tools against 44, with a `save_*` upsert idiom on one side and `create_*`/`update_*` on the other.

A uniform surface over that has to flatten to a lowest common denominator and misrepresent the difference. The agent is better served seeing each service's real vocabulary — it is a capable model, and the mismatch is information rather than noise.

The credentials argument for an abstraction also evaporated: both servers accept a **plain bearer token**, no OAuth, no callback, no refresh loop.

### The fact that reframed the choice

**In `exec` mode the wrapper is not in the tool path.** Codex reads MCP servers from its own config and calls them directly; the wrapper spawns the process and observes `mcp_tool_call` items after the fact. It cannot intercept, rewrite, or validate a call. `dynamicTools` — the one mechanism that would put the wrapper back in the path — is `app-server`-only and therefore unavailable under [ADR-0001](../../../docs/adr/0001-codex-cli-via-exec-and-sdk.md).

So "a thin abstraction over MCP" was never a small internal interface. It would mean **shipping a proxy MCP server**: a whole component to build, secure, and keep synchronised with two upstream servers that change without notice. Rejected on cost, not on principle.

### Consequences

- **Third-party extension is "point it at an MCP server."** No interface to learn, and the ecosystem does the work. This is a better open-source extension story than a bespoke plugin API would have been.
- **The deny-list from [ticket 12](12-blast-radius.md) lands as Codex config** (`disabled_tools` per server), not wrapper enforcement — consistent with what that ticket decided, and the reason the pinned-inventory check exists.
- **Argument-level constraints are unavailable.** Nothing can inspect the arguments to Linear's `save_issue` upsert to distinguish create from overwrite. Ticket 12 already accepted this explicitly; it is now structural rather than a choice.
- **Tool quality is whatever each vendor ships**, and Linear publishes no inventory — so the pinned `tools/list` hash doubles as the project's only record of what Linear actually offers.
- **The repo seam stands**: git for the filesystem (a checkout costs no new credentials, and the API can neither grep nor run tests), MCP for the pull request.
- **Nothing else needs a tool.** Posting to the Thread is the wrapper's job via the event stream, and the Vault is the filesystem, which Codex's built-in tools already reach.

### Connector setup story

A self-hoster adds the server and its token to Codex's config, and pins the inventory hash. That is the whole procedure, for GitHub, Linear, or anything else.

Recorded as [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md).
