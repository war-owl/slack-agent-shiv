# Context

The domain language for this project. A glossary, not a spec — no implementation detail belongs here.

## Thread

A Slack conversation thread. The unit of **topic** and the unit of **audience**: everyone who can see the channel can see the thread, and nothing crosses between threads except through the [Vault](#vault).

Where the word is ambiguous — Codex also calls its own conversations "threads" — this glossary always means the Slack one. The Codex side is a [Session](#session).

## Session

The coworker's accumulated understanding of one Thread. Exactly one Session per Thread, for the life of the Thread: a follow-up three days later resumes the same Session and remembers what was said.

Sessions are isolated from one another. A Session knows what happened in its own Thread and what the coworker has written to the Vault — nothing else. This is deliberate: it makes the coworker's knowledge explainable ("it knows what it wrote down") and keeps a private channel's contents out of a public channel's answers.

## Job

One piece of delegated work: a human mentions the coworker, the coworker works, the coworker reports back. A Job is the unit a human thinks in — "I asked it to do a thing" — and the unit that succeeds or fails as a whole.

A Job belongs to exactly one Thread and runs in that Thread's Session. Jobs in the same Thread are strictly sequential; a mention arriving while a Job runs is queued for the next one.

## Turn

The unit of **durability**, imposed by the engine rather than chosen. Work is preserved at Turn boundaries: a Turn that completes is durable and resumable, a Turn interrupted partway cannot be resumed and its side effects may have partially landed.

A Job is normally one Turn. The distinction matters only at failure, which is exactly when it matters most.

## Vault

The linked web of Markdown files the coworker reads and writes, and which a human may open in Obsidian and edit directly. The only channel by which anything crosses between Sessions, and **the coworker's only memory** — there is no separate memory store.

Wikilinks are structure, not decoration: the Vault is a graph the coworker traverses, not a folder it scans.

## Note

A single Markdown file in the Vault. The one kind of artifact the coworker writes — what a human would call a note and what the coworker uses as memory are the same object, in the same place, in the same format. Either party may edit any Note.

A Note is **the current belief about its topic**, not a log of beliefs. Learning something that contradicts a Note means rewriting that Note, so divergence becomes visible to a human reading the Vault rather than accumulating silently.

Frontmatter carries when it was last modified and which Thread and Job wrote it, so both a human and the coworker can judge staleness and origin.

## Root note

The Vault's entry point: hub links only — people, projects, recurring topics — with every real fact one hop away in the graph. Small by construction and present in every Job, so the coworker always knows the map exists and where its doors are.

Its grammar is **wikilinks and short labels, nothing else** — it is the one file that is prompt rather than data, so it must have no room for prose that could instruct a future Job. Why a hub matters belongs in the hub's own Note.

It is an ordinary Note otherwise. A human can open it and rewrite it.

## Librarian

The coworker's standing responsibility for the Vault's navigability, discharged in a short Turn at the end of each Job: file the Note where it belongs, wire its wikilinks, update the Root note if a new hub appeared. Deliberately separate from doing the work, because curation degrades when it competes with the task for attention.

## Write

An action the coworker takes against something outside itself: opening a pull request, updating a ticket, posting a comment. Distinguished from reading because the coworker acts unattended, so every Write is appended to its Thread as a permanent record.
