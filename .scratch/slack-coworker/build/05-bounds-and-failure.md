# 05 — Bounds, hard-kill, and honest failure

**What to build:** Everything that happens when a Job does not simply succeed. A runaway Job stops on its own before it costs a weekend or a bill. A person can stop one deliberately. A Job that dies says what it got done, what it did not, and — plainly — that some of its side effects may already have landed. And when the coworker picks the Thread back up, it is told it was interrupted, so it checks before pushing a branch that already exists.

Codex supplies none of this: it reports usage after the fact and offers no ceiling, no max-Turns, and no kill switch. Every bound here is the wrapper's.

**Blocked by:** 02 — One Session per Thread

**Status:** ready-for-agent

- [x] A per-Turn wall-clock timeout hard-kills the subprocess when it expires
- [x] A maximum number of Turns per Job is enforced
- [x] A cumulative token budget per Job is accumulated from turn-completion usage and enforced
- [x] All three bounds are configurable, with defaults conservative enough that a runaway Job is an annoyance rather than a bill
- [x] Hitting a bound posts a message that clearly says the Job was **stopped**, names which bound stopped it, and cannot be mistaken for a completed result
- [x] A person can hard-stop a running Job from the Thread, and the subprocess actually dies
- [x] A Job that dies for any reason posts what completed, what did not, and that side effects may have partially landed
- [x] The Session survives a dead Job; the next mention resumes from the last completed Turn
- [x] Resuming after an interrupted Turn injects a warning telling the coworker the previous Turn may have partially completed and that it should verify state before repeating actions
- [x] An opt-in contract test confirms hard-kill terminates a real Codex process

## Comments

**Implemented 2026-07-29.** All ten criteria are green: `pnpm test` (81 tests at the top
seam, 24 of them new), `pnpm typecheck`, and `pnpm test:contract` (9 tests against a real
`codex exec` 0.145.0, 1 of them new) all pass.

`Status:` stays `ready-for-agent`, as on 01–04 — the five canonical labels in
`docs/agents/triage-labels.md` have no completed state, so the checkboxes and this section
are what record that the work landed.

