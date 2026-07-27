# How does a delegated job actually run?

Type: grilling
Status: resolved
Blocked by: 11

## Question

This is the mechanism that makes delegate-and-walk-away real. Run it with `/codebase-design` — the job runner is the other deep module in this system.

Decide the job model:

- **Lifecycle.** A mention arrives. What is created, what does it own, and how does it end? Name the concept — job, run, task, session — and add it to `CONTEXT.md`.
- **Durability.** The process restarts an hour into a job. Does the job survive? If yes, what is checkpointed and where. If no, say plainly that it does not and what the human sees instead — a deliberately non-durable v1 is a legitimate answer if it is stated rather than assumed.
- **Progress reporting.** What does the human see while they are away, and how often? One status message edited in place, or appended updates? What counts as worth reporting — every tool call is noise, silence is worse. There is a real trap here: an agent that narrates every step is exhausting, and one that says nothing looks hung.
- **Concurrency.** Two mentions in two threads at once. Do they run in parallel, queue, or share state? What about a follow-up mention in a thread whose job is still running — steer the running job, queue behind it, or start a second?
- **Interruption.** How does a human stop it, and what happens to work in flight?
- **Bounds.** What stops a job running forever or spending unboundedly? Wall-clock timeout, token budget, iteration cap.
- **Failure.** The job dies. What lands in the thread, what is recoverable, and how much detail does the human get?

Resolution defines the job lifecycle, the progress-reporting contract, and the bounds. Likely graduates the permission-model and failure-behaviour fog into tickets.

## Facts established since charting

From [What can Codex CLI actually do when driven headlessly?](09-codex-cli-headless-surface.md) — these turn several of the questions above from open-ended into concrete:

- **Durability is turn-granular.** Sessions persist as append-only JSONL rollouts and `codex exec resume <id>` restores context in a fresh process — but a crash mid-turn cannot resume *that* turn. Treat the turn as the unit of durability. The hard part is not restart, it is **reconciling side effects**: a branch already pushed or an issue already filed when the turn is retried.
- **Progress is item-level, not token-level.** Typed events for commands, file changes, MCP tool calls and a live todo list. The todo list is the only thing emitting `item.updated`, which makes it the natural fit for a single edit-in-place checklist message. Long-running commands are silent until completion — decide whether that matters.
- **Interruption may be free.** `turn/steer` and `turn/interrupt` would let a human redirect or stop a running job from the thread — a natural fit for "delegate and walk away, but glance back". Only under the `app-server` interface; see ticket 11.
- **No cost ceiling exists.** Usage is reported after the turn completes; there is no budget limit or max-turns kill switch. Every bound this ticket defines has to be enforced by the wrapper.
- **Session storage has no documented retention policy**, and `--ephemeral` silently disables persistence entirely. Pruning `~/.codex/sessions` is this project's problem.

## Answer

Vocabulary settled first, because Slack and Codex both say "thread" and mean different things. Written to [`CONTEXT.md`](../../../CONTEXT.md): **Thread** (Slack, the unit of topic *and audience*), **Session** (the coworker's understanding of one Thread), **Job** (one delegated piece of work), **Turn** (the engine-imposed unit of durability), **Vault**, **Write**.

### 1. One Session per Thread

A Thread is a topic; the Session is that topic's memory. Each mention resumes the Thread's Session via `resumeThread()`, so context accumulates where a human expects it and "now do the same for the other repo" resolves without restating anything. Maps directly onto Codex's own `thread_id` and append-only rollout, so durability is mostly inherited rather than built.

Requires a persisted `thread_ts → codex thread_id` mapping. That is the wrapper's only real state — Codex owns everything else.

### 2. Cross-Session context goes through the Vault, and only the Vault

Sessions never read each other. What crosses Threads is what the coworker deliberately wrote down.

This was raised as a requirement — *"as a coworker the agent should be able to get context of other sessions if required"* — and routing it through the Vault rather than through transcript access is what makes it safe. **Threads have different audiences.** Letting a Session grep `~/.codex/sessions` would put a private channel's transcript one command away from a public channel's answer, and would bypass every memory-policy decision in tickets 06 and 10.

Routing it through the Vault gives a mental model identical to a human colleague's — *it knows what it wrote down, not what it overheard* — and it reduces the privacy question to one already-scoped decision: what gets written down. It also makes ticket 06's memory design load-bearing for this, not just for the memory capability.

### 3. Concurrency: queue at the Turn boundary

A mention arriving mid-Job is held and delivered into the same Session once the current Turn completes. This is the model the engine already imposes — a Session accepts input only at Turn boundaries — and it matches Slack's own event queuing. Acknowledge receipt immediately so the human knows it landed.

Accepted cost: a follow-up can wait minutes behind a long Turn. Notably this includes corrections — *"stop, wrong repo"* queues rather than interrupting. Hard-kill remains available (the wrapper owns the subprocess), so an explicit stop is still possible; it is just not the default reading of a follow-up message.

### 4. Progress and audit are two channels with opposite semantics

- **Progress — one message, edited in place.** Driven by Codex's `todo_list` item, which is the only thing emitting `item.updated` in `exec`, and refreshed inside the **two-minute `assistant.threads.setStatus` timeout**. Cheap under Slack's Tier 3 `chat.update` limits, where `chat.postMessage` is roughly 1/sec/channel.
- **Audit — every Write appended as its own permanent message.** PR opened, ticket updated, comment posted. With no approval gate ([ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md)) the Thread is the only accountability record a human ever sees, so this half must not be overwritable. That is the whole reason for two channels rather than one.

This resolves the audit question handed over from ticket 12.

### Judgment calls recorded, not grilled

- **Bounds are the wrapper's job entirely.** Codex reports `turn.completed.usage` after the fact and offers no ceiling, no max-turns, no kill switch. v1 enforces a per-Turn wall-clock timeout (hard-kill the subprocess on expiry), a max-Turns-per-Job cap, and a cumulative token budget accumulated from `turn.completed.usage`. All three configurable, all three with defaults conservative enough that a runaway Job costs an annoyance rather than a bill.
- **Failure reports what is known and admits what is not.** A Job that dies posts to the Thread: what completed, what did not, and — explicitly — that side effects may have partially landed. The Session survives, so the next mention resumes from the last completed Turn.
- **Resumption must warn the model.** On resuming after an interrupted Turn, inject a note that the previous Turn was interrupted and may have partially completed, and that it should verify state before repeating actions. Without this the agent re-runs work whose side effects already landed — pushing a branch that exists, filing a duplicate ticket. This is the sharp edge of turn-granular durability and the wrapper is the only thing positioned to handle it.

### Not decided here

Retention and pruning of `~/.codex/sessions` (no documented policy upstream), and what happens to a Session when a Thread is archived or deleted. Both left in the fog — neither blocks a v1 spec.
