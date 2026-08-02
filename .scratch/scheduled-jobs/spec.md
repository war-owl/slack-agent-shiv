# Spec: Time-based scheduled Jobs

Status: ready-for-agent

## Problem Statement

Open-agent only works when a person mentions it at the moment the work should begin. Teams
also have delegations whose timing is known in advance: a daily repository digest, a weekly
analysis, or a reminder at a particular time. Today a person must remember to make each of
those invocations manually.

The missing capability is not arbitrary cron or shell execution. It is the ability to tell
the coworker, in the same natural language used for an ordinary Slack delegation, to perform
an ordinary Job at a future time and report it where the team expects it.

## Solution

A person can create and manage a **Schedule** conversationally by mentioning the coworker in
Slack. A Schedule contains a natural-language task, a one-time or recurring calendar cadence,
a timezone, and a destination Slack channel. When it becomes due, its **Occurrence** creates
an ordinary Job with the same engine, capabilities, action boundary, bounds, reporting,
Vault access, and instance-wide concurrency limit as a manually invoked Job.

Each Occurrence announces itself as a new top-level message in the destination channel. The
Job's progress, permanent Write receipts, result files, failure report, and final answer live
in the Thread beneath that message. The final answer is not duplicated into the channel.

Schedules and their dispatch state survive process restarts. Occurrences missed while the
instance is offline are skipped. The scheduler never catches up missed work.

This feature deliberately adds time-based triggers only. It does not watch repositories,
Slack channels, webhooks, or external events.

## Domain Model

The canonical definitions of Schedule and Occurrence live in
[`CONTEXT.md`](../../CONTEXT.md).

- A **Schedule** is a durable standing delegation. It has an opaque public ID, creator,
  natural-language task, destination channel, timezone, timing rule, lifecycle state,
  creation time, and next due time.
- An **Occurrence** is one due time of a Schedule. At most one Job may be dispatched for a
  `(schedule ID, due time)` pair.
- A **Scheduled Job** is an ordinary Job whose request came from an Occurrence rather than
  an `app_mention` event. It is not a second kind of execution with different powers.
- A Schedule is either `active`, `paused`, or `deleted`. Deleted Schedules are absent from
  normal reads and never become due. Their historical Slack messages remain.
- An Occurrence reaches one of `running`, `succeeded`, `failed`, `timed-out`, or `skipped`.
  A skipped Occurrence records one of `offline` or `overlap` as its reason.

The persisted timezone is an IANA timezone identifier such as `Asia/Kolkata`, not a fixed
UTC offset. This preserves the creator's intended wall-clock time across daylight-saving
changes.

## User Experience

### Creating a Schedule

These are representative requests, not a command grammar:

- `@open-agent every weekday at 9 AM summarize new commits in org/repo and post in #engineering`
- `@open-agent remind us next Friday at 3 PM in #launch to check the release checklist`
- `@open-agent every Monday analyze open incidents and post the findings in #operations`

The agent interprets ordinary language. Users do not write cron expressions, JSON, or slash
commands.

A creation is incomplete until it has all of:

1. a natural-language task;
2. an unambiguous future time or recurring calendar rule;
3. a destination Slack channel; and
4. a timezone, either explicit or resolved from the creator's Slack profile.

If the destination is absent or ambiguous, the agent asks where to post and creates nothing.
If Slack supplies no usable timezone and the request does not state one, the agent asks for a
timezone and creates nothing. The follow-up occurs in the same Thread and Session, so the
user need not repeat the rest of the request.

Before persisting a Schedule, open-agent resolves the destination to a channel ID and proves
the bot can post a top-level message there. A name is display data only; durable routing uses
the channel ID. An inaccessible, archived, read-only, non-threadable, or ambiguous channel is
rejected without creating the Schedule.

On success, open-agent posts a human-readable confirmation in both:

- the Thread where the Schedule was requested; and
- the destination channel as a top-level team notification.

The destination notification contains the Schedule ID, creator, task, human-readable timing
rule, resolved timezone, destination, and next run. For example:

> Schedule 8 created by @shiv  
> Every weekday at 9:00 AM Asia/Kolkata  
> Task: Summarize new commits in `org/repo`  
> Results: #engineering  
> Next run: Monday, August 3 at 9:00 AM

An explicit timezone in the request wins. Otherwise the default is the creator's `tz` from
Slack's `users.info`. The resolved timezone is copied into the Schedule at creation; later
Slack profile changes do not silently move an existing Schedule. Reading it requires the
Slack bot scope `users:read`, which must be documented in setup and preflight.

### Timing rules

V1 accepts:

