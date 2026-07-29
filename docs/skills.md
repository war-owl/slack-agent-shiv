# Skills

A Skill is a procedure a human wrote down for the coworker to follow: how to reach a
system, which command to run, how to read the result. It is an ordinary Markdown file in
the same vault as the Notes, edited in the same Obsidian.

Two things separate a Skill from a Note. A Note is *belief* — what the coworker thinks is
true. A Skill is *instruction* — it directs behaviour. And a Skill is **human-authored
only**: the coworker reads and follows it, and cannot write one.

Skills let the coworker use non-MCP capabilities through the shell. Connectors are MCP
servers named in `mcp.json`; GitHub, Linear, and third-party servers all use that one path
([ADR-0005](adr/0005-connectors-are-mcp-config.md)). See
[the security model](#the-security-model), which is the part of this document to read if
you only read one.

## Layout

```
<the directory you open in Obsidian>/
  Notes/     ← the coworker reads and writes these
  Skills/    ← the coworker reads these and cannot write them
```

Configured as `vault.notes` and `vault.skills` in `open-agent.config.json`
([docs/configuration.md](configuration.md)). Setting only `vault.notes` puts Skills next to
it automatically, because the sibling relationship is what the write boundary depends on.

**They have to be siblings, and the reason is mechanical.** The coworker's engine runs
under a sandbox that grants write access by directory tree: a Job may write its own
workspace plus whatever directories are explicitly added, and the Notes directory is one
of those. There is no way to carve a read-only hole out of a writable tree, so Skills
cannot be a subdirectory of the Notes — they have to be somewhere the grant does not
reach. Putting both under one parent is what keeps them in a single Obsidian vault, so
`[[Database access]]` resolves from a Note to a Skill and back.

Startup **refuses to run** if that arrangement is broken: Skills inside the Notes
directory, inside a Job workspace, the same directory as the Notes, or in a temporary
directory. Each of those makes Skills writable by the coworker, and an instance where
that is true is not the instance this document describes. It is fatal rather than a
warning because the failure is invisible — everything works, and the constraint everyone
believes is holding is not.

### The temporary-directory trap

`workspace-write` grants `$TMPDIR` and `/tmp` **unconditionally**, whatever is on the
writable list. A Skills directory in a temporary location is therefore writable by the
coworker no matter how it was configured.

This is worth knowing beyond the check that enforces it, because it is a trap for anyone
verifying sandbox behaviour by hand. The first run of this project's own verification
probe reported that the sandbox had no write boundary at all; it was sited in `$TMPDIR`.
Measure outside it, or you measure nothing.

## What the coworker is told

At the start of every Job: where the Skills directory is, the title and path of every
Skill in it, and that it is read-only. Not the contents — a Skill is read when it is
relevant, and preloading every procedure into every Job would put a database recipe in
front of a Job about a pull request and turn the directory into a second operating manual.

`README.md` is the one file excluded from that list. It is documentation for whoever writes
the next Skill, and a coworker told it is a procedure reads the instructions for authoring
Skills instead of the Skill it needed. The credential scan still covers it — a README's
examples are exactly where a real connection string gets pasted.

Discovery is otherwise the same as for Notes: agent-initiated traversal. A Skill linked
from the Root note is reachable from a cold start, which is why the Root's links-only
grammar permits it.

## The security model

**The mechanism is the sandbox, not a rule.** The Root note is also prompt rather than
data, and its constraint — links only — is enforced at *injection*, because the wrapper is
holding the file at a moment where it can strip what it does not want. Skills have no such
chokepoint: they are read from disk on demand, so there is no moment where the wrapper
could refuse a write. A wrapper-side "do not write here" rule would be advice to the thing
it is defending against. So the enforcement is that the directory is not on the writable
list, which is a fact about the kernel rather than about the agent's cooperation.

Measured against Codex 0.145.0, a Job told to edit a Skill is refused twice: the
file-editing tool answers `patch rejected: writing outside of the project`, and the shell
answers `operation not permitted` with exit 1. Reads succeed. A contract test pins both,
because it is the load-bearing fact and no fake can attest to it.

**Why authorship rather than review.** The coworker is its own Librarian, and the vault is
the only channel between otherwise-isolated Sessions. Left unconstrained, the chain is: a
Job reads a poisoned issue → edits a Skill → a later Job, in a different Thread, with a
different audience, runs the command. Escalating Skill diffs into the thread was
considered and rejected: that is detection after execution has already become possible.
See [ADR-0004](adr/0004-root-note-is-links-only.md).

### A resource reached by Skill is outside layer 2

This is the cost of the Skill route and it is not mitigated anywhere else.

The action boundary ([ADR-0002](adr/0002-unattended-action-boundary.md)) has three layers.
Layer 2 is the tool policy: a hand-curated exact-name deny-list over each MCP server's
tools. Inventories are allowed to evolve; known blocked tools are structurally unavailable.

**Layer 2 operates on the MCP tool path. A Skill drives the shell.** There is no
deny-list over `psql` and nothing between the coworker and any
command the Skill makes possible. So for anything reached this way:

> **The credential is the entire boundary.**

Which means it has to be scoped as though the coworker will one day run the worst command
the procedure makes reachable — because it acts unattended, cannot be asked to confirm,
and a prompt injection in the data it is reading is a thing that happens.

A read-only database role is a **requirement**, not a recommendation. A read-write role
nobody intends to write with is a read-write role. MCP connectors instead retain layer 2:
known irreversible tools are removed from the tool surface.

### Credentials

A Skill names an environment variable. It never contains a value.

The vault is human-readable by design, opens in Obsidian, and will plausibly be committed
to git — so a token in a Skill is a token in a repository. Startup scans the Skills for
known credential shapes (vendor token prefixes, a password inside a connection URL, a
private key header) and warns about what it finds.

That scan is a **lint, not a boundary**, and should not be described as one. It matches
shapes it has been taught, so it catches the accident and would not catch someone
determined, and it reads only the first 128 KiB of a file — saying so when that was not
all of it, because a clean bill of health on a file nobody finished reading is the one
result a lint must not quietly produce. It warns rather than refusing, which is the
opposite of how the layout check
behaves: a mis-sited Skills directory means the project is failing to deliver its own
guarantee, whereas a secret in a file is the self-hoster's credential in the
self-hoster's vault, and a regex with false positives should not stop their instance.

## When a Skill is wrong

The coworker will find out that a procedure has drifted, because systems change and
whoever wrote it moved on. It cannot fix the file. What it does instead:

- **Says so in the thread**, naming the Skill and what is actually true now.
- **May write an ordinary Note** about what it found, linked from the topic it concerns.
- **Does not work around it silently** — if it got the job done another way, that the
  documented way is broken is the interesting half of the answer.

Accepted cost, stated in ADR-0004: the coworker cannot improve its own Skills. A Skill
that is subtly wrong fails visibly, where one that is maliciously right does not.

## Starter Skills

`assets/skills/` holds a `README.md` explaining the rules to whoever writes the next
Skill, and `Database access.md` as a worked example of the read-only database case. Copy
the directory to your Skills location and delete what does not apply.
