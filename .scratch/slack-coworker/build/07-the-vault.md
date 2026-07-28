# 07 — The Vault: Notes, the Root note, and the Librarian

**What to build:** The coworker starts remembering. What it learns becomes Notes — Markdown files in a directory the human owns and can open in Obsidian, correct, or delete. It finds relevant Notes on its own by traversing wikilinks from a small Root note that is handed to it at the start of every Job. At the end of each Job it tidies up: files the Note, wires its links, updates the Root if a new hub appeared.

There is no separate memory store. The Vault is the memory, and everything the coworker believes is a file a human can read.

**Blocked by:** 04 — Audit: every Write appended

**Status:** ready-for-agent

### Notes

- [ ] Notes are Markdown files in a configured directory, and that directory opens in Obsidian with wikilinks resolving normally
- [ ] Frontmatter on each Note records when it was last modified and which Thread and Job wrote it
- [ ] A Note is the current belief about its topic: learning something contradictory rewrites the Note in place rather than appending to a log
- [ ] A Note created or changed by the coworker echoes its diff into the Thread through the audit channel, so a poisoning attempt is visible where the human is already reading
- [ ] A human's hand-edit to a Note is respected, and deleting a Note removes the belief completely — recovery needs no tooling

### The Root note

- [ ] The Root note is injected into every Job by the wrapper, not fetched by an instruction in the prompt
- [ ] At injection, any line that is not a wikilink with a short label is **dropped** — the Root is prompt rather than data, and this is the only structural barrier between one poisoned Job and every subsequent one. *(It is no longer the **only** prompt-shaped file: [build/15](15-skills.md) adds Skills, constrained by authorship rather than grammar. Two enforcement points, different in kind — a single "sanitise Notes" mechanism covers neither.)*
- [ ] Dropped content is surfaced rather than silently discarded
- [ ] A Root note over its size ceiling produces a warning and is **not** truncated, because Codex truncates silently at 32 KiB
- [ ] The Root remains an ordinary Note a human can open and rewrite

### The Librarian

- [ ] A closing pass at the end of each Job files the Note where it belongs, wires its wikilinks, and updates the Root note when a new hub appeared
- [ ] The Librarian pass is a **separate Codex call** from the work, so curation does not compete with the task for attention
- [ ] **The pass decides for itself whether anything is worth recording, and writes nothing when it is not.** It receives the Job's transcript and the Root note, and returning "nothing noteworthy" is a success. Most Jobs — a one-off question, a summary — should produce no Note; a fixed rule would either fill the Vault with query residue or miss the interesting Jobs
- [ ] A failed, empty, or slow Librarian pass **never fails the Job** — the work is already done and reported, and curation is best-effort
- [ ] Tested both ways against a real Vault directory: a trivial Job leaves no new file, a Job that learns something durable leaves exactly one
- [ ] It is judged, so it will be inconsistent between runs. Do not test for a specific verdict on borderline input; test that the *no-Note* path exists and is taken on clearly trivial input
- [ ] Cross-Thread context flows only through the Vault; nothing else crosses between Sessions
