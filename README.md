# open-agent

A self-hosted AI coworker that lives in a Slack workspace you control, running
against tokens you issue. You @-mention it in a thread with a real task, close your
laptop, and come back to the work done.

So far it is the walking skeleton ([build/01](.scratch/slack-coworker/build/01-walking-skeleton.md)),
one Session per thread ([build/02](.scratch/slack-coworker/build/02-session-per-thread.md)),
a progress message ([build/03](.scratch/slack-coworker/build/03-progress-status-message.md)),
an audit trail ([build/04](.scratch/slack-coworker/build/04-audit-writes.md)),
bounds ([build/05](.scratch/slack-coworker/build/05-bounds-and-failure.md)),
a queue ([build/06](.scratch/slack-coworker/build/06-queue-at-turn-boundary.md)),
and the Vault ([build/07](.scratch/slack-coworker/build/07-the-vault.md)):
a mention goes in, one message keeps you posted on the plan and the step it is on, every
action it takes out in the world is appended to the thread permanently, and an answer
comes back into the same thread — where a follow-up days later resumes the same
conversation without you restating anything. Each thread gets its own session and
is never handed another thread's — though it is not yet *prevented* from going and
reading one, which is measured and written down in
[ADR-0003](docs/adr/0003-vault-is-the-memory.md). It now remembers, in Markdown you own
(below). No connectors yet.

The design lives in [`.scratch/slack-coworker/spec.md`](.scratch/slack-coworker/spec.md),
the domain language in [`CONTEXT.md`](CONTEXT.md), and the decisions in
[`docs/adr/`](docs/adr).

## Running it

