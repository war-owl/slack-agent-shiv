# What can Codex CLI actually do when driven headlessly?

Type: research
Status: resolved
Blocked by: —

## Question

The engine is decided (*Which agent engine does the coworker run on?*), but that decision was made on the shape of Codex CLI rather than on its verified capabilities. Every remaining architectural ticket now depends on facts about its programmatic surface — and two of them could reopen the engine decision.

Investigate against the `openai/codex` repository source and docs, plus OpenAI's official Codex documentation. Primary sources only; cite file paths and URLs.

- **Non-interactive execution.** How you drive it headlessly from another process: the non-interactive entry point, its flags, its input model, exit behaviour. Whether there is a structured/JSON output mode, and whether an SDK, library, or server mode exists as an alternative to shelling out.
- **Streaming and progress.** Whether a parent process can observe tool calls, reasoning, and partial output *while the agent runs*, and in what format. **This is the load-bearing question** — in-thread progress reporting is the difference between a coworker and a black box.
- **Sessions and resumption.** Whether sessions persist, whether a run can be resumed or forked, where state lives, and whether a job can survive a process restart.
- **MCP, both directions.** Whether it consumes external MCP servers and how they are configured; separately, whether it can be exposed *as* an MCP server.
- **Configuration.** The full config surface — model, provider, approval policy, sandbox policy, working directory, MCP servers. Critically: **whether it can be pointed at a non-OpenAI provider**, which decides whether model choice is a live decision or a fixed consequence of the engine.
- **Sandboxing and approvals.** The sandbox modes and approval policies, what full-auto looks like, and how an approval request surfaces when nobody is at a terminal — a real problem for delegate-and-walk-away against live GitHub and Linear credentials.
- **AGENTS.md.** Lookup locations, precedence, and how much context is loaded. Relevant as a candidate memory substrate.
- **Licence and embedding.** Licence terms affecting an open-source project depending on it, and what an end user must install and authenticate.

Note the version or commit documented — this project moves fast, and a stale answer here is worse than none.

Resolution must state plainly whether in-thread progress reporting is achievable, whether long jobs can survive a restart, and any capability this project needs that Codex CLI does not provide. If any of those come back negative, reopen *Which agent engine does the coworker run on?* rather than designing around the gap silently.

## Answer

Findings: [`research/codex-cli-surface.md`](../research/codex-cli-surface.md) — 858 lines, documented against a local clone of `openai/codex` @ `8495963` (2026-07-27) and `codex-cli 0.145.0`, with claims verified by live runs rather than read off docs. Note the repo's `docs/` are now redirect stubs; real documentation moved to `learn.chatgpt.com` mid-research.

**The three reopen triggers on the engine decision are discharged.**

1. **In-thread progress reporting — yes, comfortably.** `codex exec --json` emits a clean JSONL stream (`thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed`) with typed items for commands, file changes, MCP tool calls, web searches, reasoning summaries and a live todo list. That maps almost one-to-one onto Slack posts, and item-level rather than token-level granularity is a *benefit* given Slack's rate limits. Precise limit, found by reading the event processor: `exec` **deliberately drops all delta notifications** — no live command output, no token streaming, and `item.updated` fires only for the todo list.
2. **Restart survival — yes, at turn granularity.** Verified end-to-end. Sessions persist as append-only JSONL rollouts under `~/.codex/sessions/YYYY/MM/DD/`; `codex exec resume <id>` in a fresh process reused the thread id, appended to the same file, and restored context. The gap: a crash mid-turn cannot resume *that turn*. The job model must treat the turn as the unit of durability and reconcile side effects itself.
3. **Unattended operation — yes**, and more bluntly than expected: `codex exec` hard-codes `approval_policy: Never` (`exec/src/lib.rs:427`) with no `--ask-for-approval` flag. It cannot be blocked waiting for a human — because it cannot ask at all.

**There is a first-class TypeScript SDK.** `@openai/codex-sdk` (Apache-2.0) spawns `codex exec --experimental-json` and exchanges JSONL, exposing `run()`, `runStreamed()`, `resumeThread()`, and arbitrary `config.toml` overrides from a JSON object. For a TypeScript project this removes the entire hand-rolled subprocess layer.

**The sharpest thing found is a fork, not an answer** — `exec`+SDK versus `app-server`/`mcp-server`. Spun out as [Which Codex interface: `exec` + SDK, or `app-server`?](11-codex-interface.md), which is now the hinge ticket.

**Constraints the project inherits and must design around:**

- **Non-OpenAI providers are largely blocked.** `WireApi` has exactly one variant, `Responses`. Chat Completions was *removed* (not deprecated) around 2026-02-01; grepping the tree for `chat_completions` returns zero hits. Any alternative backend must serve an OpenAI Responses API. For a self-hosted OSS tool whose users will expect "bring your own model", this is a genuine constraint — see the note on the engine ticket.
- **No semantic guardrails.** The sandbox governs filesystem and network, not intent; nothing distinguishes reading a PR from merging one. Safe unattended GitHub/Linear work has to come from scoped tokens, `execpolicy` rules, and per-server `disabled_tools` — a policy layer this project builds itself.
- **`AGENTS.md` cannot be the evolving memory.** Capped at 32 KiB, silently truncated deepest-first, always-on regardless of relevance, refreshed once per run. It is a stable operating manual; retrieval remains this project's problem. (Watch `~/.codex/memories_1.sqlite` — undocumented, but OpenAI appears to be building here.)
- **No cost ceiling.** `turn.completed.usage` reports tokens after the fact. No budget limit, no max-turns kill switch. Spend control is external.
- **Instability is a first-class risk.** Multiple alpha releases per day; `--full-auto`, `wire_api = "chat"` and `ollama-chat` all removed. **Pin the Codex version explicitly** and treat upgrades as deliberate work.

**Two capabilities the map had not scoped**, both feeding other tickets: `dynamicTools` (client-registered callback tools — GitHub and Linear as in-process TypeScript functions instead of MCP servers) and `turn/steer` / `turn/interrupt` (redirect or stop a running job from the Slack thread).

Unestablished, flagged rather than guessed: whether ChatGPT-plan authentication permits an always-on bot, as opposed to API-key auth.
