# 15 — Skills: human-authored procedures the coworker can follow

**What to build:** A place a human writes down *how to do something* — reach the read-only analytics database, pull the weekly export, run the reconciliation — that the coworker can find and follow, and that the coworker **cannot edit**. The first real Skill is database access: it names a connection environment variable and the shape of a query, and the coworker works out the rest.

Skills are how this project gets non-MCP capability without writing a connector. [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md) says connectors are MCP configuration; a Skill is the other route — the shell plus a written procedure — chosen deliberately where standing up an MCP server is not worth it.

**Blocked by:** 07 — The Vault

**Status:** ready-for-agent, *after the verification block below*

## The hard part: "the wrapper refuses agent writes" is not a soft check

[ADR-0004 as amended](../../../docs/adr/0004-root-note-is-links-only.md) makes Skills human-authored only. The Root note's constraint is enforceable at *injection* — the wrapper reads it and drops non-link lines, so a compromised writer cannot bypass it. **Skills have no equivalent chokepoint**: they are traversed on demand from the filesystem, not injected, and the agent runs under `workspace-write` with the Vault in its workspace. A wrapper-side "don't write here" rule is advice to the thing you are defending against.

**Therefore the constraint must be filesystem-level: Skills live outside the sandbox's writable root, readable but not writable.** The Codex research established that the sandbox permits broad filesystem *reads*; writes are confined to the workspace. Skills placed outside it are then readable by the coworker, editable by the human in Obsidian, and structurally beyond the agent's reach — which is the same shape of guarantee the Root note gets, arrived at differently.

Do **not** implement this as a post-Job hash check and revert. That is detection after execution was already possible, and it is the reasoning [ticket 10](../issues/10-memory-poisoning.md) rejected when it rejected quarantine.

## Verify first

