# Which agent engine does the coworker run on?

Type: grilling
Status: resolved
Blocked by: —

## Question

There are four genuinely different shapes for the thing that runs the agent loop, and they differ most on **who supplies the harness** and **who supplies the deployment** — which matters unusually much here, because every user self-hosts their own instance.

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code packaged as a library. Ships built-in Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch, MCP support, subagents, hooks, permissions, and sessions. Harness only; you host. Notable fit: an Obsidian vault is just files on disk, so notes and file-based memory come almost free, and connectors are MCP servers.
2. **Managed Agents** — Anthropic runs the agent loop *and* hosts a per-session sandbox container. Brings persisted versioned agent configs, an event stream, vaults for credential storage with auto-refreshing OAuth, memory stores, MCP toolsets, and session resources (including mounting a GitHub repo). Removes an enormous amount of infrastructure work — but binds every self-hoster to that hosted surface and to a beta API.
3. **Messages API + Tool Runner** — the SDK drives the loop over tools you define. Full control of the tool surface, no built-in tools, you host everything.
4. **Manual loop** — you own the `while stop_reason == "tool_use"` cycle outright.

Decide which one v1 is built on, and say explicitly what the decision costs. Things to force into the open:

- **Notes and memory as files.** How much of the notes + memory capability does each option hand you for free versus make you build? This is the single biggest differentiator.
- **Long-running durability.** Delegate-and-walk-away means a job can outlive a process restart. Which option makes that tractable, and which makes it your problem?
- **Self-hoster burden.** What does someone cloning the repo have to obtain, configure, and pay for under each option? A hosted-loop dependency is a very different ask than "set an API key and run it."
- **Connector story.** Is MCP the connector interface in all four cases, or does one option push you somewhere else? (Relates to *Connector interface: MCP servers, a plugin API, or both?*)
- **Lock-in.** Which choices are reversible later, and which bake themselves into the architecture?

Resolution should name the engine, state the two strongest arguments against it, and record what would have to change for the decision to be revisited. Worth an ADR — this is hard to reverse, surprising without context, and a genuine trade-off.

## Answer

**The engine is OpenAI's Codex CLI.** Decided directly by the project owner rather than argued out from the four options above.

The fit with the destination is genuine, not incidental:

- **It is open source and locally installed**, which matches "others self-host" exactly. A self-hoster installs a CLI and authenticates it, rather than taking a dependency on somebody's hosted agent loop.
- **It is filesystem-native.** An Obsidian vault is a directory of Markdown files, and a locally-running CLI agent already reads, writes, greps and globs those files. This is the single largest capability the engine hands over for free, and it covers both the notes capability and the cheapest form of the memory capability.
- **It is an MCP client**, so GitHub and Linear plug in as MCP servers rather than as hand-written integrations. This is the biggest input to the connector-interface decision.
- **It runs as a subprocess**, which makes the Slack layer a wrapper around a process rather than a host for an agent loop. Simple to reason about; the cost shows up in progress reporting and durability, below.

**What it costs.** The stack moves off Anthropic entirely — model choice, pricing, and reasoning quality all become functions of whatever provider Codex is pointed at, and none of the Claude-specific guidance applies. Codex CLI is also primarily a *coding* agent; using it as a general knowledge-work coworker means the Slack layer must adapt its output, not just relay it. And it moves fast as a project, so the integration surface is a moving target.

**The strongest arguments against, recorded honestly:**

1. **Progress reporting may be hard or impossible.** Delegate-and-walk-away depends on the human seeing something in the thread while the job runs. That requires observing tool calls and partial output from a subprocess in a parseable form. If Codex CLI has no structured streaming output, in-thread progress degrades to "silence, then a wall of text" — which materially damages the product.
2. **Durability is likely the wrapper's problem.** A long job surviving a process restart is not something a CLI invocation gives you for free.

**Conditions for revisiting.** This decision is deliberately conditional on facts not yet established. Reopen it if *What can Codex CLI actually do when driven headlessly?* finds that (a) there is no structured streaming or observable progress output, or (b) sessions cannot be resumed at all, or (c) the approval/sandbox model cannot be configured for unattended operation against real GitHub and Linear credentials. Any one of those makes the delegate-and-walk-away spine substantially worse, and the trade-off would be worth re-arguing against the alternatives listed in the question.

Deferred to that ticket rather than settled here: whether Codex CLI can be pointed at a non-OpenAI provider, which decides whether "which model" is a later decision or a fixed consequence of this one.

No ADR yet — write one once the Codex CLI research lands and the decision is either confirmed or amended. An ADR recording a conditional decision would need rewriting within the week.
