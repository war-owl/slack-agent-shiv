# 02 — One Session per Thread

**What to build:** A person mentions the coworker in a Thread, gets an answer, and comes back three days later with "now do the same for the other repo". The coworker remembers the whole conversation and resolves the reference without being told anything again. A mention in a different Thread starts fresh and can see nothing of the first.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [x] A second mention in the same Thread resumes that Thread's Session rather than starting a new one
- [x] The coworker answers a follow-up using context from earlier in the Thread, with nothing restated by the human
- [x] The `thread_ts → codex thread_id` mapping is durable and survives a process restart
- [x] A mention in a different Thread runs in a different Session, and nothing from the first Thread appears in its answers
- [ ] The coworker cannot reach Codex's own session storage — verified, not assumed, since that path would put a private channel's transcript one command from a public channel's answer
- [x] The Session mapping is the only durable state the wrapper owns; Session content stays with Codex and Notes stay in the Vault
- [x] An opt-in contract test confirms a real Session resumes in a fresh process

## Comments

**Implemented 2026-07-28.** Six of seven criteria are green: `pnpm test` (27 tests at the
top seam, 10 of them new), `pnpm typecheck`, and `pnpm test:contract` (5 tests against a
real `codex exec` 0.145.0, 2 of them new) all pass. **The fifth criterion does not hold,
and the route to making it hold was rejected rather than unavailable** — see below,
because it is the only finding here that changes what the project may claim.

How the mechanism landed:

- **`resumeSession(id, options)` on the engine port**, implemented over the SDK's
  `codex.resumeThread`. The adapter stays the only thing that knows a Codex thread from
  a Session, per ADR-0001. Nothing about the Thread's history is passed back in — the
  identifier is the whole input, which is what makes the mapping the only durable state.
- **The mapping is one JSON file** (`.state/sessions.json`), written under a unique
  temporary name and renamed over the original so a crash mid-write leaves the previous
  mapping intact rather than a truncated file that reads as "no Thread has a Session".
  Writes are serialised because Jobs in different Threads run concurrently and each
  write rewrites the whole file, and the in-memory copy is updated only once the write
  lands, so a `get` never claims a Session that is not on disk. The spec left the store
  to implementation; a file needs no daemon for a self-hoster to run.
- **Threads are keyed by digest, not by name — and this was a bug caught in review.**
  The first version stored `channel:ts → session id` with `channel` and `ts` also
  denormalised into each record "so the file is readable on its own". That made
  `.state/sessions.json` an index from Slack channel to transcript file: Codex names
  each rollout `…/rollout-<timestamp>-<session id>.jsonl`, and reads are unrestricted,
  so it was a lookup table for exactly the leak criterion 5 is about — newly created by
  this ticket, in the one file this project writes. Keying on
  `sha256(channel + " " + ts)` and storing nothing else keeps the store's own job intact
  (a Thread knows its own channel and `ts`, so it can find its Session) while removing
  the enumeration. It is not a boundary — the transcripts are readable either way — but
  it is the difference between a lookup and a search and it costs nothing. The price is
  that the file is no longer human-readable; the instance log names which Session each
  Thread resumed into, which is the better place to look anyway.
- **The store is opened eagerly at startup, an unreadable one is fatal, and the file is
  parsed rather than trusted.** A store that will not parse means every Thread has
  silently forgotten everything, which a self-hoster should learn at startup with the
  other preflight problems rather than from a Job that answered as if they had never
  met. Validated with zod, like the configuration, because `JSON.parse("null")` succeeds
  and would otherwise surface as a `TypeError` deep inside a Job. Truncated, empty,
  `null`, and future-version files are all covered at the top seam.
- **The Session is recorded on `session-started`, not at the end of the Job.** That is
  the first moment it has an identity, and a Job that dies mid-Turn would otherwise
  orphan a live Session on Codex's disk and start the Thread over from nothing.
- **`stateDir` is deliberately outside both the Vault and every workspace.** The Vault
  is the human's, and a workspace is writable by the agent — which must not be able to
  edit which Session another Thread resumes into.

### The one criterion that failed: session storage is readable

Measured three ways, all negative:

- Under `sandboxMode: "workspace-write"`, a Job runs `ls "$HOME/.codex/sessions"` and
  gets the full listing — every Thread's rollout `.jsonl`, and the self-hoster's own
  interactive Codex transcripts along with them.
- `codex exec` exposes **no way to narrow reads**. The readable-root machinery exists in
  the binary (`--sandbox-state-readable-root`, `--permission-profile`) but only on
  `codex sandbox`, not on `exec`, so the SDK cannot reach it.
- `-c sandbox_permissions=[]` is **inert** — the documented-looking lever for dropping
  `disk-full-read-access` changes nothing; the read still succeeds.

So the isolation ADR-0003 asserts — "Sessions never read each other" — is real for what
the engine *loads* (a resumed Session sees only its own Thread, and that is tested), but
it is **behavioural rather than structural** for what the agent can *go and read*. The
contract test `cannot yet be prevented from reading Codex's own session storage` encodes
the finding so that upstream fixing it shows up as a failing test rather than as nothing;
it asserts on the rollout filenames rather than on the absence of a denial message,
because "no such file or directory" is also not a denial and a test that passed on it
would report the hole as closed when the directory had merely moved.

What was done about it, and what was deliberately not:

- **The operating manual now carries a standing "one thread, one conversation"
  instruction**, naming `~/.codex` specifically. Declared defence-in-depth, exactly like
  the existing injection rule — not a control.
- **The Session mapping is keyed by digest**, so this project does not itself ship the
  index (above).
- **Relocating `CODEX_HOME` is available and was rejected — for a stated reason, not
  because it is impossible.** The SDK takes an `env` for the Codex process, so pointing
  the instance at its own Codex home is reachable today. It would take the coworker's
  transcripts off the one path an agent would try, and would additionally stop a Job
  reading the human's *personal* Codex sessions, which is a leak this ticket did not set
  out to find. It is not done here because `CODEX_HOME` is also where `auth.json` lives,
  so it means copying a credential (stale when the token refreshes), symlinking it
  (broken if Codex rewrites the file by rename), or asking for a second `codex login`.
  The spec already flags "a credential that silently expires mid-Job" as the production
  failure mode to watch for, and the third option is a setup-story change. So the trade
  is deliberate and the work is **carried to [build/13](13-setup-story.md)**, where
  "run `CODEX_HOME=… codex login`" is one line of a guide that is being written anyway.
- **Per-Thread `CODEX_HOME` is not a fix** even setting auth aside: sibling directories
  are enumerable, so it is obscurity rather than a boundary.

**[ADR-0003](../../../docs/adr/0003-vault-is-the-memory.md) is amended** to state the
isolation guarantee at its measured strength. Same class of finding as the
branch-protection measurement in ADR-0002 — the design is sound, one layer turned out to
be weaker than written down, and the honest move is to write down which.

### Known trap left for build/05

A mapping pointing at a Session that Codex has pruned will fail **every** future mention
in that Thread, permanently. There is deliberately no fallback: retrying on a fresh
Session would silently discard the Thread's memory, and a transient engine error is
indistinguishable from a missing rollout at this seam. Build/05 owns failure and bounds
and is where this belongs, together with the interrupted-Turn warning the spec's test
list pairs with resume — also not implemented here, for the same scope reason.

**Not verified:** a human mentioning the bot in a real Slack thread, waiting, and
mentioning it again. The resume path is verified against a real `codex exec` in a fresh
engine, which is the part that could have been wrong.
