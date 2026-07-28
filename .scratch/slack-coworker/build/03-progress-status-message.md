# 03 — Progress: the status message

**What to build:** A person delegates a long task and walks away. When they glance back at the Thread, one message tells them what the coworker is doing and how far through it is — updated in place, not buried under a wall of narration. A ten-minute silent test run still looks alive rather than hung.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [x] One status message is posted when a Job starts and edited in place thereafter; a Job never produces a second progress message
- [x] Its content is driven by the engine's todo list, showing the coworker's own plan and which step it is on
- [x] It is refreshed on a time-driven cadence inside Slack's two-minute status timeout, even when the engine has emitted nothing — long-running commands are silent until they complete, and silence must not read as a crash
- [x] The status message is visually distinct from the coworker's final answer, so the Thread stays skimmable afterwards
- [x] Individual tool calls are not narrated into the channel
- [x] The status message stops updating and settles into a final state when the Job ends
- [x] Editing in place is used rather than posting, in line with Slack's rate limits

## Comments

**Implemented 2026-07-28.** All seven criteria are green: `pnpm test` (41 tests at the top
seam, 14 of them new), `pnpm typecheck`, and `pnpm test:contract` (6 tests against a real
`codex exec` 0.145.0, 1 of them new) all pass.

`Status:` stays `ready-for-agent`, as on build/01 and build/02 — the five canonical labels
in `docs/agents/triage-labels.md` have no completed state, so the checkboxes and this
section are what record that the work landed.

How it landed:

- **The acknowledgement *is* the status message.** "One status message posted when a Job
  starts" and "acknowledged within a couple of seconds" turned out to be the same message
  in two states, so `handleMention` posts it and everything after is `chat.update`. The
  alternative — an "on it" message plus a separate progress message — is the second
  message the ticket forbids, arrived at by a different route.
- **The Reporter polls; it does not write on events.** Writing on each engine event was
  the obvious implementation and it is a rate-limit hazard: `chat.update` is Tier 3 —
  50+/minute — and a Job revising its todo list in a tight loop would spend that alone.
  Instead `observe` only assigns to memory, and a 5-second poll writes when the content
  changed or 45 seconds have passed. That caps one Job at 12 writes a minute, and the cost
  is at most 5 seconds of latency on a plan change. There is a test asserting a
  200-revision plan burst produces at most two edits.
- **That cap is per Job and the tier is per workspace, which is not the same thing** —
  caught in review, and worth stating plainly rather than leaving the comment claiming a
  guarantee it does not have. Jobs in different Threads run concurrently and nothing here
  bounds how many, so the instance-wide exposure is 12/minute times however many Jobs are
  churning. In practice a plan changes every few tens of seconds rather than every five, so
  the steady state is close to the heartbeat alone and it takes many simultaneously chatty
  Jobs to breach 50. What was added is not a guarantee but survivability: **a refused write
  puts the message on a 60-second backoff** rather than retrying on the ordinary heartbeat,
  and Slack's *indicator* keeps beating through it — different method, far larger
  allowance, and it is the thing that tells the human the Job is alive. `Retry-After` is
  deliberately not read: the seam carries an opaque failure, and widening it to carry an
  HTTP header would put the Reporter in the business of knowing about HTTP. **How many Jobs
  may run at once is [build/05](05-bounds-and-failure.md)'s question**, and it is the real
  answer to this.
- **Two things are refreshed on that beat, and only one of them is ours.** The status
  message is the record; `assistant.threads.setStatus` is the native indicator, and *it*
  is what actually expires — Slack removes it two minutes after the last call, which is
  the number `SLACK_STATUS_TIMEOUT_MS` exists to let a test assert against rather than
  against our own 45-second cadence. It needs nothing beyond `chat:write` since the
  2026-03-05 scope change, so no manifest change is owed. Failure to set it is warned
  about and endured.
