# Spec: Slack coworker v1

Status: ready-for-agent

Synthesised from the [map](map.md) — twelve decision tickets, five ADRs, and fifteen build slices. Every decision below traces to one of them; this document assembles them into something buildable and does not reopen any.

**Revised 2026-07-28**, after the provisioning checks ran and six decisions landed that this document originally predated. The changes are not cosmetic — the branch-protection story moved from *verified assumption* to *measured, and partly broken*, and preflight's behaviour reversed from refusing to warning. If you are returning to a copy of this spec you read earlier, reread [The action boundary](#the-action-boundary) and [Skills](#skills).

## Problem Statement

Delegating real work to an AI assistant today means babysitting it. You open a separate tool, paste in context it should already have, watch it work, answer its permission prompts, and copy the result back to wherever the work actually lives. The moment you walk away, it stops — either because it is waiting on you, or because it has no way to tell you it finished.

A coworker is different. You ask a coworker for something in the channel where the work is being discussed, they go away for an hour, and they come back with it done. They already know your projects, because they have been here a while. They know where the repository is and which Linear team owns the ticket. They do not ask you to re-explain the thing you explained last week, and they do not ask permission to open a pull request, because opening a pull request is not the kind of thing you ask permission for.

Nobody self-hosting today can get that. The pieces exist — capable agents, MCP connectors, Slack bots — but assembling them into something you can @-mention and then close your laptop on is a project, not a download. And the assemblies that do exist are SaaS: your credentials, your private channels, and your accumulated context live on someone else's infrastructure.

## Solution

An open-source, self-hosted AI coworker that lives in a Slack workspace you control, running against tokens you issue.

You @-mention it in a Thread with a real task. It acknowledges immediately, then works — for minutes or hours — reporting progress in a single message it keeps updating, and appending a permanent record of every Write it makes to the outside world. When it finishes it reports back in the Thread. You were not there for any of it.

It gets better at this over time because it takes notes. Everything it learns goes into a Vault of Markdown Notes that you can open in Obsidian, read, correct, or delete. That Vault is not a sidecar to its memory — it *is* its memory. There is no hidden store, no embedding index, nothing it believes that you cannot open in a text editor.

