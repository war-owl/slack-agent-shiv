# Skills

Procedures you write down for the coworker to follow. It reads them; it cannot write
them.

This directory is the read-only half of your vault. Your Notes sit beside it in
`../Notes`, and the coworker writes those freely — but everything here is yours alone,
enforced by the sandbox rather than by asking nicely. The coworker is told at the start
of every Job where this directory is and what is in it, and it reads the file that looks
relevant.

Copy this directory to your Skills location to get started. `Database access.md` is a
worked example; delete it if you have no database.

## Writing one

A Skill is an ordinary Markdown file. There is no format to learn, no frontmatter to
fill in, and no registry to add it to — drop a `.md` file in here and the next Job sees
it. Name the file for the thing it does, because the filename is the title the coworker
is shown and the target a `[[wikilink]]` resolves to.

Write it for a competent colleague who has never touched this system: what the thing is,
how to reach it, which command to run, what the output means, and what *not* to do. Say
the parts that are not guessable. Leave out the parts that are — the coworker can read
`--help`.

Link it from a Note so it is reachable by traversal. Your Root note is the front door,
and its grammar is a wikilink and a short label per line, so a line like
`[[Database access]] — the analytics replica` on the Root is how a Skill gets found from
a cold start.

## Two rules, and both of them matter

**A Skill names an environment variable. It never contains a credential.** Not the
password, not the token, not the private key — the name of the variable the value lives
in, and nothing more. This vault is human-readable by design, opens in Obsidian, and
will plausibly end up in git. Startup scans these files for anything shaped like a
leaked credential and warns about what it finds, but that is a lint over known shapes
and not a guarantee: it catches accidents, not determination.

**A resource reached by Skill has no safety net except its credential.** This is the
part worth reading twice. The coworker's other route to an outside system is an MCP
server, and that route has a tool-level deny-list and a pinned inventory — a structural
list of things it cannot do, checked at startup. A Skill drives the shell, and nothing
mediates the shell. There is no deny-list over `psql`. So for anything documented here,
**the credential is the entire boundary**, and it has to be scoped as though the coworker
will one day run the worst command the Skill makes possible, because it acts unattended
and cannot be asked to confirm.

In practice that means a read-only database role is a **requirement**, not a
recommendation. A read-write role that nobody intends to write with is a read-write role.

See `docs/skills.md` in the project for the reasoning, and ADR-0004 and ADR-0006 for the
decisions.

## What happens when a Skill is wrong

The coworker cannot fix it, deliberately — a Skill it could edit would be a way for
something it read in one thread to put a command in front of a Job in another thread.
What it does instead is tell you: it reports in the thread that the procedure has drifted
and what is actually true now, and it may write an ordinary Note about what it found.
The edit is yours.

That is the trade. A Skill that is subtly out of date fails visibly, which is better than
one that is maliciously up to date.
