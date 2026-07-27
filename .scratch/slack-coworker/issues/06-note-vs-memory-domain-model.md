# What is a note, and what is a memory?

Type: grilling
Status: resolved
Blocked by: 04

## Question

The pitch says both "Obsidian-style notes" and "learning memories". Those may be one mechanism or two, and getting it wrong is expensive — it decides the storage model, the retrieval story, and what a human sees when they open the vault.

Run `/grilling` with `/domain-modeling` and settle the ubiquitous language. Terms that need pinning down, each with a scenario that proves the boundary:

- **Note** — a durable, human-readable, human-editable Markdown document in a vault the user also opens in Obsidian. Who authors it, the agent or the human, or both?
- **Memory** — something the agent learned and wants to recall later. Is that a note, a distinguished kind of note, or a separate store the human never sees?
- **Fact vs preference vs project state** — do these behave differently enough to be different concepts, or is that over-modelling?
- **Thread transcript** — is the Slack conversation itself an artifact that gets persisted, and if so is it a note?

Stress-test with concrete scenarios:

- The human edits a note the agent wrote. What happens on the next run?
- The agent learns something that contradicts a note it wrote last week. Is that an edit, a new note, or a superseding link?
- A memory turns out to be wrong. How does it get corrected or forgotten, and by whom?
- The vault reaches a thousand notes. What breaks?
- The agent learns something sensitive in a thread. Does it get written down at all?

Resolution creates or updates `CONTEXT.md` with the settled glossary, and an ADR if the note/memory split turns out to be a hard-to-reverse call. Graduates the memory write/recall policy and the knowledge-lookup fog into real tickets.

## Prior work

[How do agents actually accumulate and recall memory?](04-memory-patterns-research.md) is resolved and directly load-bearing here — read its section 5 ("Overlap with notes") before grilling. It argues both sides and concludes the mechanism is shared but the policy is not, reducing the split to three frontmatter fields plus one index file rather than two stores. It also flags that **no primary source puts agent memory inside a human's general-purpose vault**, so this project is doing something unproven either way — treat that as a real risk in the scenarios, not a settled convention.

## Answer

### 1. There is no memory store — the vault is the memory

One artifact, not two. Everything the coworker writes is a Markdown note in the Obsidian vault; "memory" is not a separate kind of thing, it is what those notes *are for*. A human colleague's notebook is their memory, and this collapses the distinction the same way.

This deliberately rejects the research's synthesis, which pointed at one pool with frontmatter discriminating trust class. The simplification is the point: one kind of artifact, one write path, one retrieval path, and nothing hidden from the human. What is given up is the ability to mark some knowledge agent-private — accepted, and arguably a feature for a tool whose selling point is memory you can read and correct.

### 2. Memory is the graph, explored per Job

Recall is **agent-initiated traversal**, not preloading. The vault is an Obsidian web — wikilinks are structure, not decoration — and each Job explores it, greps it, and follows links to assemble what it needs. Code search too, where the question is about a repo rather than the vault.

The stable operating manual stays **separate** from all of this and lives in `AGENTS.md`. This matches the Codex research exactly: `AGENTS.md` is capped at 32 KiB, silently truncated, always-on regardless of relevance, and refreshed once per run — a fine operating manual and a hopeless memory. Keeping the two apart also keeps `AGENTS.md` byte-stable, which is worth real money in prompt caching.

### 3. A tiny root note is the entry point

Exploration answers *how* to find things but not *whether the coworker looks at all*. Without something in front of it, the failure mode is not bad retrieval — it is answering confidently from the Thread while the relevant note sits unread. The research names this as the canonical never-surfaces failure and is unambiguous that the index is the trigger.

So: **one small root note, hub links only** — people, projects, recurring topics — a few hundred bytes, every real fact one hop away in the graph. It is itself just a note; a human can open and rewrite it.

**Mechanism (judgment call):** the wrapper reads the root note and injects its contents at Job start, rather than `AGENTS.md` instructing the agent to go read it. Injection is a structural guarantee; an instruction is a behavioural one, and behavioural guarantees are what this decision exists to avoid. It also keeps `AGENTS.md` stable and leaves the root a human-editable file in the vault.

### 4. The coworker is its own librarian, in a dedicated Turn

Vault navigability is the coworker's responsibility: notes filed into a sensible folder structure, wikilinks wired so traversal works, root updated when a new hub appears.

This happens in **a short, bounded Turn at the end of each Job** — separate from the work. The research is direct that curation degrades when it competes with the task for attention, and that the sophisticated systems treat it as a distinct pass. A closing Turn is the in-scope form of that: it is a Turn, not a schedule, so it does not collide with the map's exclusion of anything acting unprompted. Every Job pays one extra short Turn; accepted.

### Judgment calls recorded, not grilled

- **Frontmatter carries `modified` and provenance** — the Thread and Job that last wrote the note. Claude Code stamps a `modified` timestamp for exactly this reason: both human and model need to judge staleness, and with a shared vault you also need to know whether a claim came from the coworker or a person.
- **Contradictions are not detected at write time.** No surveyed system does this, and inventing it is out of scope. Supersession is by **editing the note in place** — one note per topic, so the note *is* the current belief rather than a log of beliefs. When the coworker learns something that contradicts a note, it rewrites the note. Divergence therefore surfaces to a human reading the vault, not to an algorithm.
- **The root note needs a ceiling.** Codex truncates silently, and a root that grows a link per project will eventually be quietly cut. The wrapper enforces a size limit on injection and surfaces a warning rather than truncating in silence.

### Consequences elsewhere

- **Ticket 10 is unblocked.** With one pool and no agent-private region, "what stops untrusted content becoming trusted memory" is now a question about a single write path — simpler to reason about, and higher stakes, since a poisoned note is indistinguishable in kind from a real one.
- **Ticket 08's cross-Thread context is now fully specified.** The Vault was already the only channel between Sessions; it is now also the only store, so "what the coworker knows across Threads" is exactly "what is in the vault".

Recorded as [ADR-0003](../../../docs/adr/0003-vault-is-the-memory.md). `CONTEXT.md` updated.
