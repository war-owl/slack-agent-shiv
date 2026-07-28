# open-agent

A self-hosted AI coworker that lives in a Slack workspace you control, running
against tokens you issue. You @-mention it in a thread with a real task, close your
laptop, and come back to the work done.

So far it is the walking skeleton ([build/01](.scratch/slack-coworker/build/01-walking-skeleton.md)),
one Session per thread ([build/02](.scratch/slack-coworker/build/02-session-per-thread.md)),
a progress message ([build/03](.scratch/slack-coworker/build/03-progress-status-message.md)),
and an audit trail ([build/04](.scratch/slack-coworker/build/04-audit-writes.md)):
a mention goes in, one message keeps you posted on the plan and the step it is on, every
action it takes out in the world is appended to the thread permanently, and an answer
comes back into the same thread — where a follow-up days later resumes the same
conversation without you restating anything. Each thread gets its own session and
is never handed another thread's — though it is not yet *prevented* from going and
reading one, which is measured and written down in
[ADR-0003](docs/adr/0003-vault-is-the-memory.md). There is no Vault and no connectors,
and nothing yet bounds how long a Job may run.

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
will live in the Vault, so that one small file is all this project persists — delete
it and every thread starts over as if it had never spoken to you.

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
