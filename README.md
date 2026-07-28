# open-agent

A self-hosted AI coworker that lives in a Slack workspace you control, running
against tokens you issue. You @-mention it in a thread with a real task, close your
laptop, and come back to the work done.

This is the walking skeleton ([build/01](.scratch/slack-coworker/build/01-walking-skeleton.md)):
a mention goes in, an answer comes back into the same thread. Nothing is remembered
between mentions yet, there is no progress reporting, no Vault, and no connectors.

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
scripted engine, a controllable clock, and a real Vault directory in a temporary
location — and asserts on three things: the Slack calls made, the files on disk, and
the prompt the engine received. A test should still pass if the internals were
rewritten, and should fail if a self-hoster's experience changed.

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