- one-time future instants, including times less than one day away;
- daily schedules at one time of day;
- selected days of the week at one time of day, including weekdays and weekly schedules;
- a day of the month at one time of day; and
- yearly calendar dates at one time of day.

Recurring Schedules may produce at most one Occurrence per local calendar day in their
stored timezone. Requests for hourly, sub-daily, multiple-times-per-day, or intervals shorter
than one day are rejected with an explanation. The system may use a cron library internally,
but cron syntax is neither its public input nor its durable domain representation.

For nonexistent local times during a daylight-saving jump, that day's Occurrence is skipped.
For repeated local times during a daylight-saving fallback, the first instant is used and
only one Occurrence is created.

### Running an Occurrence

At the due instant, open-agent atomically claims the Occurrence before posting or starting
work. It posts a top-level message in the destination channel identifying the Schedule,
task, due time, and creator. That message's timestamp creates the Thread for the Job.

The Scheduled Job then enters the existing queue. It consumes the same
`maxConcurrentJobs` capacity as manual Jobs. Its channel Thread receives the same status
updates, permanent Write receipts, result uploads, bounds reports, final report, and
Librarian pass as any other Job.

Each Occurrence gets a new Thread and therefore a new Session. Recurring Occurrences do not
resume the previous Occurrence's Session: doing so would make several Slack Threads share
one Session and violate the project's one-Thread/one-Session model. Cross-run knowledge is
available through the Vault, and the prompt identifies the Schedule and due time so a task
such as a digest can determine its reporting interval.

The Job request contains the Schedule's stored natural-language task verbatim, plus trusted
wrapper context naming its Schedule ID, scheduled due time, actual start time, timezone, and
the previous successfully completed Occurrence time when one exists. This allows “what is
new” tasks to use a stable interval without preserving a private conversation across Threads.

### Managing Schedules

The same conversational Slack surface supports:

- list all non-deleted Schedules;
- show one Schedule, including its next run and latest Occurrence;
- pause and resume;
- change the task, timing rule, timezone, or destination;
- delete;
- run now.

There is no ownership gate in v1. Any Slack user who can invoke the bot may inspect or mutate
any Schedule. Confirmations name the acting user so changes remain socially attributable.

Pause prevents future Occurrences and does not stop a running Job. Resume computes the first
future due time; it never catches up paused time. Delete prevents future Occurrences and does
not stop a running Job. Existing Slack history is never removed.

`Run now` creates a manual Occurrence with the current instant as its due time, subject to the
same overlap rule. It does not change the recurring rule or next scheduled time and is an
explicit exception to the once-per-calendar-day cadence restriction.

An update is validated completely before replacing the existing Schedule. Changing the
destination posts a change notification in both the old and new destination channels so the
team can follow where the automation moved. Other mutations are confirmed in the requesting
Thread; create and destination change are the only operations requiring unsolicited channel
notifications.

### Offline, overlap, and failure behavior

On startup, the scheduler computes the first due instant strictly after the current time for
every active Schedule. It does not dispatch an Occurrence whose due time passed while the
process was stopped. Skipped offline times do not each need Slack messages; startup logs one
summary count so long downtime cannot flood channels.

No two Jobs from the same Schedule run concurrently. If a Schedule becomes due while its
previous Job is still running, the new Occurrence is recorded as `skipped/overlap` and a
top-level notice is posted in the destination channel. The occurrence is not queued for
later, because stale scheduled work may duplicate writes or make a digest interval incorrect.

A failed or timed-out Job is reported through the existing Job failure path and is not
automatically retried. The next calendar Occurrence remains eligible to run. A failed run
does not become the “previous successfully completed Occurrence” passed to a later digest.

## Runtime Bounds

Scheduled Jobs use the same bounds as manual Jobs. To ensure daily Schedules cannot normally
overlap for an entire day, `turnTimeoutMs` becomes required instance behavior:

- its default is six hours (`21_600_000` ms);
- configuration may override it with a positive value strictly below 24 hours; and
- the same value applies to manual and Scheduled Jobs.

This changes the current behavior where `turnTimeoutMs` is optional and disabled by default.
`maxTurnsPerJob` and `tokenBudgetPerJob` remain optional. The configuration schema,
documentation, example configuration, startup report, and bound tests must be updated
together.

The existing implementation calls this a per-Turn timeout. A Job is normally one Turn. If a
Job uses multiple Turns, each Turn receives the same timeout; overlap protection still
exists independently and is the final defense against concurrent runs.

## Architecture

### One Job pipeline, two sources

