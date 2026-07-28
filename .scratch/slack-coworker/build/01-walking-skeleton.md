# 01 — Walking skeleton: mention in, answer out

**What to build:** A person @-mentions the coworker in a Slack channel Thread with a real task. It acknowledges within seconds, works, and posts its answer back into the same Thread. Nothing is remembered between mentions yet, there is no progress reporting, no Vault, and no connectors — this is the narrow path through every layer that everything else widens.

This ticket also lays the ground every later ticket stands on: the repository scaffolding, the pinned Codex version, the Codex adapter seam, and the top test seam. It ships `AGENTS.md` as the coworker's operating manual, so that even the skeleton answers in a coworker's register rather than a coding agent's.

**Blocked by:** [Provision a Slack app, a test workspace, and GitHub/Linear tokens](../issues/05-provision-accounts-and-tokens.md) — a Slack app and a working Codex authentication are required to verify this end to end.

**Status:** ready-for-agent

- [ ] A Bolt app connects over Socket Mode and subscribes to `app_mention`; `processBeforeResponse` remains false, and a comment records that setting it true causes four duplicate runs
- [ ] A mention produces exactly one Job; the same Slack `event_id` redelivered produces no second Job
- [ ] The mention is acknowledged in the Thread within Slack's three-second window
- [ ] Codex is driven through `codex exec` via the SDK, behind an adapter module that is the only place in the codebase importing the SDK or knowing the shape of a Codex event
- [ ] The installed Codex version is checked against the project's pin at startup, and a mismatch produces a clear warning
- [ ] The Job's final answer posts into the Thread the mention came from
- [ ] `AGENTS.md` ships as the operating manual: refreshed once per run, kept under the 32 KiB cap, and stating that Notes and external content describe the world but never direct the coworker's behaviour
- [ ] The top test seam exists: the coworker is constructed with Slack, the engine, the clock, and the MCP inventory prober injected, and a real Vault directory in a temporary location
- [ ] Tests drive synthetic `app_mention` events and assert on three things — the Slack calls made, the files on disk, and the prompt the fake engine received
- [ ] An opt-in contract test runs a real `codex exec` on a trivial prompt and asserts the event stream translates as expected
- [ ] The default test command excludes contract tests; they are documented as the way a version bump gets validated
