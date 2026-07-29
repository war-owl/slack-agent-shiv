# 06 — Queue at the Turn boundary

**What to build:** A person adds "also check the staging config" while the coworker is already twenty minutes into a Job. The message is acknowledged straight away so it clearly landed, then delivered into the same Session once the current Turn finishes — no second Job racing the first, no lost message. Meanwhile a colleague in another channel delegates something entirely separate and it starts immediately.

**Blocked by:** 02 — One Session per Thread

**Status:** ready-for-agent

- [x] A mention arriving while a Job is running is acknowledged immediately, so silence never reads as the message being dropped
- [x] The queued mention is delivered into the same Session at the next Turn boundary
- [x] Two Jobs never run concurrently within one Thread
- [x] Jobs in different Threads run concurrently and do not block each other
- [x] Multiple mentions queued during one Job are delivered in the order they arrived
- [x] The accepted cost is documented in the Thread's behaviour: a correction like "stop, wrong repo" queues rather than interrupting, and hard-stop is the way to interrupt
- [x] *(inherited from build/05)* Something bounds how many Jobs run at once across the instance

## Comments

**Implemented 2026-07-29.** All seven criteria are green: `pnpm test` (97 tests at the top
seam, 16 of them new) and `pnpm typecheck` pass. Nothing here touches the engine's wire
format, so `pnpm test:contract` was not re-run.

`Status:` stays `ready-for-agent`, as on 01–05 — the five canonical labels in
`docs/agents/triage-labels.md` have no completed state, so the checkboxes and this section
are what record that the work landed.

How it landed:

- **The queue is a lane per Thread and a ceiling over all of them**, in
  `jobs/queue.ts`. A place is claimed **synchronously**, before anything is posted:
  "delivered in the order they arrived" is the promise, and a place taken after an
  `await` would be a place taken in the order Slack's replies came back. Everything else
  — the Session, the workspace, the bounds — is unchanged, because a queued mention is
  just the next ordinary Job in a Thread that already resumes one Session forever.
- **"At the next Turn boundary" is discharged by the next *Job*, not by a second Turn
  inside the running one.** Under `exec` a Job is normally one Turn, so a Job that ends
  *is* a Turn boundary, and CONTEXT.md already says a mid-Job mention is "queued for the
  next one". Injecting the text into the running Turn would have needed mid-turn
  steering, which ADR-0001 gave up.
- **The acknowledgement is one message per Job, whichever way the Job arrives.** A Job
  starting now gets its status message, which is also its acknowledgement (build/03). A
  Job that has to wait gets a receipt saying so, and when it finally starts, its status
  message **takes over that receipt** rather than posting a second message. That is
  Progress's own semantics — one thing per Job, revised — and the alternative leaves a
  stale "I'll get to this" sitting above a live status. The status message's elapsed
  clock starts at the work, not at the mention: how long it queued is not how long it
  took.
- **The receipt is where criterion 6 is discharged, and deliberately not only in the
  README.** It says the message landed, why nothing is happening, and *what to type if
  waiting is not what they wanted* — because the person who most needs to know that a
  correction queues is the person who just typed one, and they are looking at the Thread
  rather than at the docs.
- **Hard-stop empties the Thread's queue too, and says what it dropped.** Not in the
  ticket, and the alternative is worse: whatever is queued was almost always written
  about the work being abandoned, and a person who says stop and then watches the next
  queued Job start immediately has every reason to conclude that stopping does not work.
  Dropped messages are named in the reply — those are things a person sent that are now
  not going to be answered, and silently discarding them would be the same failure as
  silently queueing them. **Each dropped receipt is also rewritten in place**, because
  the reply says only *how many*, and a receipt left saying "I'll pick this up" is a
  message in the Thread that has quietly become untrue.
- **A queued Job is told it was queued.** One paragraph in the prompt, before the
  message: this arrived while you were still working, they wrote it before they saw your
  answer, so it may be a correction — and what you already did stands, so check before
  undoing it. Without it the coworker reads "actually, use the other repo" as a fresh
  request about work it considers finished. It is added **only for a Job that waited
  behind another Job in its own Thread** — a Job held up by the instance ceiling waited
  too, but nothing happened in its Thread meanwhile, and telling it otherwise would be
  telling it a false thing.
- **The instance ceiling is four, and Slack picked the number rather than the machine.**
  A Job's status message can be rewritten twelve times a minute and `chat.update` is
  Tier 3 — roughly fifty a minute, **per app, not per Job** — so four churning Jobs sit
  just inside the limit and five do not. `status.ts` had flagged exactly this arithmetic
  with nothing to bound the other half of it; now it has one. It is configurable, and
  the doc comment says plainly that raising it is what stops the arithmetic holding.
- **The code review found two ordering bugs, both of which are now closed and pinned by
  a test that fails against the old code.** They are worth reading as a pair, because
  they are the same mistake: *deciding something before an `await` and acting on it
  after*.
  - **The instance ceiling was read from a stale snapshot.** A slot was only counted
    when the Job was about to run, which is after the acknowledgement has round-tripped
    to Slack — so every mention arriving in the same tick saw an empty instance, was
    told "on it", and then sat silent behind a status message promising work. A slot is
    now **claimed synchronously in `join`**, by the same call that decides what the
    acknowledgement says. That also restores the arithmetic behind the number four: the
    thing bounded is now live status pollers, not just running engines.
  - **A stop could be lost in the moment a queued Job was promoted.** The queue stops
    treating a Job as droppable the instant it hands over the Thread, but the Job only
    registered itself as stoppable *after* awaiting the Slack edit that turns its
    receipt into a status message. A stop landing in that window was answered "nothing
    was running" while the Job it was aimed at carried on — the worst possible pairing,
    because the person now believes it has ended. The bounds are armed and indexed
    before `runJob` awaits anything at all.
- **Two of the sixteen tests are about the Thread never being left blocked**, because
  that is this feature's characteristic failure and it is silent: a Job that throws, and
  a mention whose acknowledgement Slack refused, both have to give their place back or
  the Thread stops answering forever. The second is the reason `Place` has an `abandon`
  as well as a `take`.
- **The wrapper's own copy moved out of the Job runner** into `jobs/replies.ts`, next to
  `jobs/report.ts`. The receipt and the stop reply are the two things the wrapper says
  in its own voice when the Job has nothing to say yet, and leaving them inline made
  `coworker.ts` a file that changes both when sequencing changes and when a sentence is
  reworded.
- **One existing test changed rather than being added to.** Build/05's "treats a
  correction that begins with stop as work" waited for the correction to reach the
  engine *while the first Job ran*, which is precisely what this ticket makes impossible.
  It now asserts the queueing behaviour instead, which is what that test was always
  about.

### Left for later tickets, deliberately

- **A queued mention does not survive a restart.** It lives in memory, and Slack has
  already been ack'd, so a process that dies with three mentions queued loses all three
  silently — where a *running* Job at least leaves an interrupted Session that the next
  mention is told about. Making the queue durable means the wrapper keeping a second
  kind of state, which the persistence question in the map has not settled; a smaller
  fix — saying "I had N messages queued" on the way back up — needs somewhere to say it.
- **The receipt can be momentarily wrong about why.** A slot may free between the
  receipt being composed and the message landing, so a Job can be told it is waiting and
  then start at once. Erring this way is deliberate — the alternative is telling
  something it is starting when it is not, which is the silence this ticket exists to
  remove.
- **Nothing tells a person how long the wait is likely to be.** The receipt says what is
  ahead, not when it will clear, because the wrapper has no idea how long a Job takes and
  an invented estimate is worse than none.