**Read [the limit on what "stop" means](#the-limit-on-what-stop-means) before relying on
hard-stop.** It was measured, it is real, and it is the one thing here that behaves
differently from what the criterion sounds like it promises.

How it landed:

- **All four ways of stopping are one mechanism.** The three bounds and a person typing
  "stop" produce the same thing — a `StopReason` and an aborted signal — and the signal
  is what the engine's run was given, so aborting it kills the subprocess. Anything else
  would be four ways to *stop reading* a process that keeps going, which is not stopping.
  `jobs/bounds.ts` owns all of it; the Job runner asks it one question afterwards, "were
  you stopped, and why".
- **The default wall clock is an hour, and it is carrying more weight than it looks.**
  Under `exec` a Job is normally one Turn, so a per-Turn timeout is in practice the
  ceiling on a whole Job, and the product promise is work that takes "minutes or hours"
  — ten minutes would have been a wedge detector that killed real work. **But because
  usage arrives only at turn completion, the token budget cannot stop a Turn that is
  already spending — it can only refuse the next one — so for the normal one-Turn Job
  the wall clock is also the only bound on money.** An hour of unattended spend is a
  real exposure, it is not fixable from this side, and the honest response was to say so
  in `BOUND_DEFAULTS` and in the README rather than to let the two bounds appear to
  cover for each other. A first draft of these comments claimed they did; the code
  review caught it.
- **The wall clock is never stood down mid-Job, including at `turn-completed`.**
  Disarming there is the obvious move — nothing is running, so nothing is overdue — and
  it leaves an engine that finished its Turn and then never closed its stream bounded by
  nothing at all. Same wedge, different hat. A first version disarmed, and had a test
  asserting the hole was fine; both are now the other way round.
- **The token budget counts cached input, which over-counts against price on purpose.**
  Cached tokens cost about a tenth of fresh ones, so a budget that counts them stops
  earlier than a currency budget would. That is the safe direction, and the honest one:
  the instance does not know the price of the model it was pointed at, so it bounds
  volume and says so rather than implying it is counting money.
- **A budget overrun on the last Turn still reports the answer.** Usage arrives only at
  turn completion, so a single Turn can blow the budget having already produced a good
  answer. Throwing it away to report a clean "stopped" would be losing work to tidiness;
  the report carries both, and the stop line is what says there will be no more.
- **Max-Turns counts the engine's `turn-started` events, not the wrapper's calls.** A
  Turn is the engine's unit — CONTEXT.md is explicit that it is imposed rather than
  chosen — so the count that means anything is the one it announces. It also means the
  cap already covers the shapes that do not exist yet: the Librarian's second Turn
  (build/07) and anything build/06's queue drives.
- **Hard-stop is a mention whose whole content is the word.** `app_mention` is the only
  entry point this system has — slash commands are barred from threads — and build/06
  settles that a mid-Job mention *queues*, so "stop, wrong repo" is a correction and
  cannot also be the kill switch. The line is drawn at "the message says nothing but
  stop", because the two mistakes are not symmetrical: mis-reading a correction as a
  stop throws away an hour of work, and mis-reading a stop as a correction costs one
  queued message and someone typing "stop" again.
- **The report is a module because a dying Job has three things to say and the third is
  the one that gets dropped.** That it stopped, how far it got, and — the one a failure
  message usually omits — that its side effects stand. A Job that died after pushing a
  branch has changed the world, and "something went wrong" invites the human to ask
  again and get a duplicate. "How far it got" is rendered from the engine's own plan,
  which is the only account of intent the wrapper has; the operating manual now says so,
  because a plan that is kept current is what makes that section worth reading.
- **The no-Writes case is deliberately not an all-clear.** Build/04 left a known hole —
  shell-shaped Writes the classifier does not recognise — so "I recorded nothing" is a
  weaker claim than "nothing happened", and the report says the weaker one.
- **The interrupted flag is durable state, which meant a second field and a version
  bump.** Whether the last Turn completed cannot live in memory: the case that most
  needs the warning is the process dying. So the Session store's value became
  `{ id, interrupted }` at `version: 2`, written on the transitions only. A version-1
  file is refused rather than migrated — there is no released version to have written
  one, and refusing is the same posture the store already takes for every other shape it
  does not recognise. The lifecycle lives in `jobs/interruption.ts` behind the same
  `observe(event)` seam the Reporter's two channels and the bounds use, with one
  deliberate difference: its `observe` is awaited, because a flag that had not reached
  disk before the process died would fail in exactly the case it exists for.
- **"Interrupted" is defined as the absence of `turn-completed`**, which is why the fake
  engine now appends one when a script runs to its end. That definition falls out right
  in every case that matters: a bound, a stop, a crash, and a `turn-failed` all leave it
  set, and only a Turn the engine said it finished clears it. Getting it from the
  positive side — "did we see an error?" — would have missed the process dying, which is
  the case it exists for.

### The limit on what "stop" means

**A shell command Codex had already launched outlives the kill.** Measured, twice, and
now pinned by the contract test: the SDK's abort kills the process it spawned, that
process is not a process-group leader, and a `sleep 120` further down the tree is
reparented to init and keeps going. Codex's own direct child does die — it is the leaf
that is orphaned.

Two things follow, and only one of them is a problem:

- **Spend is genuinely bounded.** The model is called by the process that just died.
  An orphaned `sleep` costs nothing, and neither does an orphaned `curl`.
- **Side effects are not.** A command mid-flight when the stop lands may still complete.
  This is the same thing the Job's own report already tells the human — stopping unwinds
  nothing, and something in flight may land anyway — so it is a limit the product
  already describes rather than a new one. But "the subprocess actually dies" is true of
  the engine and not of everything the engine started, and that distinction should not
  be lost.

The fix would be spawning into a new process group and killing the group, which the SDK
does not expose (`codexPathOverride` plus a `setsid` shim is the only route, and it is
not worth a platform-specific launcher in v1). The contract test asserts the leak as
measured, in the same style as build/02's session-storage test: **if it starts failing,
that is good news** — upstream began killing the group.

**One pre-existing contract test flaked once in three full runs** — build/04's
"recognises a Write in a command the way the engine really reports it", which drives a
real agent through a real `git push`. It passed on its own and on both later full runs.
Nothing here touches it; it is inherent to asserting on what a model chose to do, and
build/04 already notes that the coworker retries. Worth knowing because this suite is
described as the safety net against an upstream alpha, and a net that cries wolf gets
ignored — if it recurs, the assertion to soften is the one that expects the push to have
happened at all.

### Left for later tickets, deliberately

- **Nothing bounds how many Jobs run at once.** Each Job is bounded; the instance is
  not. Ten Threads mentioning the coworker at the same time is ten subprocesses and ten
  budgets. `status.ts` already flags the Slack-rate-limit half of this. It needs a home,
  and build/06 — which is where per-Thread sequencing arrives — is the natural one.
- **The stop vocabulary is not in the setup guide.** "Say `@coworker stop` and nothing
  else" is a thing a self-hoster has to be told, and build/13 is where telling them
  happens.
- **A queued mention arriving during a stopped Job** is build/06's, and the running-Job
  index this ticket added is the same index its queue will need.