You need Node 20+, [pnpm](https://pnpm.io), and a Codex login (`codex login`).

```bash
pnpm install
cp .env.example .env   # then fill in your Slack tokens
pnpm start
```

The only thing the instance keeps for itself is `.state/sessions.json`: which Codex
session each Slack thread resumes into. Conversations live on Codex's disk and notes
live in the Vault, so that one small file is all this project persists — delete it and
every thread starts over as if it had never spoken to you.

## Its memory is a folder of Markdown

Point `NOTES_DIR` at a directory — an Obsidian vault, if you use one — and that is
where everything the coworker learns goes. **There is no other memory**: no hidden
store, no embedding index, nothing it believes that you cannot open in a text editor.
Edit a Note by hand and it respects your edit; delete one and the belief is gone.

The vault has two halves, and the split is a boundary rather than an arrangement:

```
vault/
  Notes/     the coworker reads and writes these — its memory
  Skills/    procedures you write for it, which it reads and cannot write
```

A **Skill** is how you teach it to do something without writing code: how to reach the
analytics replica, which command pulls the weekly export, what the output means. An
ordinary Markdown file, edited in the same Obsidian. It is told what Skills exist at the
start of every job and reads the one that applies.

It **cannot edit them**, and that is the point — a Skill it could rewrite would be a way
for something it read in one thread to put a command in front of a job in another. When it
finds a procedure has drifted it says so in the thread and writes a Note about it; the fix
is yours. A Skill names an environment variable where it needs a credential and never
contains one, and anything reached this way has **the credential as its only boundary**,
so scope it accordingly — see [docs/skills.md](docs/skills.md).

At the end of each job it decides for itself whether anything was worth remembering.
**Usually the answer is no** — a question answered is not something learned — and
writing nothing is the expected outcome rather than a failure. When there is something,
it searches the vault first and updates what is already there by preference, so the
vault grows rather than accumulating near-duplicates. There is no folder taxonomy: it
files alongside whatever arrangement it finds, so if you move things, your arrangement
is the one it follows.

**Every Note it creates, changes or deletes is echoed into the thread as a diff** —
including ones written by a shell command, because the record comes from comparing the
directory before and after rather than from what the engine said it did. That echo is
the control: a note that says something wrong, or something planted by text the
coworker read somewhere, shows up where you are already reading, and fixing it is
deleting a file.

One file in the vault is different. `Root.md` is the map — hub links only, and it is
put in front of the coworker at the start of every job, which is what stops it
answering confidently while the note that settles the question sits unread. Because it
reaches every job in every thread, **anything in it that is not a wikilink with a short
label is stripped before the model sees it**, and you get told what was stripped. That
is deliberate and load-bearing rather than fussy: it is the only thing standing between
one poisoned job and every job after it ([ADR-0004](docs/adr/0004-root-note-is-links-only.md)).
It is otherwise an ordinary note — open it and rewrite it.

## What stops a runaway job

Codex has no limits of its own — no timeout, no cap on turns, no budget, no kill
switch — so all three are this wrapper's, and they are the ones you get by doing
nothing: **an hour on a single turn, eight turns per job, and a million tokens per
job.** A job that hits one is killed and says in the thread which limit stopped it,
how far it had got, and that whatever it had already done out in the world still
stands. All three are configurable in `.env`.

Worth knowing before you leave the defaults alone: Codex reports what a turn cost only
once the turn is over, and a whole job is normally one turn — so the token budget can
refuse the *next* turn but cannot stop one that is already spending. **The hour is
therefore the real ceiling on a single runaway turn.** Lower `TURN_TIMEOUT_MS` if an
hour of unattended spend is more than you want to risk; it costs long jobs, not safety.

You can also stop a job yourself: **`@coworker stop`, and nothing else in the
message.** A mention that says anything more is a correction, not a kill switch.
Stopping kills the engine, but a shell command it had already launched can outlive it
— see [build/05](.scratch/slack-coworker/build/05-bounds-and-failure.md#the-limit-on-what-stop-means).

Four jobs run at once across the whole instance (`MAX_CONCURRENT_JOBS`); the rest wait
their turn and say so in their thread.

The closing pass that files notes has a bound of its own (`LIBRARIAN_TIMEOUT_MS`, five
minutes). Hitting it abandons the tidying up and never fails the job — the work is done
and reported by then, and curation is best-effort.

## Mentioning it while it is already working

**One thread runs one job at a time.** Mention it again while a job is running and the
new message is acknowledged immediately and then picked up the moment the current job
finishes — in the same conversation, in the order the messages arrived. Other threads
are unaffected: they run their own jobs at the same time.

The cost is that **a correction waits too.** "@coworker stop, wrong repo" is a message
with words in it, so it queues rather than interrupting, and the coworker finishes the
wrong work before reading it. If you want it to drop what it is doing, that is
`@coworker stop` on its own — which also throws away anything queued behind the job,
and says in the thread what it threw away.

It runs against the `codex` on your `PATH` — the installation you log in with and
upgrade — falling back to the copy in `node_modules` if there is none, and reporting
which version it found at startup. v1 pins no version deliberately (see
[the spec](.scratch/slack-coworker/spec.md#runtime-configuration)), so that report is
how you find out what changed when something breaks overnight.

## Tests

```bash
pnpm test          # the default suite: fast, no network, no Codex
pnpm typecheck
pnpm test:contract # slow, opt-in: runs a real `codex exec`
```

`pnpm test` drives the whole coworker through one seam at the top — a fake Slack, a
scripted engine, a controllable clock, and real files in a temporary location for the
Vault and the Session store — and asserts on three things: the Slack calls made, the
files on disk, and the prompt the engine received. A test should still pass if the
internals were rewritten, and should fail if a self-hoster's experience changed.

**`pnpm test:contract` is how a Codex version bump gets validated.** It runs a real
`codex exec` and asserts the things a fake cannot honestly assert — that the JSONL
event stream still translates into the events this wrapper expects. It costs tokens,
needs working Codex credentials, and is excluded from `pnpm test`. Because there is
no version pin, run it against whatever version is installed rather than only at a
deliberate bump: it is the only thing standing between an upstream alpha and an
instance that is silently broken.

## The coworker's operating manual

[`assets/operating-manual.md`](assets/operating-manual.md) is the coworker's persona
and standing rules. It is copied into every Job's workspace as `AGENTS.md` before the
engine starts, on every run — so adjusting how the coworker behaves means editing
that file, and a Job cannot rewrite its own instructions for the next one.
