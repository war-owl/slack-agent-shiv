# With no approval gate, what bounds the blast radius?

Type: grilling
Status: resolved
Blocked by: —

> Superseded 2026-07-29: the inventory-pin proposal recorded in this resolved design
> discussion was removed. Current behavior is documented in ADR-0002: inventories may
> evolve, while known exact tool names and configured `disabledTools` remain unavailable.

## Question

Graduated from [Which Codex interface: `exec` + SDK, or `app-server`?](11-codex-interface.md). The interface decision means the coworker **cannot ask permission** — `codex exec` has no mechanism for it. That is the intended behaviour, and it makes this ticket the entire safety story rather than a hardening pass.

The exposure is concrete. The agent holds write credentials for GitHub and Linear. It reads Slack messages, GitHub issues, and Linear tickets — all of which anyone can write to. The Codex research established that **the sandbox governs filesystem and network, not intent**: nothing distinguishes reading a pull request from merging one. So the path from "a stranger files an issue" to "the agent did something destructive" has no human in it.

Four layers can bound this, and they are the only four:

1. **Token scoping** — what the credential literally cannot do. The strongest layer, because it fails closed and does not depend on the agent behaving. Decide the actual permission set for GitHub and Linear. Note this collides with a known constraint: a fine-grained GitHub PAT cannot use the Search API, so tightening the token costs the agent issue search (ticket 05 establishes whether GraphQL is a way out).
2. **Codex sandbox mode** — filesystem and network reach for the subprocess. Which mode, and what does the working directory contain? The Obsidian vault and any repo checkout both live inside whatever this allows.
3. **`execpolicy` rules** — which commands may run at all. Where is the line between a useful coworker and one that can `rm -rf` or `curl | sh`?
4. **Per-MCP-server `disabled_tools`** — which tools exist from the agent's point of view. Cheapest lever available: if `merge_pull_request` is not in the inventory, no prompt can invoke it. Requires knowing the real inventories, which is why this ticket waits on ticket 05.

Force these into the open:

- **Which actions are acceptable unattended, and which should be impossible?** Not "which need confirmation" — that option is gone. Draw the line between *can do freely* and *cannot do at all*. Opening a PR is almost certainly the former; merging one, force-pushing, closing someone else's ticket, or posting as the user are candidates for the latter.
- **Does the agent get one identity or two?** A read-mostly credential for exploration and a narrow write credential for the specific actions v1 sanctions is more work, but it makes the dangerous surface small and auditable.
- **What does a self-hoster have to understand?** They are configuring an unattended agent with their own write tokens. What must the setup guide make unmissable, and what is a safe default if they read nothing?
- **Audit.** With no approval prompts, the thread transcript is the only record a human sees. Is that enough, or does every external write need to be echoed into Slack as it happens?
- **Residual risk.** Name what is deliberately accepted. A coworker that can act is useful *because* it can act; pretending the risk is eliminated would be worse than stating it.

Interacts with [What stops untrusted content from becoming trusted memory?](10-memory-poisoning.md) — that ticket bounds what gets *written down*, this one bounds what gets *done*. A poisoned memory is only as dangerous as the actions available to the agent that reads it.

Resolution states the permission set per service, the sandbox and `execpolicy` posture, the disabled-tool list, and the accepted residual risk. Warrants an ADR.

## Inventories are now in hand — this ticket is unblocked

[Ticket 05](05-provision-accounts-and-tokens.md) retrieved both real tool inventories, and the result changes how layer 4 has to be built:

- **Linear** — 57 tools, thoroughly annotated: 35 read-only, 18 flagged destructive (every `save_*` upsert included). A deny-list is **mechanically derivable** from `readOnlyHint` / `destructiveHint`. Inventory: [`research/linear-mcp-inventory.md`](../research/linear-mcp-inventory.md).
- **GitHub** — 44 tools exposed to a `repo`-scoped token, and **exactly one flagged destructive (`delete_file`)**. `merge_pull_request` and `push_files` are *not* flagged. Inventory: [`research/github-mcp-inventory.md`](../research/github-mcp-inventory.md).

**So MCP annotations are not a portable safety primitive.** Any design that says "deny everything marked destructive" would leave `merge_pull_request` wide open. Linear's annotations can be trusted as a starting point; GitHub's list must be hand-curated, and the curation has to be pinned to a tool inventory that can change under a version bump.

That asymmetry is itself a design input: an allow-list is safer than a deny-list here, because a deny-list silently fails open when a server adds a tool.

Also relevant from ticket 05: Linear's MCP server exposes a **code-review surface** (`submit_diff_review`, `merge_diff`, `resolve_diff_thread`) that nobody scoped into v1. Decide whether it is in the allow-list at all.

## Answer

Three decisions, taken with the project owner. Together they say: **the credential is the security boundary; everything above it is defence-in-depth.**

### 1. The action line — everything except the irreversible

The coworker may read, comment, create, update, close, push branches, and open pull requests. It may **not**:

| Blocked | Server |
|---|---|
| `merge_pull_request` | GitHub |
| `delete_file` | GitHub |
| `merge_diff` | Linear |
| `submit_diff_review` | Linear |
| `delete_attachment`, `delete_comment`, `delete_diff_comment`, `delete_status_update` | Linear |

The criterion is **not** "dangerous" but **"can a human undo this after noticing it in the thread?"** A wrong comment is embarrassing; a merged PR is in `main`. Those are also precisely the actions a poisoned issue comment would aim at.

