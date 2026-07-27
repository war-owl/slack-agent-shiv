---
status: accepted
---

# The vault is the memory — there is no separate memory store

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
- **Cross-Thread context is fully determined**: the Vault was already the only channel between Sessions ([ticket 08](../../.scratch/slack-coworker/issues/08-job-model.md)), and is now also the only store.

Decided in [ticket 06](../../.scratch/slack-coworker/issues/06-note-vs-memory-domain-model.md); evidence in [`research/agent-memory-patterns.md`](../../.scratch/slack-coworker/research/agent-memory-patterns.md).
