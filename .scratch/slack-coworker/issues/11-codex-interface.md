# Which Codex interface: `exec` + SDK, or `app-server`?

Type: grilling
Status: resolved
Blocked by: —

## Question

Surfaced by [What can Codex CLI actually do when driven headlessly?](09-codex-cli-headless-surface.md) as the sharpest architectural fork in the project. It is now the hinge: the connector interface and the job model both wait on it.

Codex CLI offers two ways to be driven from another process, and they are not a matter of taste — they differ on capabilities the product needs.

**Option A — `codex exec` via `@openai/codex-sdk`.** Stable, Apache-2.0, TypeScript-native, ergonomic (`run()`, `runStreamed()`, `resumeThread()`, config overrides from a JSON object). Item-level JSONL events that map cleanly onto Slack posts. What it cannot do: **ask for approval at all** (`exec` hard-codes `approval_policy: Never`), emit deltas of any kind, or be steered mid-turn.

**Option B — `app-server` / `mcp-server` JSON-RPC.** Approvals arrive as server→client requests, which map exactly onto Approve/Deny buttons in a Slack thread. Adds delta streams (live command output, streaming reasoning, diffs), `turn/steer` and `turn/interrupt` for redirecting a running job from the thread, and `dynamicTools` for client-registered callback tools. The cost: the protocol is documented as **experimental and subject to change without notice**, against a project shipping multiple alpha releases per day.

Force these into the open:

- **Does v1 need to ask permission?** This is the crux and it is a product question, not a technical one. If the coworker must ever pause and ask before merging a PR or closing a ticket, Option A is disqualified outright — `exec` has no mechanism at any price. If v1 instead runs with narrowly-scoped tokens and *cannot do anything worth asking about*, Option A is clearly right. Settle this before comparing anything else.
- **Is item-level progress enough?** The research argues yes, and that token-level streaming is a liability under Slack's rate limits. Is there a case where a silent long-running command genuinely damages the experience?
- **What does `dynamicTools` change?** It would make GitHub, Linear, and "post to Slack" in-process TypeScript functions rather than MCP servers — a materially different connector architecture, and only available in Option B. See [Connector interface: MCP servers, a plugin API, or both?](07-connector-interface.md).
- **How much instability can an open-source project absorb?** Self-hosters install and forget. A protocol that changes without notice becomes a support burden carried by whoever maintains this. Mitigation if Option B is chosen: `codex app-server generate-ts --out DIR` emits bindings matching the exact binary, turning protocol drift into a compile error rather than a runtime surprise. Either way, **pin the Codex version**.
- **Is it reversible?** How much of the codebase would a later A→B migration touch? If the answer is "a well-isolated adapter", start with A and keep B in reserve. If the interface leaks everywhere, choose once, now.
- **Can they coexist?** Option A for the common path, Option B only for jobs that need approvals or steering. Probably a false economy — two integrations to maintain — but worth ruling out explicitly rather than by omission.

Resolution names the interface, states what capability is being given up, and records the migration cost if the decision is later reversed. Worth an ADR.

## Answer

**`codex exec` driven through `@openai/codex-sdk`.**

The crux question — *does v1 ever need to pause and ask before merging a PR or closing a ticket?* — was answered directly by the project owner: **no**. The coworker should run commands, call APIs, and create pull requests without stopping to ask. That disqualifies nothing on Option A and removes Option B's single decisive advantage, so the choice falls out immediately.

Worth noting the two paths **agree** rather than trading off: `codex exec` hard-codes `approval_policy: Never`, which is not a limitation to work around here — it is precisely the requested behaviour, on the stable, Apache-2.0, TypeScript-native interface. Option B would have meant tracking an experimental JSON-RPC protocol, against a project shipping multiple alpha releases per day, to buy a capability v1 does not want.

### What is given up

1. **`turn/steer` — mid-turn redirection is gone.** A human cannot nudge a running job from the thread. **Hard-stop is not gone**: the wrapper spawns the subprocess and can always kill it. So "stop it" is available; "change course without restarting" is not. If steering later proves necessary, the fallback is to interrupt and resume with amended instructions, which turn-granular session resumption already supports.
2. **Delta streams.** No live command output, no token-level streaming. The research argued item-level granularity is a *benefit* under Slack's rate limits, and the two-minute `setStatus` heartbeat requirement is satisfied by turn and item events without needing deltas. Accepted without regret.
3. **`dynamicTools`.** GitHub and Linear as in-process TypeScript functions is off the table. [Connector interface: MCP servers, a plugin API, or both?](07-connector-interface.md) narrows to MCP-only versus MCP-behind-a-thin-abstraction — a genuine simplification of that ticket.

### The consequence that has to be designed for

**With no approval gate, the token *is* the permission model.** The coworker holds write credentials and reads untrusted input — anyone who can post in a channel or file an issue can put text in front of it. The Codex research established that **the sandbox governs filesystem and network, not intent: nothing distinguishes reading a PR from merging one.** So a token that can merge means the agent can merge, and the only things standing between a malicious issue comment and a merged PR are:

- what the token literally cannot do (scoping),
- the Codex sandbox mode (filesystem and network reach),
- `execpolicy` rules (which commands may run),
- per-MCP-server `disabled_tools` (which tools exist at all).

That is a policy layer this project builds itself, and it is now the entire safety story. Graduated into [With no approval gate, what bounds the blast radius?](12-blast-radius.md).

### Reversibility

Keep the Codex integration behind an **adapter seam** — one module owning process lifecycle, event translation, and session identity. If approvals are ever required, the event-mapping layer (JSONL items → Slack posts) is largely reusable; the transport and lifecycle are not. Migration is a bounded rewrite of one module rather than a spreading change, provided nothing outside the adapter learns what `exec` is.

Recorded as [ADR-0001](../../../docs/adr/0001-codex-cli-via-exec-and-sdk.md).
