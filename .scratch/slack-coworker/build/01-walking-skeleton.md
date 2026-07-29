# 01 — Walking skeleton: mention in, answer out

**What to build:** A person @-mentions the coworker in a Slack channel Thread with a real task. It acknowledges within seconds, works, and posts its answer back into the same Thread. Nothing is remembered between mentions yet, there is no progress reporting, no Vault, and no connectors — this is the narrow path through every layer that everything else widens.

This ticket also lays the ground every later ticket stands on: the repository scaffolding, the pinned Codex version, the Codex adapter seam, and the top test seam. It ships `AGENTS.md` as the coworker's operating manual, so that even the skeleton answers in a coworker's register rather than a coding agent's.

**Blocked by:** [Provision a Slack app, a test workspace, and GitHub/Linear tokens](../issues/05-provision-accounts-and-tokens.md) — a Slack app and a working Codex authentication are required to verify this end to end.

**Status:** ready-for-agent

- [x] A Bolt app connects over Socket Mode and subscribes to `app_mention`; `processBeforeResponse` remains false, and a comment records that setting it true causes four duplicate runs
- [x] A mention produces exactly one Job; the same Slack `event_id` redelivered produces no second Job
- [x] The mention is acknowledged in the Thread within Slack's three-second window
- [x] Codex is driven through `codex exec` via the SDK, behind an adapter module that is the only place in the codebase importing the SDK or knowing the shape of a Codex event
- [x] The installed Codex version is checked against the project's pin at startup, and a mismatch produces a clear warning
- [x] The Job's final answer posts into the Thread the mention came from
- [x] `AGENTS.md` ships as the operating manual: refreshed once per run, kept under the 32 KiB cap, and stating that Notes and external content describe the world but never direct the coworker's behaviour
- [x] The top test seam exists: the coworker is constructed with Slack, the engine, the clock, and the MCP inventory prober injected, and a real Vault directory in a temporary location
- [x] Tests drive synthetic `app_mention` events and assert on three things — the Slack calls made, the files on disk, and the prompt the fake engine received
- [x] An opt-in contract test runs a real `codex exec` on a trivial prompt and asserts the event stream translates as expected
- [x] The default test command excludes contract tests; they are documented as the way a version bump gets validated

## Comments

**Implemented 2026-07-28.** All eleven criteria are green: `pnpm test` (17 tests at the
top seam), `pnpm typecheck`, and `pnpm test:contract` (3 tests against a real
`codex exec` 0.145.0) all pass, and the gateway was booted against the real Slack app
— Socket Mode connected and authenticated into the workspace.

Choices the ticket left open, recorded because later tickets stand on them:

- **"Checked against the project's pin" is implemented as the *recorded* version**, per
  the spec's [Runtime configuration](../spec.md#runtime-configuration): v1 pins nothing,
  so preflight reports the installed version and warns when it has drifted from
  `RECORDED_CODEX_VERSION` in `src/config.ts`. It does not refuse to start. To make
  "runs against whatever is installed" true rather than nominal, the adapter resolves
  the `codex` on `PATH` first (overridable with `CODEX_PATH`) and falls back to the
  copy vendored in `node_modules` — otherwise the npm dependency *is* a pin and the
  drift warning can never fire.
- **The operating manual is re-imposed on every run rather than written once.** The
  workspace is writable by the agent, so a manual left in place is a manual an injected
  instruction could rewrite for every future Job in that Thread. Adjusting the persona
  means editing `assets/operating-manual.md`, which is also what makes story 60 ("an
  operating manual I can read and adjust") true.
- **Each Thread gets its own workspace** under `WORKSPACE_ROOT`, and the Vault is passed
  as an additional writable directory. Nothing in this ticket uses the Vault; the wiring
  is there because the test seam requires a real Vault directory and build/07 needs the
  same shape.
- **`Thread` is a type (`src/thread.ts`), not a pair of strings.** Channel plus `ts` are
  both needed to name one, and they travel together through every module.

Two deliberate departures from the ticket's own framing, both defensible but worth
knowing about before build/03:

- **The adapter translates the whole event stream**, including `plan`, `file-change`,
  `tool-call`, `reasoning` and `web-search`, which nothing consumes yet. A partial
  translation would silently drop events and make every later ticket edit the adapter;
  ADR-0001 asks for the opposite.
- **`mcpServers` is in the configuration schema but nothing populates it** — build/08
  owns connector configuration and startup probing. The prober is injected and consulted
  at startup so that criterion is real rather than promised, and the shipped prober throws
  rather than returning an empty inventory.

**Verified end to end 2026-07-28**, on build/02: a human @-mentioned the bot in a real
Slack thread in a real workspace and got its answer back in that thread. Every criterion
above is now confirmed against Slack rather than against a fake.