Refactor the current mention-specific entry into a source-neutral Job request accepted by
the existing queue and runner. An `app_mention` and a claimed Occurrence adapt into that
request. Source-specific behavior—Slack event dedupe, creation of the Occurrence root
message, and schedule metadata—stays at the edge. Workspace preparation, Session handling,
prompt construction, reporting, bounds, Vault windows, the Librarian, and concurrency remain
one implementation.

The queue remains in memory. Durable Schedules and Occurrence claims make scheduler restart
behavior safe; a running Job cannot survive a process death, and the next startup records its
Occurrence as failed/interrupted rather than pretending it is still queued.

### Conversational control through a project-owned MCP server

Natural-language interpretation belongs to the agent; durable mutation and Slack validation
belong to the wrapper. Expose the following project-owned tools to every ordinary Job:

- `create_schedule`
- `list_schedules`
- `get_schedule`
- `update_schedule`
- `pause_schedule`
- `resume_schedule`
- `delete_schedule`
- `run_schedule_now`

The tools accept explicit structured fields. `create_schedule`, for example, accepts the
task, destination channel reference, timezone, and a structured timing rule. The tool—not
the model—enforces cadence, resolves and validates the channel, calculates the next run,
writes durable state, and posts required notifications. Tool results contain canonical
Schedule data for the agent's reply.

Codex `exec` does not support in-process dynamic tools, and ADR-0001 does not permit moving
this feature to experimental `app-server`. Therefore the wrapper hosts a small authenticated
MCP server on a loopback-only ephemeral port and injects it into the generated Codex MCP
configuration alongside operator-configured connectors. It is a system capability, not an
entry in `mcp.json`, and cannot be disabled without disabling scheduling.

Generate an unguessable bearer credential at process startup, expose it to child Codex
processes through a purpose-specific environment variable, and require it on every request.
The server binds only to loopback. The credential is never persisted or logged. The server
calls the in-process Schedule store and Slack client, which keeps validation and notification
behavior under the wrapper's existing test seams.

Schedule tools are management operations, not external connector Writes. Their user-visible
record is the explicit confirmation and team notification defined above; they must not also
produce generic MCP audit receipts that duplicate those messages.

The operating manual tells the agent when to use these tools, that it must ask for missing
destination or timezone information rather than guess, and that it must not claim a Schedule
exists until the tool succeeds. It does not impose a phrase grammar.

### Scheduler and clock

Add a scheduler service with a narrow clock/timer port. It keeps at most one timer armed for
the earliest next due instant, wakes, atomically claims all currently due Schedules, submits
their Jobs, recomputes next due times, and arms the next timer. It must tolerate wall-clock
jumps and timers with implementation-specific maximum delays by recomputing from the durable
store after every wake rather than trusting elapsed timer duration.

Dispatch is not blocked on Job completion. The scheduler submits into the shared Job queue
and records the running Occurrence; completion updates the durable occurrence outcome.

### Durable store

Keep the self-hoster deployment proportional: use an atomically replaced JSON store in
`stateDir`, serialized through one writer in the same style as the Session store. The store
contains a schema version, Schedules, Occurrences, and the minimal dispatch metadata required
for idempotency and previous-success lookup.

The store promises:

- atomic replacement, so readers never observe truncated JSON;
- serialized writes within one process;
- validation at startup, with an unreadable store causing startup refusal rather than silent
  loss of every Schedule;
- a unique public Schedule ID that remains stable across restart;
- an atomic claim operation that makes `(schedule ID, due time)` dispatchable once;
- bounded occurrence retention in the file while Slack remains the human-facing history;
  retain the latest 100 Occurrences per Schedule; and
- no automatic migration from an unknown schema version.

Open-agent continues to support one process per `stateDir`; coordinating multiple active
instances against the same state directory is out of scope.

At startup, any Occurrence left `running` by a previous process is marked `failed` with an
interrupted-process reason. Its Job is not resumed automatically because side effects may
have partially landed. The destination receives a failure notice identifying the affected
Schedule and Occurrence.

## Slack Integration

Extend the Slack port with operations to:

- look up a user's IANA timezone;
- resolve a channel reference to one unambiguous channel;
- inspect whether the bot can post a top-level message and create Threads there; and
- post a top-level message without an existing Thread.

Existing threaded operations continue accepting a `Thread`. A successful top-level post
returns its timestamp, which becomes the Scheduled Job's `Thread.ts`.

Add `users:read` to the documented bot scopes and preflight expectations. Existing channel
read and `chat:write` scopes are reused. Channel validation must use Slack IDs internally and
must not assume names are unique across every conversation visible through Slack Connect.

Slack failures before a Schedule is persisted fail the management tool without mutation.
If the Schedule is already durable and an Occurrence announcement cannot be posted, record
that Occurrence as failed and do not run an invisible Job. A later Occurrence remains active.

