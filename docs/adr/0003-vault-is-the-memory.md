---
status: accepted
---

# The vault is the memory — there is no separate memory store

**Amended.** Session isolation was stated here as settled. It is only half-structural, as measured on [build/02](../../.scratch/slack-coworker/build/02-session-per-thread.md): the Vault is genuinely the only channel between Sessions for what the engine *loads*, but it is not the only channel for what the agent can *go and read*. Under `sandboxMode: "workspace-write"` filesystem reads are unrestricted, and `codex exec` exposes no way to narrow them — the readable-root machinery exists in the binary but only behind `--permission-profile` on `codex sandbox`, and `sandbox_permissions=[]` is inert. Codex names each rollout `~/.codex/sessions/<date>/rollout-<timestamp>-<session id>.jsonl`, so a Job that goes looking can read another Thread's transcript. The consequence below is corrected accordingly; nothing else in this decision changes.

The coworker keeps Obsidian-style notes *and* accumulates what it learns, and these could have been two subsystems. They are one: **everything the coworker writes is a Note in the Vault, and those Notes are its memory.** Recall is agent-initiated traversal of the wikilink graph rather than preloading, with one small **Root note** injected into every Job as the entry point, and the coworker acts as its own **Librarian** in a short Turn at the end of each Job — filing, linking, updating the Root. The stable operating manual stays out of all of it, in `AGENTS.md`.

## Considered options

- **One pool, frontmatter marking trust class** — what the research synthesis pointed to (three frontmatter fields and one index file, not a second store). Rejected for the simpler model: one artifact, one write path, one retrieval path, nothing hidden from the human.
- **Two directories, or two separate stores** — rejected for the same reason; the separation buys auditability that a fully-visible vault already provides.
- **A wrapper-generated index of everything** — rejected in favour of graph traversal from a small Root, which scales with the vault instead of against a byte budget.
- **No entry point at all** — rejected. Exploration answers *how* to find things, not *whether the coworker looks*; the research names "memory exists, is correct, is never read" as the canonical failure, and the index is the trigger.

## Consequences

- **No agent-private knowledge.** Everything the coworker believes is a file a human can read, correct, or delete. Accepted, and arguably the product's point.
- **The Root note is injected by the wrapper, not fetched by instruction.** Injection is a structural guarantee; "always read the root first" is a behavioural one, and behavioural guarantees are what the Root exists to replace. The wrapper enforces a size ceiling and warns rather than truncating, because Codex truncates `AGENTS.md` silently at 32 KiB.
- **`AGENTS.md` is the operating manual and never the memory** — capped, always-on regardless of relevance, refreshed once per run. Keeping it stable also keeps the prompt cache warm.
- **Every Job pays one extra short Turn** for the Librarian pass.
- **Contradictions are not detected at write time.** No surveyed system does this. A Note is the current belief and is rewritten in place, so divergence surfaces to a human reading the vault rather than to an algorithm.
- **A poisoned Note is indistinguishable in kind from a real one**, since there is no trust class in the model — which raises the stakes on [ticket 10](../../.scratch/slack-coworker/issues/10-memory-poisoning.md) rather than lowering them.
- **Cross-Thread context is determined for what a Session loads, and only behavioural for what it reads.** The Vault was already the only channel between Sessions ([ticket 08](../../.scratch/slack-coworker/issues/08-job-model.md)), and is now also the only store: a resumed Session is handed its own Thread's conversation and nothing else, which is structural and tested. But **the isolation is not enforced against an agent that goes looking**, per the amendment above. Three things follow, and the first two are the whole mitigation:
  - The operating manual carries a standing "one thread, one conversation" instruction, naming `~/.codex` specifically. Declared defence-in-depth, exactly like the injection rule — **not a control**.
  - The wrapper's own Session mapping is **keyed by digest rather than by channel**, so the one file this project writes is not itself an index from a private channel to the file holding its conversation. Also not a boundary; it is the difference between a lookup and a search, and it costs nothing.
  - Relocating `CODEX_HOME` would take the coworker's transcripts off the path an agent would try first, and would additionally stop a Job reading the human's *personal* Codex sessions. It is not done here because `CODEX_HOME` is also where `auth.json` lives, and the spec already flags a credential that silently expires mid-Job as the production failure mode to watch for. It belongs with the setup story on [build/13](../../.scratch/slack-coworker/build/13-setup-story.md), which can ask for a `CODEX_HOME=… codex login` and get it for free.

Decided in [ticket 06](../../.scratch/slack-coworker/issues/06-note-vs-memory-domain-model.md); evidence in [`research/agent-memory-patterns.md`](../../.scratch/slack-coworker/research/agent-memory-patterns.md). Amended on [build/02](../../.scratch/slack-coworker/build/02-session-per-thread.md) when the sandbox's read boundary was measured.