- [x] **That `workspace-write` actually denies writes outside the workspace root.** Broad *read* access is documented; the write boundary is the load-bearing assumption here and has not been measured. [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) already carries an adjacent unverified assumption about what the sandbox exposes — do not add a second one. Test it: a Job instructed to write to the Skills path must fail. — **It does, at two layers.** See [the measurement](#the-measurement-and-the-trap-that-nearly-invalidated-it).
- [x] **That the coworker can still read them.** A boundary that blocks reads too makes Skills useless. — **Reads are unrestricted.** `sed` on a Skill outside every writable root returns its contents.
- [x] **Whether the path survives Obsidian.** Skills should be openable and editable in the same vault a human already uses, or they will not be maintained. — **Yes, but it forced the layout**: Notes and Skills are siblings under one Obsidian root rather than one directory. A read-only subtree of a writable root is not expressible, so the writable grant had to move down a level.

## Acceptance criteria

- [x] Skills live at a configured location that is **readable but not writable** by the sandboxed engine, verified by a test in which a Job attempts to write there and fails
- [x] A Skill is an ordinary Markdown Note in form — a human edits it in Obsidian, no bespoke format
- [x] Skills are discoverable: the Root note may link to them, which its links-only grammar already permits, and the coworker reaches them by traversal like any other Note
- [x] A Skill **names an environment variable; it never contains a credential**. The value lives in the sandbox environment. Documented at the Skill location itself, so the next person writing one sees the rule
- [x] The Librarian is told, in `AGENTS.md`, that it cannot write Skills — so a Job that discovers a procedure is wrong **says so in the Thread** and may write an ordinary Note about it, instead of silently failing to persist a fix
- [x] The first Skill is the read-only database case, end to end: a person asks a question in Slack, the coworker finds the Skill, runs the query in the sandbox, and answers in the Thread — **partial, and knowingly so.** Shipped as `assets/skills/Database access.md`, and the mechanism is pinned against a real engine — but no single run spans Slack-to-Thread against a live database. Two substitutions, named in [the substitutions on "end to end"](#the-substitutions-on-end-to-end-stated-exactly).
- [x] Documentation states that a resource reached by Skill is **outside layer 2** — the deny-list covers the MCP tool path, not the shell — so the credential is the whole boundary and must be genuinely scoped. A read-only database role is a requirement, not a recommendation
- [x] Tests cover: a Job reading a Skill and acting on it; a Job failing to write to the Skills path; and a Skill containing a literal secret being flagged by preflight

## Notes

**Skills are not memory.** A Skill is a standing procedure a human maintains. What the coworker learns by *using* one is an ordinary Note, written by the Librarian in the normal way. Keeping these separate is what makes the authorship rule enforceable — if the coworker needed to append to Skills to do its job, the constraint would be relitigated within a week.

**This does not reopen [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md).**
A Skill is not a connector: it has no MCP tool surface or connector lifecycle. It is a
written procedure plus the shell, reserved for capabilities without a suitable MCP server.

## Comments

### The measurement, and the trap that nearly invalidated it

**The boundary holds, and it is the kernel rather than the agent's own tooling.** A Job handed its workspace plus a Notes directory, told to edit a Skill sitting outside both, is refused twice over — measured against Codex 0.145.0:

- the file-editing tool answers `patch rejected: writing outside of the project`;
- the shell answers `zsh:1: operation not permitted` with **exit 1**.

The second one is the one worth having. The first is Codex declining; the second is Seatbelt refusing, which is not something a prompt injection can talk its way past. Reads are unrestricted, so the Skill is still followable. Pinned by a contract test that asserts on **the file's bytes afterwards** rather than on what the model said happened to it, and that also writes to the granted sibling in the same run — so a configuration that had broken *every* write would fail the test rather than pass it.

**The first run of the probe reported that no boundary existed at all, and the reason is a trap worth more than the finding.** `workspace-write` grants `$TMPDIR` and `/tmp` **unconditionally**, whatever is on the writable list. The probe had been sited in `os.tmpdir()` like every other temporary directory in this codebase, so everything it created was already inside a writable root and both write attempts succeeded with exit 0. Three consequences, and none of them is cosmetic:

- **A temporary Skills location is a fatal configuration**, not a warning. It is indistinguishable from a correct one at startup and voids the authorship rule entirely, so `preflight` refuses to run.
- **The test harness moved out of `$TMPDIR`** to a repo-local `.test-tmp/`, because a harness in a temp directory would have to either skip that check or fail it, and both mean testing an instance nobody runs.
- **An existing contract test was quietly asserting nothing.** "Writes into the Vault outside its workspace" sited its Vault in `os.tmpdir()`, so the write it verified would have succeeded on the temp-directory grant whether `additionalDirectories` worked or not. Moved, and it still passes — but it has only been a real test of that mechanism since this ticket.

### Obsidian forced the layout, and the layout is the mechanism

The ticket assumed Skills could live "outside the writable root" and be done. What it did not anticipate is that **the sandbox grants by directory tree and there is no way to carve a read-only hole out of a writable one.** Since the Vault directory is handed to the engine as writable so the coworker can file Notes, `<vault>/Skills` is writable by construction — the obvious layout is the one that cannot work.

So the writable grant moved down a level:

```
vault/          ← the Obsidian vault, what a human opens
  Notes/        ← config.vaultDir, granted to the engine
  Skills/       ← config.skillsDir, granted to nothing
```

This is what satisfies the third verify item rather than a compromise on it: both halves are in **one** Obsidian vault, so `[[Database access]]` resolves from a Note to a Skill and the Root note's links-only grammar reaches Skills with no change. The cost is a migration — `vaultDir` now names a subdirectory of the vault rather than the vault — and `SKILLS_DIR` defaults to *the sibling of wherever `VAULT_DIR` points* rather than to a fixed path, so moving one does not silently leave the coworker reading an empty directory while the real Skills sit unread.

### Two decisions the ticket did not ask for

**Startup refuses a broken layout; it only warns about a leaked credential.** The asymmetry is deliberate and it is about whose failure it is. A Skills directory the engine can write to means *the project* is not delivering the guarantee its own documentation describes, and the failure is invisible — everything runs, and the constraint everybody believes is holding is not. Nobody can consent to that on a warning they scrolled past, so it throws, naming every problem at once. A credential written into a Skill is ours, in our Vault: saying so plainly is right, and refusing to start over a regex with false positives is not. The scan is described in the code as **a lint, not a boundary** — it matches known shapes, so it catches the accident and would not catch determination, and the thing that actually keeps credentials out is that a scoped credential is the whole boundary here.

**The coworker is told the directory is read-only, and told what to do instead.** Not as reassurance — the sandbox does not care what it believes — but because the failure mode of silence is a Job spending a Turn failing to save an edit and reporting *that* as the work. Both the prompt and the operating manual now say: report the drift in the Thread, write an ordinary Note about it, and do not work around it silently, because "the documented way is broken" is the interesting half of the answer.

### The substitutions on "end to end", stated exactly

The read-only database Skill ships (`assets/skills/Database access.md`) and the *mechanism* is pinned against a real `codex exec`: a contract test builds the Skills section **with the wrapper's own `skillsForPrompt`** rather than hand-written wording, and asserts the coworker found the Skill, read the environment variable the Skill named rather than guessing a path, and **applied a domain rule that only the Skill knew** — the answer is 84 rather than 7, which is unreachable without having read and followed the file.

The criterion says "a person asks a question in Slack … and answers in the Thread", and **no single run spans that.** Two substitutions, both deliberate:

- **No live database.** The procedure under test reads a file rather than a replica, because this instance has no database. What differs is the credential and the command, not the mechanism.
- **No Slack leg in the same run.** The contract test drives the engine directly; the mention-in-answer-out path is covered at the top seam against `FakeEngine`. The two halves meet at `skillsForPrompt`, which is why the contract test was changed to use it — a test composing its own wording would have measured whether *some* prompt gets a Skill followed rather than whether the one the wrapper sends does.

The database Skill's *content* is example prose adapted from plausible traps (replica lag,
minor units, soft deletes) and has never met a real schema. It is also **not installed
anywhere** — `assets/skills/` is a directory to copy into our configured Skills directory.
Preflight's "none yet" message names `assets/skills` for that reason.