Noted for whoever implements this: **Linear's `save_*` tools are upserts.** `save_issue` both creates and overwrites, so "may create but not modify" is not expressible at tool granularity — only at argument granularity. We are deliberately *not* drawing that line, which is what makes the tool-level policy above workable. GitHub splits create/update properly; Linear does not. Do not assume symmetry.

Left open on purpose: Linear's code-review surface (`get_diff`, `list_diffs`, `get_diff_threads`, `resolve_diff_thread`) is allowed for reading and commenting, but `merge_diff` and `submit_diff_review` are blocked. Nobody scoped this capability into v1; revisit if it turns out to matter.

### 2. Enforcement — deny-list plus a pinned inventory

Name the blocked tools in config; **pin a hash of each server's `tools/list`**. On startup, compare live inventory against the pin; on mismatch, refuse to start (or drop to read-only) and tell the operator, with a documented "review the diff, then re-pin" step.

This exists because of a measured fact, not a hypothetical. **MCP annotations are not a portable safety primitive**: Linear flags 18 of 57 tools destructive, GitHub flags exactly one (`delete_file`) and leaves `merge_pull_request` and `push_files` unflagged. A deny-list over hosted servers you do not control **fails open** the day a new tool appears — and Linear shipping `merge_diff` unannounced is evidence it will. Pinning converts a silent capability gain into a loud startup failure, at the cost of one hash comparison.

Rejected: a pure allow-list (~90 tools) — correct failure direction, but a maintenance burden pushed onto self-hosters who install and forget, and it silently loses useful new tools.

### 3. The shell bypass — the token is the boundary

The agent has shell access and the PAT doubles as the git password, so `gh api -X PUT …/merge` or a plain `curl` reaches the same capability **without touching an MCP tool**. The tool policy governs one of two channels.

Decision: **make the credential incapable of the blocked actions**, and treat the deny-list as defence-in-depth rather than the boundary. This is the only layer that fails closed regardless of what the model does or what a prompt injection tells it.

**This decision is conditional on an unverified fact.** It requires that GitHub's fine-grained PAT permissions can grant pull-request write *without* merge rights. If they cannot — if "Pull requests: write" implies merge — this option collapses and the ticket must reopen and choose between sandbox egress allow-listing, withholding the credential from the shell, or accepting the bypass explicitly. Added to [ticket 05](05-provision-accounts-and-tokens.md) as a blocking check.

### Judgment calls recorded, not grilled

- **Sandbox mode: `workspace-write` with network enabled.** The agent must write the vault and any repo checkout, and needs egress for MCP servers and package installs. `read-only` cannot do the job and `danger-full-access` gives up the filesystem boundary for nothing. Revisit if the working directory ends up containing anything the agent should not touch.
- **`execpolicy`: not restricted in v1.** Once the credential is the boundary, per-command rules buy little and cost a lot of tuning. Reconsider if a concrete abuse path appears that scoping does not close.
- **Audit belongs to [ticket 08](08-job-model.md), not here.** With no approval prompts the thread transcript is the only thing a human sees, so "echo every external write into Slack" is a real requirement — but it is a progress-reporting contract decision, and duplicating it here would mean two tickets owning one answer.

### Residual risk, stated rather than hidden

A coworker that can act is useful *because* it can act. What is deliberately accepted:

- Anything within the token's power is reachable by a sufficiently well-crafted prompt injection from any Slack message, GitHub issue, or Linear ticket. The bound is the credential, not the agent's judgement.
- Non-destructive but embarrassing actions — a wrong comment, a bad ticket update, a spurious PR — are fully available and will happen. Recovery is human and manual.
- `save_*` upserts mean the agent can overwrite an existing Linear issue's contents while nominally "creating" one.
- Pinning detects inventory *change*, not inventory *danger*. A human still has to read the diff.

Recorded as [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md).

## Comments

**Amended — fine-grained PATs ruled out.** The project has decided against fine-grained PATs. A classic PAT's `repo` scope is all-or-nothing and cannot separate merge from pull-request write, so **layer 3 as decided here (token scoping) has no implementation** and the conditional flagged above resolves against it — not by GitHub's limitation, but by choice.

The boundary moves from the credential to the repository: **branch protection on the default branch** (require a PR, require an approving review, disallow bypassing including admins), verified by preflight, which refuses to start on an unprotected repository. Of the three fallbacks named in the original answer, egress allow-listing was rejected as ineffective — the merge endpoint shares a host with every legitimate read, so only a filtering proxy could distinguish them — and withholding the credential from the shell was rejected as unverified, since Codex's sandbox permits broad filesystem reads.

What changes in kind: the guarantee is now **per-repository and opt-in** rather than a property of the token. That is a real loss of robustness, and the preflight check is the entire mitigation.

Two consolations. `delete_repo` and `admin:org` are simply not granted, so repository deletion and org administration are impossible at the credential after all; `workflow` is withheld too, since a writable CI definition routes around every other control. And a classic PAT **can** use the Search API, so the coworker keeps issue search — the capability a fine-grained PAT would have cost it.

Still conditional, on two checks now on [ticket 05](05-provision-accounts-and-tokens.md): that bypass-disabled protection actually binds a repository admin, and that it is available on a free private repo. If merge succeeds against a protected branch, this ticket reopens and the only remaining option is accepting the bypass explicitly.

[ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) has been amended accordingly.
