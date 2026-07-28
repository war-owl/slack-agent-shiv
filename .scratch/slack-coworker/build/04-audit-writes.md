# 04 — Audit: every Write appended

**What to build:** The coworker acts unattended, so the Thread is the only accountability record anyone ever sees. Every Write it makes against something outside itself lands in the Thread as its own permanent message that nothing later can overwrite. A person scrolling back a week later can reconstruct exactly what it did.

This is deliberately built before the connectors, so that no connector ever ships without a record of what it did. It is demoable now against local file and command Writes.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [x] Every Write is appended as its own new message in the Thread
- [x] A Write record is never edited after it is posted
- [x] Each record names the thing that was written and links to it wherever a link exists
- [x] Progress updates never touch a Write record — the two channels have opposite semantics and must not share a message
- [x] Records appear in the order the Writes happened
- [x] Verified end to end with local file and command Writes, before any MCP connector exists
- [x] The reporting path is shaped so that connector Writes flow through it unchanged when they arrive

## Comments

**Implemented 2026-07-29.** All seven criteria are green: `pnpm test` (56 tests at the top
seam, 12 of them new), `pnpm typecheck`, and `pnpm test:contract` (8 tests against a real
`codex exec` 0.145.0, 2 of them new) all pass.

`Status:` stays `ready-for-agent`, as on 01–03 — the five canonical labels in
`docs/agents/triage-labels.md` have no completed state, so the checkboxes and this section
are what record that the work landed.

**"Every" is bounded by what the event stream reveals, and the bound is real.** Read
[the gap](#the-gap-shell-writes-the-wrapper-cannot-see) before relying on this as a
complete account; it is the one thing here that a later ticket has to finish.

How it landed:

- **A second module in the Reporter, not a second mode of the first.** `reporter/audit.ts`
  sits beside `reporter/status.ts` and they share only the mrkdwn helpers (now extracted).
  Both consume the same engine events and do opposite things with them: one revises a
  single message, the other appends messages that nothing ever touches again. Ticket 08
  settled that these are two channels; making them one object with a mode would be how
  the audit record gets overwritten by a plan revision one refactor from now.
- **What counts as a Write, in three tiers of how well it is known.** A **file change**
  outside the Job's workspace is known exactly — the workspace is the coworker's own desk,
  and `CONTEXT.md`'s *Write* entry gained a paragraph saying so, because "outside itself"
  had to be decided before it could be implemented. An **MCP tool call** is known from
  configuration: each connector names its own `writeTools`, which is the only option when
  ADR-0005 keeps the wrapper out of the tool path. A **shell command** is *guessed* from a
  small table of patterns, and that is the weak point.
- **The engine was measured before the guessing was designed, and it changed two
  decisions.** A shell call is reported as
  `/bin/zsh -lc "git add -- README.md && git commit -m 'x' && git push -u origin main"`.
  So: (1) patterns cannot be anchored at the start of the string or after a separator —
  the interesting program sits behind a quote — which is why the anchor is loose enough to
  record `echo 'do not git push yet'` as a push; and (2) one command item is a whole
  script, so **every** matching rule records rather than the first, or a chain that pushed
  *and* opened a pull request would have lost the pull request.
- **Over-recording is the right way to be wrong here.** A spurious record is visible and a
  reader can dismiss it. A missing one is a silent hole in the only account there is of
  what the coworker did while nobody was watching.
- **`Write.failure` is a phrase rather than a flag, and the contract test is why.** The
  first version said "the attempt failed" whenever a command exited non-zero. Against a
  real engine pushing to a real repository, the push demonstrably worked — the bare repo
  moved — and came back inside a chain that ended non-zero, so the record would have
  carried a false statement in the one message that exists to be true. A command's exit
  code says *the script* failed and not which part of it did, so that is what the record
  says; a refused MCP tool call, which answers for exactly one call, still says plainly
  that it did not happen. The contract test now asserts nothing about the outcome, and
  says why.
- **Linking the thing that was written needed the tool result**, so `EngineEvent`'s
  `tool-call` grew `result` and the adapter flattens the MCP text blocks into it. The
  identifier of a freshly-created ticket exists nowhere else — the arguments say what was
  asked for, only the result says what came into being. Three details, each a bug found by
  looking at real payloads: `html_url` is preferred over `url` **by name, one key at a
  time**, because GitHub answers with the API address first and taking the earliest match
  reliably picks the wrong one; a command's link is the **last** URL it printed, because
  `gh` prints warnings before the thing it made; and `git push` deliberately does not link
  at all, because GitHub's answer to a push is a "create a pull request" suggestion — a
  URL for something that was *not* written.
- **`writeTools` is required in configuration, not defaulted to empty.** Both reviews
  landed on this and they were right: a connector configured without a list would start
  fine and record nothing, which is the silent capability gain ADR-0002 exists to refuse.
  Preflight also warns when a named tool is not in the inventory it just probed — the cost
  of a typo there is silence, and silence is exactly what this ticket is against.
- **A record Slack refuses is not allowed to disappear.** It is logged in full — from the
  `Write`, not the rendered message, so nothing is truncated to fit a Slack line — counted,
  and the Job's own answer says how many are missing. It complains *every* time, unlike
  progress, which complains once per Job: a stale status message is a courtesy lost, where
  each missing record is a distinct hole. The Job still succeeds, because a Slack refusal
  does not undo work that already happened.
- **The operating manual now admits the limit to the model.** It said "everything you do
  out in the world is recorded in the thread", which was a promise the wrapper cannot keep
  for shell-shaped actions; it now asks the coworker to say in its answer what it did by
  running a command, and says that files in its own workspace need no mention.

### The gap: shell writes the wrapper cannot see

`cp note.md $VAULT/`, `echo … > $VAULT/note.md`, `sed -i`, `rm $VAULT/old.md` — all real
Writes to the human's own Vault, none recorded. The pattern table only recognises what it
was told to look for, and lengthening it does not fix the shape of the problem.

**Build/07 should close it, and needs to anyway.** Echoing a Note's diff into the Thread
requires knowing the Vault's contents before and after a Job, and a snapshot that can
produce a diff can also answer "did anything change that nothing recorded?" — which closes
this at the filesystem level rather than by guessing at command strings. That is a
stronger guarantee than this ticket could have built, and it is the reason not to invent a
second mechanism here.

### Left for later tickets, deliberately

- **A connector Write with no URL in its result names the tool, not the ticket.**
  "Wrote to linear · `save_comment`" is thin against story 19's "which pull request, which
  ticket, which comment". The SDK carries the call's `arguments` and they were deliberately
  not mined: the identifier's key differs per tool and per server, and **[build/09](09-github-connector.md)**
  and **[build/11](11-linear-connector.md)** are the tickets holding real payloads to
  check against. Guessing at JSON shapes nobody has seen is how a record ends up naming
  the wrong thing.
- **The rendering has not been seen in a real workspace.** The cadence and the permanence
  are covered against a fake Slack, and the classification against a real engine, but
  `<url|label>`, the `·` separators and `:receipt:` itself are unverified in a real client
  — the same last mile build/03 closed by hand.
- **Story 20's Note diffs** are build/07's, and they arrive through this same channel.
- **`status.ts`'s "Editing `path`" activity is unreachable**, found while working here and
  left alone as build/03's. The SDK's `PatchApplyStatus` is `completed | failed` with no
  in-progress variant, so the adapter can never report a file change as in flight and the
  branch that renders it never runs. Harmless — file changes are fast and the status has
  the plan to show — but it should be deleted or made honest rather than left looking live.