- **`Clock` grew a `every(intervalMs, tick)`.** A time-driven refresh is a behaviour a
  test has to drive rather than wait for, so the timer had to come through the same seam
  as `now()`. `FakeClock.advance(ms)` runs and *awaits* everything that comes due, which
  is what makes "ten silent minutes passed" a line in a test.
- **Nothing is narrated.** Commands, file changes and tool calls fold into one "right now"
  line inside the status message — concrete progress (story 15) without a message per tool
  call (story 16). Model-authored text is escaped for mrkdwn and truncated on the way in: a
  plan step is model output, and `<`, `>` and `&` arrive in commands routinely.
- **Reasoning summaries and web searches were in that line and have been taken out**, on
  the review's challenge, and it was right. A reasoning summary is the coworker's private
  working rendered into a channel where colleagues who did not ask the question are reading
  — against Slack's own "in channels, be audience-aware" guidance, and beyond story 15,
  which names running a command, calling a tool, and editing a file. What it is *thinking*
  shows up as the plan, which is written for that audience. The web search had a separate
  defect: the adapter only emits one on completion, so there is no in-progress event to
  clear it and it would sit there claiming to be happening — a concrete "right now"
  inverted into a stale one, which is worse than the spinner it replaced. The line now
  means exactly one thing: what is running, or nothing.
- **Progress never fails a Job.** Every Slack call the Reporter makes is caught, and it
  complains once per Job rather than every 45 seconds — an hour-long Job against a Slack
  outage would otherwise bury whatever else went wrong. **Once per *kind*, though, which
  was a review finding and a real bug:** one flag for all of them meant that on a workspace
  whose Slack app predates the 2026-03-05 scope change, `setStatus` failed on the very
  first call and spent the single warning before any work started — after which every
  failure to write the status message, the one that matters, went unlogged for the life of
  the Job. Writes are also chained rather than concurrent, because two overlapping
  `chat.update`s can land out of order and the one that must land last is the final state.
- **The `todo_list` claim is now measured, not assumed.** Criterion 2 rests on `exec`
  emitting a plan *and revising it mid-Turn*; a fake cannot honestly assert either, so
  there is a new contract test. Against 0.145.0 both hold, and so does `in-progress`
  arriving before a command completes — without that last one the status could only ever
  report what the coworker had already finished.
- **The operating manual now asks for a plan on anything multi-step**, because the wrapper
  cannot make the engine produce a todo list and a status message with nothing to show is
  the failure mode. Declared as what it is: a nudge, not a mechanism.
- **`CONTEXT.md` gained *Progress*.** Issue 08 settled that progress and audit are two
  channels with opposite semantics, but only one of them — [Write](../../../CONTEXT.md) —
  had a word. Naming the other is what makes build/04's constraint sayable in one line:
  Progress is revised and gets overwritten, a Write never is, and the two must not share a
  message. No implementation detail went in with it.

**Verified by hand in a real workspace 2026-07-29.** The status message behaves as written
against real Slack, so `chat.update` and `assistant.threads.setStatus` are no longer taken
on the research's word — which was the last thing here resting on documentation rather than
observation. The cadence, the edit-in-place and the settle were already verified against a
fake Slack driven by a fake clock; that is the part that could have been wrong logically,
and this is the part that could have been wrong about Slack.

**Still unexercised:** the backoff path, because it needs Slack to actually return a `429`.
It is covered at the top seam with a refusal injected, which is as close as a test gets
without provoking a real rate limit.

### Left for later tickets, deliberately

- **A Job whose process dies leaves its status message reading "On it" forever.** Nothing
  outlives the process to settle it. That is the same class of problem as the
  interrupted-Turn warning, and **[build/05](05-bounds-and-failure.md)** owns failure.
- **"Stopped" does not yet say *why*.** The settled headline distinguishes finished from
  stopped, which is criterion 6, but story 48 wants a bound named. Also build/05.
- **A queued follow-up mention has no status of its own** — build/06 owns queueing, and
  what a second mention does to the first Job's status message is its question.
