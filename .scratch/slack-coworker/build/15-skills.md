# 15 — Skills: human-authored procedures the coworker can follow

**What to build:** A place a human writes down *how to do something* — reach the read-only analytics database, pull the weekly export, run the reconciliation — that the coworker can find and follow, and that the coworker **cannot edit**. The first real Skill is database access: it names a connection environment variable and the shape of a query, and the coworker works out the rest.

Skills are how this project gets non-MCP capability without writing a connector. [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md) says connectors are MCP configuration; a Skill is the other route — the shell plus a written procedure — chosen deliberately where standing up an MCP server is not worth it.

**This ticket moved onto the critical path.** [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) made GitHub a Skill, so [build/09](09-github-connector.md) cannot start until the mechanism here exists. Skills are no longer the escape hatch for odd cases — they carry one of the project's two headline connectors, and the read-but-not-write guarantee below is what keeps a "do not merge" instruction from being editable by the thing it constrains.

**Blocked by:** 07 — The Vault
**Blocks:** 09 — GitHub as a Skill over `gh`

**Status:** ready-for-agent, *after the verification block below*

## The hard part: "the wrapper refuses agent writes" is not a soft check

[ADR-0004 as amended](../../../docs/adr/0004-root-note-is-links-only.md) makes Skills human-authored only. The Root note's constraint is enforceable at *injection* — the wrapper reads it and drops non-link lines, so a compromised writer cannot bypass it. **Skills have no equivalent chokepoint**: they are traversed on demand from the filesystem, not injected, and the agent runs under `workspace-write` with the Vault in its workspace. A wrapper-side "don't write here" rule is advice to the thing you are defending against.

**Therefore the constraint must be filesystem-level: Skills live outside the sandbox's writable root, readable but not writable.** The Codex research established that the sandbox permits broad filesystem *reads*; writes are confined to the workspace. Skills placed outside it are then readable by the coworker, editable by the human in Obsidian, and structurally beyond the agent's reach — which is the same shape of guarantee the Root note gets, arrived at differently.

Do **not** implement this as a post-Job hash check and revert. That is detection after execution was already possible, and it is the reasoning [ticket 10](../issues/10-memory-poisoning.md) rejected when it rejected quarantine.

## Verify first

- **That `workspace-write` actually denies writes outside the workspace root.** Broad *read* access is documented; the write boundary is the load-bearing assumption here and has not been measured. [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) already carries an adjacent unverified assumption about what the sandbox exposes — do not add a second one. Test it: a Job instructed to write to the Skills path must fail.
- **That the coworker can still read them.** A boundary that blocks reads too makes Skills useless.
- **Whether the path survives Obsidian.** Skills should be openable and editable in the same vault a human already uses, or they will not be maintained.

## Acceptance criteria

- [ ] Skills live at a configured location that is **readable but not writable** by the sandboxed engine, verified by a test in which a Job attempts to write there and fails
- [ ] A Skill is an ordinary Markdown Note in form — a human edits it in Obsidian, no bespoke format
- [ ] Skills are discoverable: the Root note may link to them, which its links-only grammar already permits, and the coworker reaches them by traversal like any other Note
- [ ] A Skill **names an environment variable; it never contains a credential**. The value lives in the sandbox environment. Documented at the Skill location itself, so the next person writing one sees the rule
- [ ] The Librarian is told, in `AGENTS.md`, that it cannot write Skills — so a Job that discovers a procedure is wrong **says so in the Thread** and may write an ordinary Note about it, instead of silently failing to persist a fix
- [ ] The first Skill is the read-only database case, end to end: a person asks a question in Slack, the coworker finds the Skill, runs the query in the sandbox, and answers in the Thread
- [ ] Documentation states that a resource reached by Skill is **outside layer 2** — the deny-list and inventory pin cover the MCP tool path, not the shell — so the credential is the whole boundary and must be genuinely scoped. A read-only database role is a requirement, not a recommendation
- [ ] Tests cover: a Job reading a Skill and acting on it; a Job failing to write to the Skills path; and a Skill containing a literal secret being flagged by whatever check the setup story ships, if any

## Notes

**Skills are not memory.** A Skill is a standing procedure a human maintains. What the coworker learns by *using* one is an ordinary Note, written by the Librarian in the normal way. Keeping these separate is what makes the authorship rule enforceable — if the coworker needed to append to Skills to do its job, the constraint would be relitigated within a week.

~~**This does not reopen [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md).**~~ **It did, and [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) is the amendment.** The original note said a Skill is not a connector — no tool surface, no inventory to pin, no normalisation — and then GitHub became one anyway, because repository selection could not be expressed inside the MCP shape. The mechanical description still holds: a Skill is a written procedure plus the shell. What was wrong was the conclusion that this keeps Skills and connectors in separate categories. The project now has two connector routes, and the choice between them turns on whether the boundary needs to live in the credential (Skill) or in the tool surface (MCP).
