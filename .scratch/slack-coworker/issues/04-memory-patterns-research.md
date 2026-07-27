# How do agents actually accumulate and recall memory?

Type: research
Status: resolved
Blocked by: —

## Question

"Evolves with learning memories" is the least well-defined thing in scope and the flagged sequencing risk. Get the landscape of real, working approaches before designing one.

Investigate against primary sources and report with citations:

- **The memory tool.** Anthropic's client-side memory tool — its commands, the `/memories` directory model, how the backend is implemented, and what it does and does not give you.
- **Managed Agents memory stores.** The workspace-scoped persistent store: how memories are addressed, how they are mounted into a session, versioning and redaction, and the preconditions on updates. Note what it costs in lock-in.
- **File-based memory as a pattern.** Agents that write learnings to plain Markdown and read them back. What makes this work well, what makes it degrade as the corpus grows, and what conventions successful implementations use.
- **Recall.** How does the right memory reach the model at the right moment? Always-loaded index, retrieval at question time, agent-initiated search, progressive disclosure. What are the failure modes of each — stale memories, contradictory memories, memories that never surface?
- **Curation and decay.** How do these systems avoid accumulating wrong or obsolete beliefs? What is the update-versus-append story, and who prunes?
- **Overlap with notes.** Where do "memory" and "a note in a vault" turn out to be the same mechanism, and where must they differ? Flag this explicitly — the next ticket depends on it.
- **What must never be stored.** Credentials and PII handling in a store that replays into every future session.

Deliverable: a cited Markdown file in the repo. Feeds *What is a note, and what is a memory?* and both memory fog patches.

## Answer

Findings: [`research/agent-memory-patterns.md`](../research/agent-memory-patterns.md) — 551 lines, cited against primary sources.

**The convergent shape.** Every surveyed system lands on the same architecture: a **small always-loaded index plus a larger corpus loaded on demand**. They differ only in what the index is and who may write to it. Nobody has solved decay — the two most sophisticated answers (Anthropic's consolidation pass, Codex's background memory generation) are both recent, and both treat curation as a separate asynchronous job rather than something the agent does inline.

**Recall is the crux, and the index is the trigger — not an optimisation.** On-demand search with no always-loaded pointer is the canonical never-surfaces failure: the memory exists, is correct, and is never read. Notably, almost none of the surveyed harnesses do embedding retrieval over memory; they do agent-initiated grep plus an index. That is a strong argument against building a retrieval stack for v1.

**Hard constraints that bound the design:**

- Codex CLI truncates the merged `AGENTS.md` set at `project_doc_max_bytes`, **default 32 KiB — silently**, not as an error. Any always-loaded index has to live inside that budget.
- Claude Code loads only the first 200 lines / 25 KB of its memory file, and enforces the ceiling on write *because the model will not self-police*. Budget enforcement belongs in the wrapper.
- Codex has a **native memories feature** (`~/.codex/memories/`, background generation on idle, secrets redacted) but it is **global, not per-project** — wrong scope for this product, though the shape is worth stealing.

**Notes vs memories** — the question ticket 06 asks. The mechanism is identical (Markdown, file tools, grep); the *policy* is not. The sources force three distinctions: index membership, write authority (trust class), and provenance metadata. That is three frontmatter fields and one index file — **not a second store**. Claude Code stamps a `modified` ISO timestamp so both human and model can judge staleness; **no source detects contradictions at write time**, so supersession has to be a deliberate design choice rather than something inherited.

Flagged gap: **no primary source puts agent memory inside a human's general-purpose Obsidian vault.** Co-location is unproven in either direction — this project would be doing something novel, and ticket 06 should treat it as such rather than assuming it is standard practice.

**Security — the sharpest finding.** Prompt-injected memory is a live risk for exactly this product: Slack messages, GitHub issues and Linear tickets are untrusted input, and content written into memory from them is read back as *trusted* fact in every later session. Codex ships `memories.disable_on_external_context` for this reason. Spun out as its own ticket rather than left in the fog.

**Four options, no pick made** (detail in the research file): (A) index-plus-topic-files, modelled on Claude Code auto memory; (B) notes-are-memories with a frontmatter discriminator; (C) A plus a scheduled consolidation pass; (D) deliberately thin v1, `AGENTS.md` only, memory deferred.