It reaches GitHub and Linear over MCP with your tokens, and it acts unattended: it runs commands, files tickets, and opens pull requests without stopping to confirm. That is a deliberate product decision, and the safety story is correspondingly structural — a hand-curated deny-list removes the irreversible tools, the repository itself refuses merges to a protected default branch, and the Thread records everything it did. Where the repository cannot be protected, the instance says so at startup and runs anyway; the honest version of the guarantee is stated in [The action boundary](#the-action-boundary) rather than promised here.

It also does work that has nothing to do with code. Drop a CSV into the Thread and ask a question, and it writes a script and runs it rather than eyeballing the data. Point it at a **Skill** — a procedure you wrote down, like how to query your read-only reporting database — and it follows it. Skills are yours to write and the coworker cannot edit them, which is what makes them safe to hand it.

## User Stories

### Delegating work

1. As a delegator, I want to @-mention the coworker in any channel Thread with a task in plain language, so that I can hand off work from where the work is already being discussed.
2. As a delegator, I want an acknowledgement within a couple of seconds of mentioning it, so that I know my request landed and can close my laptop.
3. As a delegator, I want the coworker to keep working for as long as the task takes, so that "delegate and walk away" is literally true and not a three-minute timeout.
4. As a delegator, I want to mention it again in the same Thread days later and have it remember the whole conversation, so that I never have to restate context I have already given.
5. As a delegator, I want a follow-up mention while it is still working to be queued rather than dropped, so that I can add a clarification without waiting for it to finish.
6. As a delegator, I want to be told my follow-up was received and queued, so that silence does not read as the message being lost.
7. As a delegator, I want to be able to hard-stop a running Job, so that "wrong repo, stop" has an answer that does not involve waiting an hour.
8. As a delegator, I want the coworker to work on tasks that span its Notes, GitHub, and Linear in one request, so that I am not decomposing the work into per-tool steps myself.
9. As a delegator, I want two Jobs in two different Threads to run at the same time, so that one long task does not block the rest of the workspace.
10. As a delegator, I want the final report posted in the Thread where I asked, so that the answer lives with the question.

### Watching progress from a distance

11. As a delegator, I want a single progress message the coworker keeps updating, so that checking on it is one glance rather than scrolling a wall of narration.
12. As a delegator, I want that progress to show the coworker's own plan and which step it is on, so that I can tell the difference between "thinking hard" and "stuck".
13. As a delegator, I want the progress indicator to keep refreshing while a long step runs, so that a quiet ten-minute test run does not look like a crash.
14. As a thread observer, I want the progress message to be visibly distinct from the coworker's actual output, so that I can skim the Thread later without re-reading its working.
15. As a delegator, I want to be told roughly what it is doing right now — running a command, calling a tool, editing a file — so that progress is concrete rather than a spinner.
16. As a delegator, I want the coworker not to narrate every individual tool call into the channel, so that the Thread stays readable.

### Accountability for unattended action

17. As a thread observer, I want every Write the coworker makes to the outside world appended to the Thread as its own permanent message, so that there is an accountability record of what it actually did.
18. As a thread observer, I want those Write records to be un-overwritable, so that the audit trail cannot be edited away by a later progress update.
19. As a thread observer, I want a Write record to name the thing that was written — which pull request, which ticket, which comment — with a link, so that I can go and check it.
20. As a delegator, I want every Note the coworker creates or changes echoed into the Thread as a diff, so that I can see what it decided to believe and correct it if it is wrong.
21. As a security-conscious operator, I want merges to a *protected* default branch to fail server-side even when the coworker's own token attempts them, so that the worst thing an injected instruction can achieve is something a human can undo.
21a. As a self-hoster on a free plan, I want to be told clearly that my private repositories **cannot** be protected and what I am therefore running without, so that I am making a choice rather than holding a false belief.
22. As a security-conscious operator, I want the coworker unable to delete a repository or administer the organisation, so that the most destructive actions are absent from the credential entirely.
23. As a self-hoster, I want connector tool inventories to evolve without startup
lock-outs, so that upstream additions, removals, and renames do not require routine
configuration maintenance.
24. As an operator, I want startup to report each connector's current tool count, so that
its reachable surface remains visible without becoming an approval gate.
25. As a security-conscious operator, I want the setup guide to tell me precisely which token scopes to issue, which to withhold, and why each decision was made, so that least privilege is the default path rather than the diligent path.

### Memory that a human owns

26. As a vault owner, I want everything the coworker knows to be Markdown files in a directory I control, so that its memory is inspectable without a special tool.
27. As a vault owner, I want to open that directory in Obsidian and have wikilinks, frontmatter, and folders behave normally, so that it is a real vault rather than a lookalike.
28. As a vault owner, I want to edit a Note by hand and have the coworker respect my edit, so that correcting it is a one-minute job.
29. As a vault owner, I want to delete a Note and have that be a complete removal of the belief, so that recovery from a bad Note requires no tooling.
30. As a vault owner, I want each Note to record when it was last modified and which Thread and Job wrote it, so that I can judge staleness and trace provenance.
31. As a vault owner, I want a Note to represent the current belief rather than an append-only log, so that contradictions surface as visible rewrites instead of accumulating silently.
32. As a delegator, I want the coworker to find relevant prior Notes on its own, so that I do not have to tell it what it already knows.
33. As a delegator, I want it to reach knowledge from other Threads through its Notes, so that it can be a coworker with continuity rather than an amnesiac per channel.
34. As a security-conscious operator, I want one Thread's conversation to be unreachable from another Thread's Session, so that a private channel's contents cannot surface in a public channel's answer.
35. As a vault owner, I want a small Root note that acts as the map of everything else, so that the graph has a front door I can also read.
36. As a security-conscious operator, I want the Root note to be links-only, with any prose stripped before it reaches the model, so that one compromised Job cannot write instructions into every future Job's prompt.
37. As a security-conscious operator, I want that stripping to be reported rather than silent, so that an attempt is visible instead of merely thwarted.
38. As a vault owner, I want to be warned when the Root note grows past its ceiling rather than having it silently truncated, so that I find out before the coworker starts missing things.
39. As a delegator, I want the coworker to tidy and link its Notes at the end of each Job, so that the Vault stays navigable as it grows rather than becoming a junk drawer.
40. As a delegator, I want that filing pass to be separate from doing the work, so that curation does not compete with the task for attention.
40a. As a vault owner, I want the coworker to **decide for itself whether a Job produced anything worth remembering**, and write nothing when it did not, so that asking it a throwaway question does not leave a Note behind.

### Data, Skills, and analysis

40b. As a delegator, I want to attach a CSV or a log dump to my mention and have the coworker work on the file itself, so that I am not pasting data into a message and hoping it survives.
40c. As a delegator, I want it to analyse data by writing and running a script rather than reasoning over the rows in its head, so that the answer is computed rather than estimated.
40d. As a delegator, I want to be told honestly when it cannot read a file I attached, so that I do not receive confident analysis of something it never opened.
40e. As a vault owner, I want to write a **Skill** — a procedure it should follow, like how to query a reporting database — as an ordinary Markdown file I edit in Obsidian, so that teaching it something requires no code.
40f. As a security-conscious operator, I want the coworker to be **structurally unable to edit a Skill**, so that a poisoned Job cannot write commands that a later Job in another Thread will execute.
40g. As a vault owner, I want Skills to name an environment variable rather than contain a credential, so that my Vault stays something I can sync and commit.

### Failure, restart, and bounds

41. As a delegator, I want a Job that dies to post what completed, what did not, and that side effects may have partially landed, so that I know what to check rather than guessing.
42. As a delegator, I want the Session to survive a crash so that my next mention resumes from the last completed Turn rather than from nothing.
43. As a delegator, I want the coworker to be told when it is resuming after an interruption, so that it verifies state instead of pushing a branch that already exists or filing a duplicate ticket.
44. As an operator, I want a per-Turn wall-clock timeout that hard-kills the subprocess, so that a wedged Job costs minutes rather than a weekend.
45. As an operator, I want a cap on Turns per Job, so that a loop cannot run indefinitely.
46. As an operator, I want a cumulative token budget per Job that stops the Job when exceeded, so that a runaway is an annoyance rather than a bill.
47. As an operator, I want the per-Turn timeout, Turn cap, and token budget independently
configurable but disabled by default, so ordinary long-running work is not stopped unless I
choose a ceiling.
48. As a delegator, I want to be told in the Thread when a Job was stopped by a bound rather than finishing, so that I do not mistake a truncated result for a complete one.
49. As an operator, I want the same Slack event delivered twice to produce one Job, so that Slack's retry behaviour does not double the work or the spend.
50. As an operator, I want the instance to survive a Slack disconnect and reconnect without losing its Session mappings, so that a network blip is not a memory wipe.

### Self-hosting

51. As a self-hoster, I want to create my own Slack app from a provided manifest, so that setup is a paste rather than a form-filling exercise — and so that I am not throttled by the rate limits that apply to distributed apps.
52. As a self-hoster, I want the app to run over Socket Mode, so that I do not need a public HTTPS endpoint to try it.
53. As a self-hoster, I want one instance configuration and one extensible `mcp.json`
    naming my tokens, Vault, and connectors, so that MCP servers have one obvious place to
    be added without mixing them into unrelated runtime settings.
54. As a self-hoster, I want the instance to fail at startup with a clear message when a required credential is missing or invalid, so that I find out immediately rather than on the first mention.
55. As a self-hoster, I want the instance to record and report the Codex version it is running against, so that when upstream breaks something I can see what changed.
56. *(withdrawn — the project does not pin a Codex version in v1; see [Runtime configuration](#runtime-configuration).)*
57. As a contributor, I want to add a connector by pointing the configuration at another MCP server, so that extending the coworker requires no code in this project.
58. As a contributor, I want a new server to inherit the fixed deny floor and support
explicit `disabledTools` without freezing its full inventory, so that adding a connector is
both safe for known exclusions and forgiving of future growth.
59. As a self-hoster, I want the documented setup surprises — the org-approval trap, the scopes Slack demands versus offers — written down, so that I hit them with a fix in hand.
60. As a self-hoster, I want the coworker's operating manual to be a file I can read and adjust, so that its persona and working style are mine to shape.

### The repository as the boundary

61. As a self-hoster, I want the setup guide to walk me through protecting the default branch of every repository the coworker touches, so that the safety guarantee is something I actually have rather than something I read about.
62. As a self-hoster, I want the instance to **warn loudly and keep running** when a configured repository's default branch is unprotected, so that a paywall or a forgotten step degrades my safety rather than locking me out of my own tool.
63. As a self-hoster, I want that warning to name the repository and the specific missing setting, and to distinguish *"you have not turned this on"* from *"your plan does not allow this"*, so that I know whether there is anything I can do about it.
63a. As a self-hoster, I want a local pre-push hook installed on every checkout that blocks pushes to the default branch, force-pushes, and branch deletions, so that the common failure — the coworker doing something clumsy — is caught even where the server-side guarantee is unavailable.
64. As a security-conscious operator, I want to be told plainly that Linear has no equivalent protection and runs on the deny-list alone, so that I can calibrate what I connect rather than assume symmetry.
65. As a delegator, I want the coworker to search GitHub issues and code to find things I did not name explicitly, so that I can describe a problem rather than a location.

## Implementation Decisions

Every decision here is inherited from a resolved ticket or an ADR. Where a decision was genuinely open, it is marked as a **judgment call** and can be revisited during implementation without disturbing anything upstream.

### Architecture: a wrapper around a subprocess

The system is a TypeScript Slack-and-orchestration layer wrapping **Codex CLI**, driven headlessly through `codex exec` via `@openai/codex-sdk` ([ADR-0001](../../docs/adr/0001-codex-cli-via-exec-and-sdk.md)). This is not a host for an agent loop — the agent is a separate process, and the wrapper's job is to start it, translate its event stream into Slack, and bound it.

Two consequences constrain everything downstream and are not up for renegotiation during implementation: the stack is **effectively OpenAI-only**, and the coworker **cannot ask permission** (`exec` hard-codes `approval_policy: Never`).

### Modules and their responsibilities

**Slack gateway.** Owns Bolt, Socket Mode, and the `app_mention` subscription. `app_mention` is the only entry point — slash commands are barred from threads and the Assistant surface is DM-only. Bolt auto-acks before the listener runs, which wins the three-second race for free. **`processBeforeResponse` must remain false**; setting it true causes four duplicate runs and is the reason a FaaS deployment is not viable. This module also owns dedupe: the Slack `event_id` is the Job's identity, and a repeated `event_id` is discarded.

**Job runner.** Owns the Job lifecycle, the per-Thread queue, and the bounds. One Job at a time per Thread, with a mention arriving mid-Job held and delivered into the same Session at the next Turn boundary; Jobs in different Threads run concurrently. Receipt of a queued mention is acknowledged immediately. Hard-stop is available because the wrapper owns the subprocess. Three optional bounds — per-Turn wall-clock, max Turns per Job, cumulative token budget accumulated from turn-completion usage — are enforced here when configured, because **Codex provides none of them** and reports usage only after the fact. All three are disabled by default.

**Codex adapter.** The sole owner of `@openai/codex-sdk`, process lifecycle, event translation, and Session identity. ADR-0001 mandates this seam explicitly so that a future move to `app-server` is a bounded rewrite. No other module imports the SDK or knows what a Codex event looks like.

**Session store.** Holds the `thread_ts → codex thread_id` mapping. This is the wrapper's **only durable state** — Codex owns Session content as append-only rollouts on disk, and the Vault is files. **Judgment call:** the concrete store is deliberately left to implementation. It is a small key-value mapping with no schema pressure; the map lists "what holds that mapping" as unresolved fog, and any durable local store satisfies the spec.

**Reporter.** Owns both output channels, which have deliberately opposite semantics. Progress is **one message edited in place**, driven by Codex's todo-list item — the only event emitting updates in `exec` — and refreshed on a cadence inside Slack's two-minute status timeout even when nothing has changed, so a long silent command does not look hung. Audit is **every Write appended as its own permanent message**, never edited, because with no approval gate the Thread is the only accountability record a human sees. Note diffs are echoed into the audit channel alongside external Writes.

**Vault.** Owns Root note injection and its links-only enforcement, frontmatter conventions, and the Librarian pass. The Root note is injected by the wrapper into every Job — injection is a structural guarantee where "always read the root first" would be a behavioural one. At injection, **anything that is not a link line is dropped and the drop is surfaced** ([ADR-0004](../../docs/adr/0004-root-note-is-links-only.md)); this must not be relaxed to allow explanatory prose. A size ceiling on the Root warns rather than truncating, because Codex truncates silently at 32 KiB.

**Preflight and configuration.** Validates credentials, records and reports the installed
Codex version, connects to each configured MCP server and reports its current tool count,
**checks default-branch protection on every configured repository**, and generates Codex's
own configuration including per-server disabled tools.

Two different severities, and the distinction is load-bearing:

- **Tool inventory changes are allowed.** Connectivity or credential failures remain hard
  startup failures; additions and removals do not.
- **Missing branch protection is a warning, and the instance starts anyway.** It names the repository, the missing setting, and whether the condition is *fixable* (protection is available and off) or *unfixable on this plan* (`403 Upgrade to GitHub Pro`) — the remedies differ completely and one generic message serves neither.

### Runtime configuration

Settled during provisioning; recorded here because implementation needs concrete values, not because any of them is architecturally interesting.

- **Codex auth: subscription (ChatGPT-plan) credentials**, not an API key. `~/.codex/auth.json`.
- **Model `gpt-5.6-sol`, reasoning effort `low`.**
- **No Codex version pin in v1.** The instance runs against whatever is installed, records the version, and reports it. Build tickets referring to "the project's pin" mean "the recorded version" until a pin exists.

> **Two of these reverse earlier findings and are recorded as accepted risk, not as resolved questions.**
>
> **The version pin was a research conclusion, not a preference.** Codex ships multiple alphas a day and has already removed flags this project would plausibly have depended on (`--full-auto`, `wire_api = "chat"`, `ollama-chat`). Self-hosters install and forget. Without a pin the expected failure is an instance that breaks overnight for a reason nobody can see, which is why reporting the version at startup is the minimum that must survive this decision. Revisit before any public release.
>
> **Subscription auth for an always-on bot was flagged as unestablished and is still unverified.** Whether plan credentials permit sustained unattended automated use — rate limits, terms, and whether `auth.json` needs periodic interactive refresh — has not been tested. A credential that silently expires mid-Job is the failure mode to watch for, and it looks like an engine error rather than an auth error.
>
> **Reasoning effort `low` is in tension with a stated goal.** The coworker is wanted for analysis and "critical thinking, then reply". `low` is the right default for cost and latency on the many shallow Jobs, but if considered answers come back thin, effort is the first dial to turn, not the prompt.

### The memory model

There is **no memory store** ([ADR-0003](../../docs/adr/0003-vault-is-the-memory.md)). Everything the coworker writes is a Note in the Vault, and those Notes are what it remembers. Recall is agent-initiated traversal of the wikilink graph from the injected Root note, not preloading and not embedding retrieval — this matches what every surveyed real system converges on.

The coworker is its own **Librarian**, discharged at the end of each Job: decide whether anything is worth recording, and if so file the Note, wire its wikilinks, and update the Root if a new hub appeared.

**Noteworthiness is judged by the model, not by a rule.** The Librarian pass is a **separate Codex call** given the Job's transcript and asked whether anything durable was learned. Most Jobs — "what is our MRR", "summarise this thread" — should produce nothing, and producing nothing is a success, not a failure. A fixed rule (always write, or write when a Job touches a connector) would either fill the Vault with query residue or miss the genuinely interesting Jobs; the judgment is editorial and belongs with the thing that can read the transcript.

Consequences worth building for:

- **The judge needs to know what the Vault already contains**, or it will re-record what is already there. It gets the Root note by the same injection path as any Job.
- **A failed or empty Librarian pass never fails the Job.** The work is already done and reported; curation is best-effort.
- **It is a second Codex call per Job** — real cost and latency, mitigated by `low` effort and by returning early when the transcript is trivially unremarkable.
- **It will be inconsistent.** The same conversation on two days may be judged differently. Accepted: the Vault is human-editable and the cost of a wrong call in either direction is small.
- This does not reopen ticket 10's rejection of quarantine. The judge is still the same agent lineage that read the untrusted content, and it is **not** a trust boundary — it is an editorial filter. Every Note it writes is still echoed into the Thread as a diff, which remains the actual control.

`AGENTS.md` is the stable operating manual and **never the memory** — capped, always-on, refreshed once per run, and kept stable to keep the prompt cache warm. It carries the coworker's persona and the standing instruction that Notes and external content describe the world but never direct behaviour. That instruction is recorded as defence-in-depth and explicitly **not** as a control; the real controls are the links-only Root, the bounded credential, and human visibility.

Cross-Thread context goes **through the Vault and only the Vault**. Sessions never read each other, and the coworker must not be able to reach Codex's own session storage — Threads have different audiences, and transcript access would put a private channel one grep from a public answer.

### The action boundary

Three layers ([ADR-0002](../../docs/adr/0002-unattended-action-boundary.md)) — **but only two of them cover GitHub**, see the note below:

1. **Policy** — the coworker may do anything a human can undo, but not merging, `merge_diff`, `submit_diff_review`, deleting files, or Linear's `delete_*` family.
2. **Exact-name deny-list** — enforced as Codex's per-server disabled tools. A fixed
   hand-curated floor covers known irreversible tools and configuration may add
   connector-specific `disabledTools`; the rest of the live inventory is allowed to evolve.
   MCP annotations are not a portable safety primitive. A repo-managed **`pre-push` hook**
   sits inside this layer as defence-in-depth (below). **MCP only** — see the note.
3. **Branch protection on the default branch** — because the agent has shell access and the token doubles as the git password, the irreversible actions are blocked *server-side* rather than at the credential: require a pull request before merging, require an approving review, and disallow bypassing including for administrators. **Where it can be enabled, this works** — verified, not assumed.

> **Layer 2 does not cover GitHub** ([ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md)). GitHub is reached by Skill over the `gh` CLI, not by MCP, so there is no tool surface to disable. GitHub runs on layers 1 and 3, and since layer 3 is plan-gated and warn-only, **a free-plan self-hoster in private repositories has no structural boundary on GitHub at all.** The substitutes are a "do not merge" instruction in the Skill and a `gh` shim that records invocations — both weaker than a tool that does not exist. This is the most-weakened point in the design and is called out as such in [build/09](build/09-github-connector.md) and [build/10](build/10-branch-protection-verification.md).

**GitHub authenticates as a GitHub App installation**, scoped to repositories the self-hoster selects in GitHub's own UI ([ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md)). Installation tokens cannot be widened beyond the installation, so **repository selection is enforced at the credential** — the thing neither PAT type could express.

**GitHub is connect and forget.** The App is installed once and GitHub authentication is never revisited: the private key has no expiry, and the one-hour installation tokens are minted on demand by a credential helper that lives outside the sandbox's writable root, so a Job never holds a token and there is no expiry to straddle. This is a requirement, and it is *stronger* than the PAT it replaces — GitHub pushes PATs toward a 30/60/90-day expiry and a lapsed one stops the coworker until a human intervenes. Accepted in exchange: a single never-expiring string and per-repository scoping are mutually exclusive, since only installations can scope and only installations issue short tokens. `/search/issues` accepts installation tokens, so issue search survives without paying blanket scope for it. The permissions withheld are `administration`, `members`, and `workflows` — the App-manifest equivalents of the old withheld PAT scopes, and a writable CI definition is still an execution path around every other control.

*Historical: the GitHub token was a classic PAT with `repo` scope, chosen because fine-grained PATs cannot search. That trade no longer exists.*

Sandbox is `workspace-write` with network enabled; `execpolicy` is unrestricted in v1.

#### Layer 3, as measured

Both open questions were tested against a live classic PAT. **They did not come back the same way.**

**It binds admins — confirmed.** A ruleset with `bypass_actors: []` blocked the repository *owner's own token*: merge returned `405 Repository rule violations found`, force-push returned `GH013 … Cannot force-push to this branch`. This was the load-bearing assumption and it holds.

**It is unavailable on free-plan private repositories — both mechanisms.** Classic branch protection and rulesets both return `403 Upgrade to GitHub Pro or make this repository public`. Rulesets were the hypothesised escape hatch; they are gated identically. So **layer 3 does not exist for a self-hoster on a free plan working in private repositories**, which is plausibly the modal user, and for them the boundary is layers 1 and 2 alone.

**Preflight therefore warns and continues rather than refusing.** Refusing was the original design and was given up deliberately: a self-hoster should not be locked out of their own tool by a paywall they cannot clear. The trade is explicit — **the instance will knowingly run without layer 3**, which promotes the guardrails from supplement to sole mitigation. Do not implement the warning without also implementing ~~the deny-list,~~ the `pre-push` hook, the `AGENTS.md` git policy, and — since [ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md) removed the deny-list from GitHub — the Skill's "do not merge" instruction and the `gh` audit shim; that combination is strictly worse than the refusal it replaces.

Preflight resolves protection with two calls: `GET /repos/{o}/{r}/rules/branches/{default_branch}` for effective rules — mechanism-agnostic, so classic protection and rulesets arrive in one shape — then `GET /repos/{o}/{r}/rulesets/{id}` for **`current_user_can_bypass`**, which must read `"never"`. Bypass state is *not* present on the `/rules` response.

#### The local pre-push hook

Installed by the wrapper on every checkout it creates, via `core.hooksPath`. It blocks pushes to the default branch, non-fast-forwards, and remote-branch deletions.

**It must be stdin-driven** — reading git's `<local ref> <local oid> <remote ref> <remote oid>` lines and judging the destination ref plus `git merge-base --is-ancestor`. The obvious implementation, which checks the current branch and greps the parent process for `--force`, was tested and defeated twice: `git push origin HEAD:main` from a feature branch pushed to main, and a `+refspec` rewrote history with no `--force` string to match.

**It is not a boundary and must not be documented as one.** `--no-verify` skips it, `core.hooksPath` can be overridden per invocation, `workspace-write` lets the agent edit the hook file, and the PAT in the environment reaches the merge endpoint over `curl` without touching git at all. It guards against accident, model error, and drift — the common failure modes — and contributes nothing against the prompt-injection case. Measured in [`research/local-git-enforcement.md`](research/local-git-enforcement.md).

> **What this does not cover.** Linear has no equivalent to layer 3 — its API key carries whatever the user can do, and there is no repository-shaped thing to protect. The Linear half of the system runs on layers 1 and 2 alone. This was equally true under the previous credential-scoping design, but it should be stated plainly in the setup guide rather than left implicit.

### Connectors

There are **two routes to an outside system, and no plugin interface** for either.

**MCP servers named in `mcp.json`**
([ADR-0005](../../docs/adr/0005-connectors-are-mcp-config.md)) — the route for Linear and
for anything a self-hoster adds. The project-owned file supports Streamable HTTP and stdio;
preflight consumes it through the official TypeScript client and translates the same
validated entries into Codex configuration. Under `exec` the wrapper is not in the tool
path; Codex calls the servers directly, so any normalising abstraction would still mean
shipping a proxy MCP server.

**Skills — a human-authored procedure plus the shell** ([ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md)) — the route for GitHub, and for anything where standing up an MCP server is not worth it. A Skill lives outside the sandbox's writable root, so the coworker follows it and cannot edit it.

**Choosing between them turns on where the boundary must live.** An MCP server permits a deny-list over its tool surface; a Skill puts the entire boundary in the credential, because nothing mediates the shell. GitHub went the Skill route *because* its boundary needed to be repository selection, which only a credential can express — and it accepted losing the deny-list to get it.

Third-party extension is "point it at an MCP server, or write a Skill."

**Git and the pull request are now one path.** A local checkout costs no new credentials and no API can grep a codebase or run its tests, so the checkout stays — but ~~the seam is git for the filesystem, MCP for the pull request~~ **that seam is withdrawn**: the branch is pushed with git and the pull request opened with `gh`, both shell, both under the same installation token.

Argument-level constraints are structurally unavailable — nothing can inspect the arguments to Linear's `save_issue` to distinguish creating from overwriting. Accepted.

### Skills

A **Skill** is a human-written Markdown procedure the coworker can read and follow but **cannot edit** — how to reach the read-only reporting database, how to pull the weekly export, which command to run. It is the second route to capability alongside MCP connectors, chosen where standing up an MCP server is not worth it. A database, for instance, is reached by Skill plus the shell rather than by connector.

**Skills are the second prompt-shaped file, and ADR-0004 is amended for them.** The Root note is constrained by *grammar* — non-link lines are stripped at injection. That cannot work for a Skill, whose entire content is instructions. The constraint is therefore on **authorship**, and the threat is worse than for the Root note because the payload is executable: the coworker is its own Librarian, and ADR-0003 makes the Vault the only channel between isolated Sessions, so an unconstrained Skill turns that channel into cross-Thread command execution — a Job reads a poisoned issue, edits a Skill, and a later Job in another Thread runs it.

**Enforcement is filesystem-level, not a wrapper rule.** Skills have no injection chokepoint — they are traversed on demand from disk — so a wrapper-side "do not write here" is advice to the thing being defended against. Skills live **outside the sandbox's writable root**: readable by the engine, editable by the human in Obsidian, structurally beyond the agent's reach. Do **not** implement this as a post-Job hash check and revert; that is detection after execution was already possible, which is the reasoning ticket 10 used to reject quarantine.

> **Unverified, and load-bearing.** That `workspace-write` genuinely denies writes outside the workspace root has not been measured — broad filesystem *reads* are documented, the write boundary is not. This is the first thing to test on the Skills ticket. ADR-0002 already carries one unverified sandbox assumption; do not ship a second.

Two consequences the implementation must carry rather than quietly soften:

- **A Skill names an environment variable; it never contains a credential.** The Vault is human-readable, opens in Obsidian, and will plausibly be committed to git.
- **A resource reached by Skill is outside layer 2.** The deny-list covers the MCP tool
  path; a Skill drives the shell. The credential is the *whole* boundary, so it must
  genuinely be scoped — a read-only database role, not a read-write one nobody intends to
  write with. This is a stronger position than GitHub's, where `repo` scope could not be
  narrowed at all.
- **The coworker cannot improve its own Skills.** A Job that finds a procedure has drifted says so in the Thread and may write an ordinary Note about it; the fix is a human edit. `AGENTS.md` must tell it this, so the failure is a report rather than a silent no-op.

### File ingress

A mention carrying attachments lands those files inside the Job's sandbox workspace before the engine starts, and the prompt names each one, its path, and its type. Without this the only ingress is pasted message text, which caps useful data at a few kilobytes and mangles anything tabular.

The design intent is that the coworker **writes and runs a script** against the file rather than reasoning over rows in-context — which is the main reason a coding agent is a defensible engine for non-code work.

Requirements that are not obvious:

- Download uses the **authenticated** private-download URL with the bot token as a bearer header. An unauthenticated fetch returns **a login page with HTTP 200**, so a naive implementation writes HTML to `data.csv` and the Job then analyses a login page. Assert on content type and magic bytes, not status.
- Files must land **inside the workspace root** or the sandbox cannot read them.
- A size ceiling is enforced from metadata *before* download.
- Filenames are attacker-controlled; sanitise before touching the filesystem.
- Unreadable types fail **honestly in the Thread** rather than being silently dropped.
- An ingested file is untrusted external content under ADR-0004. A CSV with an injection payload in a cell is the expected case.

**Ingress is not memory** — a file is input to one Job. If it matters, the Librarian writes a Note *about* it; raw files do not enter the Vault. **Egress is out of scope for v1**: posting a generated file back needs its own scope and raises whether a written file is a Write requiring an audit record.

> **Unverified.** The Slack surface research covers mentions, status, rate limits, and Socket Mode, and says **nothing about files**. The event shape for attachments, whether `files:read` alone suffices, and whether Codex can read images at all under `exec` are all assumptions until measured.

### Slack specifics

- `app_mention` in channels; the DM/Assistant surface is v2.
- Bot scopes: `app_mentions.read`, `chat:write`, `chat:write.public`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `reactions:write`, and **`files:read`** for attachment ingress. Validate the shipped manifest against Slack's manifest reference before release — it was assembled from the field reference, not copied from a Slack example. Adding `files:read` requires a re-install, so it must be in the manifest from the start rather than added later.
- Socket Mode, chosen deliberately despite Slack's production guidance: the self-hoster has no public endpoint, and the long-job design means the ack race is already won either way.
- No expiring token, so the bot can write to a Thread indefinitely.
- Rate limits favour editing one message in place; posting is roughly one message per second per channel.
- **Do not distribute a single shared Slack app.** Non-Marketplace distributed apps are throttled to one `conversations.replies` call per minute; internal customer-built apps are exempt. "Create your own app from this manifest" is the only configuration that performs.

### Progress and durability characteristics

Progress is **item-level, not token-level** — `exec` deliberately drops deltas. This suits Slack's rate limits. Long-running commands are silent until completion, which is why the status refresh is time-driven as well as event-driven.

Durability is **turn-granular**. A completed Turn is durable and resumable; a Turn interrupted partway cannot be resumed and its side effects may have partially landed. On resuming after an interrupted Turn, the wrapper injects a warning that the previous Turn may have partially completed and that state should be verified before repeating actions — without this the agent re-runs work whose side effects already landed.

### Output adaptation

**Judgment call, and the one genuinely underspecified area.** Codex CLI is a coding agent; its default register is a coding agent's. How much of the coworker persona lives in `AGENTS.md` versus in the Reporter's formatting is left to implementation, with the constraint that the audit channel's content is determined by the event stream and not by the model's prose. The map lists this as unresolved fog and it does not block a build.

## Testing Decisions

### What makes a good test here

Test the coworker's **external behaviour**: what appears in the Thread, what appears in the Vault, and what the engine is asked to do. Do not test that a particular module was called, that events were translated into a particular internal shape, or that the queue holds items in a particular structure. Every one of those is a decision the implementation should be free to change.

The useful framing: a test should still pass if the internals were rewritten, and should fail if a self-hoster's experience changed.

### The primary seam

**One seam, at the top.** Construct the coworker with its external edges injected — a fake Slack client, a scripted engine, a controllable clock, a fake MCP inventory prober, and a real Vault directory. Drive it with synthetic `app_mention` events. Assert on three things: the Slack calls made, the files on disk, and the prompt the fake engine received.

That last one matters more than it looks. Because the fake engine captures its input, prompt-construction guarantees are testable at the top seam rather than by unit-testing a sanitiser — including ADR-0004's links-only Root, which is the system's single most security-critical structural guarantee.

The **Vault is real files in a temporary directory**, not an in-memory filesystem. ADR-0003's whole promise is that a human can open the same directory in Obsidian; an abstraction would let wikilink-resolution and frontmatter bugs pass tests that real files would catch.

Behaviour to cover at this seam:

- A mention produces a Job; a duplicate `event_id` produces exactly one.
- A mention arriving mid-Job is acknowledged and queued to the next Turn boundary, not dropped and not run concurrently within the Thread.
- Mentions in two Threads run concurrently.
- The status message is edited in place and refreshed within the two-minute window even when the engine emits nothing.
- Every Write appends a new permanent message; nothing edits an existing Write record.
- A created or changed Note echoes a diff into the Thread.
- Prose in the Root note is dropped before injection, and the drop is surfaced.
- An oversized Root note warns and is not truncated.
- The Session mapping is reused on a second mention in the same Thread, and a resume after an interrupted Turn injects the verify-state warning.
- Each bound — wall-clock, max Turns, token budget — stops the Job and posts a message distinguishing "stopped" from "finished".
- A dying Job posts what completed, what did not, and that side effects may have partially landed.
- Preflight fails loudly, naming the changed tools, when the prober returns an inventory that does not match the pin.
- Preflight **warns and still starts**, naming the repository and the missing setting, when a configured repository's default branch is unprotected — and distinguishes unprotected from unprotectable.
- A Job whose transcript contains nothing durable writes **no Note at all**; a Job that learns something durable writes one. Both are asserted against a real Vault directory.
- An attached file lands in the workspace and is named in the prompt the fake engine received.
- A Slack file URL fetched without authentication returns a login page, and the ingress path **rejects it** rather than writing it to disk as data.
- A Job that attempts to write to the Skills location fails, and the Skill on disk is unchanged.
- A Job can read a Skill and act on it.
- The `pre-push` hook blocks a push to the default branch, a non-fast-forward via `+refspec`, and a branch deletion, while allowing an ordinary fast-forward to a feature branch.

### The contract seam

A small number of **slow, opt-in tests running a real `codex exec`** on a trivial prompt. This is the one place a fake can drift from reality. Cover only what a fake cannot honestly assert: that the JSONL event stream translates as expected, that resume restores the Session, that hard-kill actually terminates the process, and — because [Skills](#skills) depend on it — that **a write outside the workspace root is denied while a read succeeds**.

These do not run in the default test command. **They matter more than originally planned:** with no version pin, this suite is the only thing standing between an upstream alpha and a silently broken instance. It should be run against whatever version is installed rather than only at a deliberate bump.

### Prior art

There is none — this is a greenfield repository with no source. The seam shape above is therefore also the precedent for later work, and later features should be tested through the same top seam rather than by adding new ones.

## Out of Scope

Ruled out by decisions already made. Each returns only if its decision is reopened.

- **Multi-tenant SaaS** — app distribution, OAuth install flows, per-workspace token storage, tenant-isolated memory, billing, Slack app review. Ruled out by the open-source self-hosted decision.
- **Acting unprompted** — channel watching, webhooks, schedulers, "this PR has been stale three days". Ruled out by the delegate-and-walk-away reading of AFK. This is the largest single thing not being built.
- **A connector plugin API** — ADR-0005. Extension is MCP configuration.
- **The DM / Assistant surface** — a genuinely different entry point; v2.
- **Non-Slack surfaces** — Discord, Teams, CLI, web UI.
- **Bring-your-own-model** — effectively unavailable under ADR-0001; any alternative backend must serve an OpenAI Responses API. Document the constraint; do not build around it.
- **Mid-turn steering** — unavailable under `exec`. Hard-stop is the only interruption primitive.
- **Approval prompts of any kind** — "what needs approval?" is not a valid question in this architecture.
- **Embedding-based retrieval** and any wrapper-generated index of the whole Vault — rejected in favour of graph traversal from the Root.
- **Write-time contradiction or poisoning detection**, and quarantining externally-derived Notes — rejected in ticket 10; the Librarian is the same agent that just read the poisoned issue. The model-judged noteworthiness filter is an *editorial* pass, not a revival of this.
- **Agent-authored Skills.** The coworker follows procedures; it does not write them. ADR-0004 as amended.
- **File egress** — posting generated files back into the Thread. Needs its own scope and its own audit question; v2.
- **A database connector.** Deliberately not built: databases are reached by Skill plus shell, so there is no MCP server to configure, pin, or deny-list.
- **Argument-level tool constraints** — structurally unavailable.
- **Session storage retention and pruning**, and what happens to a Session when its Thread is archived — acknowledged fog, does not block v1.
- **The open-source release plan** — licence, README, contribution model. Follows the spec rather than shaping it.

## Further Notes

**On provisioning — reopened by [ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md).** Most of ticket 05 stands: both branch-protection checks have run, the preflight endpoints are settled, and the Slack app exists with its tokens in place. **The GitHub half is superseded.** The classic PAT that was issued and scope-verified is not the credential any more — a **GitHub App must be registered and installed** against selected repositories, and that is new outstanding work. The `delete_repo` finding survives as a documented trap for anyone still using a PAT, since GitHub reports the missing scope as `"Must have admin rights to Repository"`, misattributing a missing *scope* to missing *permissions*.

Items remaining, none blocking the first build slices: **registering and installing the GitHub App**, ~~the org-approval trap~~ **organisation approval of the installation** (needs an org repo; the failure is now visible rather than silent), ~~withheld-`workflow` behaviour~~ **the undeclared-`workflows`-permission equivalent** (needs a push touching a workflow file), and **whether subscription auth sustains an always-on bot** (see [Runtime configuration](#runtime-configuration) — the one that could bite in production).

**Four GitHub assumptions are unmeasured and block [build/09](build/09-github-connector.md):** whether `gh` works at all with a userless installation token, whether `gh search` reaches the Search API on one, **whether merge sits under `pull_requests: write`** (if so the App cannot deny merge while permitting the coworker's job), and what the coworker sees when a token expires mid-Job. The first three are new because the credential changed; the fourth is new because installation tokens expire and PATs did not.

**On the token type.** Fine-grained PATs are ruled out by project decision, which is what moved layer 3 from the credential to the repository. The coworker keeps the Search API, which a fine-grained PAT would have cost it. The price is that the safety guarantee became **per-repository, opt-in, and — as measured — plan-gated**, where it used to be a property of the token. That is a real regression in robustness, and it has now been compounded twice: once by making protection per-repository, and again by discovering it cannot be enabled at all on free private repos. The deny-list, the hook, and the honest startup warning are the whole mitigation. Do not let any of them be dropped as a convenience during implementation.

**On residual risk, stated plainly.** A poisoning attempt succeeds until a human reads the echoed diff. A poisoned Note is indistinguishable in kind from a real one, by design — there is no trust class in the model. The links-only Root prevents instruction injection into the prompt but not a link to a malicious Note. Anything within the token's power on an unprotected surface is reachable by prompt injection, and non-destructive but embarrassing actions are fully available with manual recovery.

What the design buys is that the worst realistic outcome is a coworker that believes something false and acts on it *without being able to delete a repository, edit CI, or merge to a branch the repository protects* — in a Thread that records everything it did, over a Vault a human can open and fix.

**That last clause now carries a condition it did not before.** On a free-plan private repository the merge protection is simply absent, and the honest statement of the guarantee there is weaker: the deny-list removes the merge *tool*, the hook catches the clumsy *push*, and neither survives an attacker who reaches for `curl`. A self-hoster in that configuration is trusting layers 1 and 2 and the audit trail. The startup warning exists so they know that, and it is the reason the warning must not be softened into a log line nobody reads.

**On sequencing.** The map flagged evolving memory as the sprawl risk. It did not sprawl — ADR-0003 collapsed it into "the Vault is the memory," which is why there is no memory subsystem in the module list. If implementation starts growing one, that is the signal to stop and reread the ADR.

**On the absent Codex version pin.** Flags this project would plausibly have depended on have already been removed upstream (`--full-auto`, `wire_api = "chat"`, `ollama-chat`), and self-hosters install and forget. v1 nonetheless ships without a pin, by decision. Two things follow: the startup version report is not optional, and the contract test suite becomes the real safety net rather than a bump-time formality. Revisit before any public release — "install and forget" is a property of the audience, and it does not change because the pin was inconvenient.

**On what "done" means.** A self-hoster can @-mention the bot in a Thread, walk away, and come back to a completed piece of real work spanning its Notes, its accumulated memory, and live GitHub and Linear data.
