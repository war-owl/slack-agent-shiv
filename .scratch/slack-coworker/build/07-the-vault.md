# 07 — The Vault: Notes, the Root note, and the Librarian

**What to build:** The coworker starts remembering. What it learns becomes Notes — Markdown files in a directory the human owns and can open in Obsidian, correct, or delete. It finds relevant Notes on its own by traversing wikilinks from a small Root note that is handed to it at the start of every Job. At the end of each Job it tidies up: files the Note, wires its links, updates the Root if a new hub appeared.

There is no separate memory store. The Vault is the memory, and everything the coworker believes is a file a human can read.

**Blocked by:** 04 — Audit: every Write appended

**Status:** ready-for-agent

### Notes

- [x] Notes are Markdown files in a configured directory, and that directory opens in Obsidian with wikilinks resolving normally
- [x] Frontmatter on each Note records when it was last modified and which Thread and Job wrote it
- [x] A Note is the current belief about its topic: learning something contradictory rewrites the Note in place rather than appending to a log
- [x] A Note created, changed, or deleted by the coworker appends its diff and provenance to the server Vault log without posting the Note into the Thread
- [x] **The diff is taken from the Vault's own contents before and after the Job, not from the engine's file-change events** — and anything that changed without a record gets one. [build/04](04-audit-writes.md#the-gap-shell-writes-the-wrapper-cannot-see) records Writes from the event stream, which misses a Note written with `cp`, `echo >` or `rm`; a snapshot able to produce a diff closes that at the filesystem level, and this ticket needs the snapshot regardless
- [x] A human's hand-edit to a Note is respected, and deleting a Note removes the belief completely — recovery needs no tooling

### The Root note

- [x] The Root note is injected into every Job by the wrapper, not fetched by an instruction in the prompt
- [x] At injection, any line that is not a wikilink with a short label is **dropped** — the Root is prompt rather than data, and this is the only structural barrier between one poisoned Job and every subsequent one. *(It is no longer the **only** prompt-shaped file: [build/15](15-skills.md) adds Skills, constrained by authorship rather than grammar. Two enforcement points, different in kind — a single "sanitise Notes" mechanism covers neither.)*
- [x] Dropped content is surfaced rather than silently discarded
- [x] A Root note over its size ceiling produces a warning and is **not** truncated, because Codex truncates silently at 32 KiB
- [x] The Root remains an ordinary Note a human can open and rewrite

### The Librarian

- [x] A closing pass at the end of each Job files the Note where it belongs, wires its wikilinks, and updates the Root note when a new hub appeared
- [x] **The pass searches before it writes**, and updating an existing Note is the default where anything close exists — see [the decision below](#decision-the-taxonomy-is-the-librarians-and-it-looks-before-it-writes)
- [x] **No folder taxonomy is shipped and none is enforced** — the structure is the Librarian's, and it evolves
- [x] The Librarian pass is a **separate Codex call** from the work, so curation does not compete with the task for attention
- [x] **The pass decides for itself whether anything is worth recording, and writes nothing when it is not.** It receives the Job's transcript and the Root note, and returning "nothing noteworthy" is a success. Most Jobs — a one-off question, a summary — should produce no Note; a fixed rule would either fill the Vault with query residue or miss the interesting Jobs
- [x] A failed, empty, or slow Librarian pass **never fails the Job** — the work is already done and reported, and curation is best-effort
- [x] Tested both ways against a real Vault directory: a trivial Job leaves no new file, a Job that learns something durable leaves exactly one
- [x] It is judged, so it will be inconsistent between runs. Do not test for a specific verdict on borderline input; test that the *no-Note* path exists and is taken on clearly trivial input
- [x] Cross-Thread context flows only through the Vault; nothing else crosses between Sessions

## Comments

**Implemented 2026-07-29.** All twenty criteria are green: `pnpm test` (119 tests at the
top seam, 22 of them new), `pnpm typecheck`, and `pnpm test:contract` (9 tests against a
real `codex exec` 0.145.0) all pass. The contract suite was re-run rather than skipped
because this ticket changed the engine port.

**Two things came out of `/code-review` and both changed the design rather than tidying
it.** They are the first and third bullets below; the rest is as it was built.

`Status:` stays `ready-for-agent`, as on 01–06 — the five canonical labels in
`docs/agents/triage-labels.md` have no completed state, so the checkboxes and this section
are what record that the work landed.

How it landed:

- **There is one Vault and up to four concurrent Jobs, so a change is not always
  attributable — and the record now says so instead of guessing.** This was the review's
  sharpest finding and it was a real defect: a Job's before/after window spans a
  *different* Thread's writes, so Thread A could observe Thread B's Note changes and stamp
  B's Notes with A's `job:`. Nothing in the filesystem says who wrote a file. So
  `vault/window.ts` tracks which Jobs have the Vault open, and a window that overlapped
  another marks its log records "another job was writing to the Vault at the same time, so this
  may be its change" and leaves `thread:`/`job:` off the frontmatter entirely — an absent
  field reads as unknown where a wrong one reads as fact. The two ways to make it
  *correct* both cost more than the problem: a Vault lock across each Job serialises the
  Jobs build/06 deliberately runs at once, and a per-Job view of the directory stops the
  Vault being one directory a human owns. **It reads like an audience leak and is not quite
  one** — an unattributable change can be observed by every overlapping window, but it is
  written only to the server log and never posted into another Thread. Pinned by a test
  that runs two Threads at once.
- **The answer is posted before the Librarian runs, and the pass's own Notes are recorded
  after it.** Also from the review, and the spec's own words settle it: "the work is
  already done **and reported**; curation is best-effort". The first version awaited the
  pass before posting, which meant a slow tidy-up delayed an answer that already existed by
  up to five minutes. So the Vault is settled up **twice** — once after the work, whose
  records land before the answer because that is when they happened, and once after the
  pass, whose records land after it for the same reason. Ordering stays chronological
  throughout, and nobody waits on bookkeeping.
- **The Vault's Writes are recorded from the Vault, and `writes/classify.ts` now records
  nothing for a file inside it.** This is the one decision here that changes something
  build/04 shipped, and it was build/04's own recommendation: a snapshot before and after
  answers *what changed* whatever tool changed it, and *what it now says*, where an event
  answers neither reliably. Recording from both places would put two permanent messages in
  the Thread for one Write; recording from the event stream would be recording the half
  that misses things. **The accepted cost is ordering**: a diff cannot exist until the Job
  is over, so Vault records arrive as a block at the end, after the external Writes and
  before the answer. Criterion 5 of build/04 — "records appear in the order the Writes
  happened" — is now true of external Writes and true of the Vault as a block; the test
  that pinned it says so in its name.
- **Five existing tests had to write real files, and that is a strengthening rather than a
  concession.** They emitted a `file-change` event naming a Vault path without creating
  anything, which is a fiction the filesystem rightly ignores. One of them ("is never
  edited afterwards") needed a Write that lands *mid*-Job to have anything to prove, so it
  now uses a `gh issue comment` instead of a Note.
- **The Librarian is a one-off Session, and the engine port says so.** `startOneOffSession`
  sits beside `startSession` and `resumeSession` and is the same call to Codex; the
  difference is that its identifier is thrown away. It is a seam worth having for two
  reasons. The wrapper genuinely treats the two differently — one id is written to the
  Session store and the other must never be — so a caller that cannot tell them apart is a
  caller that can persist the wrong one. And it keeps the *fake* honest: `ranTurns` still
  counts Turns of work, so the forty-odd existing assertions about how many Jobs ran did
  not become arithmetic about the Librarian.
- **The pass is handed the transcript because it does not share the Session.** That is
  what the spec asks for, and it is the tell that the pass must not be a second Turn in
  the Thread's Session: if it shared the conversation it would need no transcript. The
  transcript deliberately excludes reasoning — it is the largest thing in the stream, and a
  belief that only ever appeared in the coworker's own reasoning is not one the Vault
  should be recording.
- **A late stop stops the curation without turning a finished Job into a stopped one.**
  The pass runs on the Job's own signal, so "stop" reaches the whole Job — but `stoppedBy`
  is captured *before* the pass runs, and the report is built from that. Otherwise someone
  stopping a Job during its tidy-up would throw away an answer that was already complete
  and already correct. Pinned by a test, because the failure is silent and expensive.
- **Provenance is stamped by the wrapper, not written by the model**, onto exactly the
  Notes that changed during the Job. Asking the coworker to write it would make the one
  field that says "this came from the coworker" the one field the coworker could forget or
  fake. Stamping happens *before* the diff is taken, so the record in the Vault log matches
  the file a human opens, frontmatter included — and the Root note's own frontmatter is
  skipped by the links-only filter, or every Job in every Thread would have warned about
  the wrapper's own `modified:` line.
- **The Root's grammar requires a separator before a label.** `[[Atlas]] — payments` is a
  link with a label; `[[Atlas]] and then do the following` is prose. Without the separator
  the second reads as a 34-character label, and the grammar stops being something a reader
  can state in one sentence. The label is still bounded at sixty characters and that is
  still room for a short instruction — the same residual ADR-0004 already names, and the
  reason it is survivable is the bounded credential and the recorded diff rather than the
  regex.
- **The Root note's concerns are reported at startup as well as per Job**, because they are
  a standing condition rather than an event: a Vault full of prose in `Root.md` fires on
  every Job in every Thread until somebody fixes it, and the person who can fix it has just
  edited their Vault and restarted.

### Left for later tickets, deliberately

- **The Librarian is not registered as the Thread's running Job.** It runs on the Job's
  bound, so a stop reaches it — but `hardStop` looks up a *different* index that the Job
  has already left by then, so a stop landing during curation is answered "nothing was
  running" while the pass it just killed was. Harmless and short-lived; honest wording
  needs the running index to carry what phase a Job is in.
- **Nothing bounds the Librarian's spend.** Its Turn and its tokens are not counted against
  the Job's budget, only against its own five-minute clock. A pass cannot loop for long, so
  the exposure is one short Turn per Job — but it is a Turn the token budget cannot see.
- **A human editing a Note *during* a Job is attributed to the coworker.** The diff cannot
  tell the two apart, so their edit is recorded as a Write and stamped with the Job's
  provenance. Rare, visible in the Thread, and cheap to correct. It is the same blind spot
  as the concurrent-Jobs one above, and unlike that one the wrapper cannot even notice it:
  it knows how many Jobs it started, and nothing about who else has the vault open.
- **A Note caught mid-write can be recorded twice** — once as created, once as edited.
  Nothing coordinates a snapshot with another process's `writeFile`, so an accounting that
  reads the directory in that instant sees a file that exists and is empty, and the next one
  sees it with content. Both records are true statements about what the Vault held when
  they were made, and over-recording is the direction build/04 chose to be wrong in. Found
  by a flaky test rather than reasoning, which is worth knowing: the test now sequences the
  two Jobs so it does not race, and the behaviour it exposed is still there.
- **An unattributable change is recorded once per overlapping Thread.** Two Jobs running
  at once when one writes a Note means two records for one Write, each hedged. Chosen over
  the alternatives — one Thread picked arbitrarily would be a guess wearing a fact's
  clothes, and neither would be the silent hole build/04 is emphatic is worse.
- **A Note written and then deleted inside one Job leaves no record.** The snapshot sees
  net change, so a scratch Note in the Vault that the coworker cleaned up after itself is
  invisible. Arguably correct — nothing changed — but it is weaker than the event stream
  was on exactly that case.
- **The size ceiling is not enforced on what the Librarian writes**, only reported. A pass
  that adds a hub to an already-oversized Root makes it worse, and finds out by warning.

### Decision: the taxonomy is the Librarian's, and it looks before it writes

**Taken 2026-07-29, before implementation.** The map lists "Vault conventions" and "Vault
layout" as *not yet specified*; this settles them by refusing to specify them, and pairs
that with the thing that makes the refusal safe.

**No folder taxonomy ships.** No `people/`, `projects/`, `topics/` scaffold, no enum of
hub kinds, no validation on where a Note may live. The Librarian decides the structure and
it evolves. What the wrapper gives it instead of a layout is a set of invariants — one
topic per Note, reachable from a hub, Root is hubs only, the filename is the title — and
what it gives it in place of a convention is **the Vault as it currently stands**. Each
pass sees the Root and the existing tree and files alongside what is already there, so
the structure is self-reinforcing rather than declared. An empty Vault genuinely starts
flat. A human who moves a folder in Obsidian is followed on the next pass, because the
pass reads the shape rather than a config.

**The pass searches before it writes, and that is not an extra step — it is a
prerequisite.** A Note is the *current belief about its topic*, so learning something
contradictory rewrites it in place; there is no way to rewrite in place without first
finding what is already there. The spec says the same thing from the other side: the judge
needs to know what the Vault already contains or it will re-record it. So the pass is
**search → decide → write**:

1. Start at the injected Root, traverse to plausible hubs, grep the Vault for the topic's
   terms.
2. Then choose — **update** an existing Note, which is the default wherever anything close
   exists; **create** one and link it from the nearest hub; or **write nothing**.
3. Only when no hub covers the thing at all does the Root gain a line.

**This is also the answer to the Librarian's inconsistency**, which the ticket already
accepts for its verdicts and would otherwise have inherited for placement too. The drift
comes from filing blind: two similar Jobs on two days land in two folders. A pass that
looks first converges on wherever the previous one put things, so the taxonomy stabilises
by imitation instead of by decree — and the same look is what keeps the Vault from filling
with near-duplicates, because `update` is a branch the search makes reachable.

Two things make the search happen rather than be asked for politely. The Root is
**injected**, so the entry point is in the prompt whether the pass goes looking or not.
And a `create` decision has to **name what it looked at** — "I found nothing similar" is
then a claim in the transcript that a human reading the echoed diff can check, rather than
a step that was silently skipped.

What stays enforced by the wrapper regardless of what the Librarian decides: writes stay
inside the Vault, the Root stays links-only at injection ([ADR-0004](../../../docs/adr/0004-root-note-is-links-only.md)),
and the Skills location stays human-authored when [build/15](15-skills.md) arrives.