## Configuration and Startup

No scheduler enable flag is added. Scheduling is a built-in capability.

Startup order becomes:

1. load and validate configuration;
2. open and validate Session, Vault-change, and Schedule stores;
3. create Slack and engine dependencies;
4. run existing preflight plus the new Slack user-timezone capability check;
5. start the authenticated loopback schedule MCP server;
6. start Slack Socket Mode subscriptions;
7. reconcile interrupted and missed Occurrences; and
8. start the scheduler timer.

Startup logging reports the number of active and paused Schedules, the next due time if any,
and the global Job timeout. It never logs Schedule task text, because tasks may contain
private operational context.

## Testing Decisions

Use the existing top-level harness with fake Slack, scripted engine, controllable clock, and
real temporary state files. Do not make tests wait on real time.

Behavioral coverage must include:

- creation with an explicit timezone;
- creation defaulting to the creator's Slack timezone;
- missing channel and missing Slack timezone produce a question and no Schedule;
- inaccessible, archived, ambiguous, read-only, and non-threadable destinations are refused;
- successful creation notifies the request Thread and destination channel exactly once;
- all supported one-time and recurring calendar rules calculate the correct next instant;
- every sub-daily or multiple-times-per-day recurrence is rejected;
- DST nonexistent times skip and repeated times dispatch once;
- a due Occurrence creates one top-level message and runs an ordinary Job in its Thread;
- the final answer remains threaded rather than copied to the channel;
- manual and Scheduled Jobs share the instance concurrency ceiling;
- recurring runs use separate Sessions and receive previous-success metadata;
- restart skips missed due times and does not flood Slack;
- duplicate timer wakes cannot dispatch the same Occurrence twice;
- an overlap is skipped, recorded, and announced;
- failure and timeout do not retry and do not disable the next Occurrence;
- `run now` preserves the next calendar due time;
- pause, resume, update, destination change, delete, list, and show semantics;
- destination change notifies both old and new channels;
- a malformed or unknown-version Schedule store refuses startup without mutation;
- a process restart marks a formerly running Occurrence interrupted and does not rerun it;
- six hours is the default timeout and values at or above 24 hours are rejected;
- the schedule MCP server requires its bearer credential and is unreachable off loopback;
- tool failure cannot be reported by the agent as successful creation; and
- direct mention behavior remains unchanged apart from the now-default timeout.

Add a small contract test using the real Codex adapter and project-owned MCP server. It
proves that an ordinary-language scheduling request can invoke `create_schedule`, receive
its structured result, and report it. It is opt-in with the existing contract suite; all
calendar, persistence, Slack, and scheduler behavior remains covered without a live model.

## Documentation

Update:

- `README.md` with creation and management examples;
- `docs/configuration.md` and `open-agent.config.example.json` for the mandatory default
  timeout and `users:read` scope;
- the Slack app setup instructions with the new scope and reinstall requirement;
- `assets/operating-manual.md` with schedule-tool behavior; and
- the startup/preflight description with Schedule-store and scheduler checks.

The original Slack coworker spec lists schedulers and acting unprompted as out of scope. This
feature intentionally supersedes only the **time-based scheduler** part of that statement.
Channel watching, webhooks, repository events, and other event-triggered work remain out of
scope.

## Out of Scope

- Literal shell commands as Schedule definitions.
- User, role, or ownership authorization for Schedule management.
- Event-based triggers, polling triggers, and repository or Slack watchers.
- Recurrences more frequent than once per local calendar day.
- Multiple daily times in one Schedule.
- Automatic retry or catch-up of missed, failed, timed-out, or overlapping Occurrences.
- Concurrent Jobs from the same Schedule.
- Resuming one Occurrence's Session in another Occurrence's Thread.
- A web UI, CLI management surface, slash commands, or raw cron-expression interface.
- Multi-instance leader election or a network database.
- Deleting historical Slack messages when a Schedule is deleted.

## Definition of Done

The feature is complete when a user can mention the coworker with:

> Every weekday at 9 AM summarize new commits in `org/repo` and post in #engineering.

and, without writing structured configuration:

1. open-agent resolves the user's Slack timezone and validates `#engineering`;
2. both the request Thread and `#engineering` receive the creation confirmation;
3. the Schedule survives a process restart;
4. at the next due time exactly one ordinary bounded Job starts in a new Thread under a
   top-level `#engineering` announcement;
5. progress, Writes, files, failure information, and the final answer behave exactly as for
   a manual Job;
6. downtime and overlap skip rather than catch up or duplicate work; and
7. any Slack user can list, inspect, update, pause, resume, run now, or delete the Schedule
   through ordinary conversation.
