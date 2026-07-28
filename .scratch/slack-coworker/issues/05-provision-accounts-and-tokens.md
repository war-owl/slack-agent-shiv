# Provision a Slack app, a test workspace, and GitHub/Linear tokens

Type: task
Status: open
Blocked by: —

## Question

Nothing to decide here — but several decisions are blocked until the real surfaces can be poked rather than read about. Documentation says what an API offers; only a live token tells you what the scope prompts look like, which permissions Slack actually demands, and whether the Linear MCP server behaves as advertised.

Agent-drivable where possible; otherwise a precise checklist for the human. The work:

- A **Slack workspace** safe to test in — ideally not the one you work in, so a chatty bot in a loop is harmless.
- A **Slack app** in that workspace, with the manifest, scopes, and install completed. Record which scopes were required and which were merely offered.
- A **GitHub token** with access to at least one real repository. Record whether a classic PAT or a fine-grained PAT was used and exactly which permissions were needed.
- A **Linear API key**. The research established this is sufficient — a static key with no expiry, no OAuth app, no callback. Avoid Linear OAuth unless something forces it (24-hour tokens with rotating refresh).
- **Codex CLI installed and authenticated** (`@openai/codex`), per the engine decision. API-key auth is recommended for automation; see the auth-mode question below.

Resolution records **what was done and the facts later tickets depend on**: where credentials are stored (never in the repo), the exact scope lists, any surprises in the setup flows, and any point where the documented flow diverged from reality. Those surprises are the setup story your self-hosters will hit too — write them down while they are fresh.

## Empirical checks added after research

[What is the real integration surface for GitHub and Linear?](03-github-linear-surface-research.md) could not establish two facts from documentation, and both gate the connector-interface decision. Each is roughly ten minutes once the tokens exist — do them as part of this ticket and record the answers here.

1. **Linear's real tool inventory.** Only five tool names are first-party confirmed. Authenticate against `https://mcp.linear.app/mcp` and call `tools/list`. Record the full inventory with parameters. Without this, ticket 07 is designing against a guess.
2. **Whether a GitHub fine-grained PAT can search.** Documentation says a fine-grained PAT cannot call the REST Search API (only `/search/labels`), and the MCP server's six search tools all route through REST search. Test it, and separately test whether **GraphQL `search`** works for a fine-grained PAT — GitHub's docs do not confirm either way. The answer decides whether the setup guide asks for a fine-grained PAT or a classic one, which is a real security-versus-capability trade the project has to make deliberately.

Also worth capturing while provisioning, since each is a documented trap or an open lead:

- **The org-approval trap.** GitHub's "Require administrator approval" default means an unapproved token authenticates successfully and then **silently reads only public data**. Confirm whether the test token is approved, and note exactly what the failure looks like — self-hosters will hit this.
- **`User.gitHubUserId`.** Linear's schema exposes this field. If it is populated in practice, it is an automatic Slack→Linear→GitHub identity join and it collapses most of the identity-mapping fog. Check whether it is actually set on a real user.
- **Codex auth mode.** Whether ChatGPT-plan authentication permits an always-on bot, or whether an API key is required — flagged as unestablished by the Codex research.

## Runner for the checks

[`checks/integration-checks.sh`](../checks/integration-checks.sh) performs all three checks. Syntax-validated but **not executed** — it needs live tokens, so its behaviour is unverified until someone runs it.

```sh
GH_FINE_TOKEN=github_pat_... \
GH_CLASSIC_TOKEN=ghp_...     \
LINEAR_TOKEN=lin_api_...     \
  bash .scratch/slack-coworker/checks/integration-checks.sh
```

Any subset works; missing tokens are skipped rather than failing. Paste the output back into this ticket under `## Answer`.

Environment as of charting: `codex-cli 0.145.0` is installed at `~/.local/bin/codex` (matches the version the research documented). No GitHub, Linear, or Slack credentials are present — the `gh` CLI token for `shivsarthak` is expired and needs `gh auth login`.

## Answer — empirical checks (partial; provisioning still outstanding)

Run against a live `gh` OAuth token (`gho_`, scopes `gist read:org repo workflow`) and a live Linear API key. **The credential is not recorded here and was not written to any file.**

### Check 1 — GitHub search by token type: PARTIAL

| Token type | REST `/search/issues` | GraphQL `search` |
|---|---|---|
| OAuth `gho_` (`repo` scope) | ✅ 200, 20,614 results | ✅ works |
| Fine-grained `github_pat_` | **not tested** | **not tested** |

A classic-equivalent token searches fine over both surfaces. **The actual open question — whether a *fine-grained* PAT can search — remains open**, because no `github_pat_` token exists yet. Create one and re-run [`checks/integration-checks.sh`](../checks/integration-checks.sh) with `GH_FINE_TOKEN` set. Until then the security-versus-capability trade cannot be settled.

### Check 2 — Linear MCP inventory: RESOLVED, and larger than expected

**Two findings, both contradicting research assumptions.**

1. **The Linear MCP server accepts a plain API key as a bearer token.** No OAuth app, no callback, no refresh. The research flagged OAuth as a possible blocker; it is not one. Setup is materially simpler than assumed.
2. **57 tools, not the 5 that were first-party documented.** Full inventory with descriptions and annotations: [`research/linear-mcp-inventory.md`](../research/linear-mcp-inventory.md). 35 read-only, 22 write-capable, 18 marked destructive. The guessed `save_*` upsert pattern is confirmed (`save_issue`, `save_project`, `save_comment`, `save_document`, …). Unanticipated surface worth noting: Linear now exposes a **code-review capability** — `get_diff`, `list_diffs`, `get_diff_threads`, `submit_diff_review`, `merge_diff` — and an agent-skills surface (`list_agent_skills`, `get_agent_skill`). There is no `search_issues`; filtering goes through `list_issues`.

### Check 3 — `User.gitHubUserId`: RESOLVED, partial join

The field exists (alongside `hasGitHubCodeAccess`) and **is populated — but only for users who have linked GitHub to Linear**: 3 of 16 in this workspace. The numeric id completes the join cleanly (`25551419` → `shivsarthak`, `32607539` → `tomaroyal` via `GET /user/{id}`).

So identity mapping is **a free join where it exists and absent otherwise**. Good enough to use opportunistically; not something v1 can depend on. The fog patch narrows rather than closing: the real question is what the coworker does for the majority of users whose accounts are not linked.

### Bonus — GitHub MCP annotations are not a usable safety signal

The GitHub hosted MCP server also accepts the `gh` OAuth token. It exposed **44 tools** to this token; 27 read-only, and **exactly one flagged destructive (`delete_file`)** — while `merge_pull_request` and `push_files` are *not* flagged. Linear flags 18 of 57.

**A deny-list therefore cannot be derived mechanically from MCP annotations across both servers.** Linear's can be; GitHub's must be hand-curated. Recorded in [`research/github-mcp-inventory.md`](../research/github-mcp-inventory.md) and carried into ticket 12.

### Still outstanding on this ticket

- ~~A **classic GitHub PAT**~~ — **done.** Issued with exactly `repo` (verified: `x-oauth-scopes: repo`), withholding `delete_repo`, `admin:org`, and `workflow`.
- ~~**Checks A and B**~~ — **both run.** See [the answer below](#answer--checks-a-and-b). A passes; **B fails**, and the failure is load-bearing.
- A **Slack test workspace and app** — tokens are now present in the local `.env` (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`); the end-to-end install is unverified until `build/01` runs.
- The **org-approval trap** — untested; needs the classic PAT against an org repo.
- **Withheld-`workflow` behaviour** — untested; needs a push touching a workflow file.
- ~~**Withheld-`delete_repo` behaviour**~~ — **verified.** `DELETE /repos/{o}/{r}` on a repo the user owns and administers returned **403**. The scope exclusion does real work. **Trap worth documenting:** the error message is `"Must have admin rights to Repository"`, which misattributes the cause — the user *is* an admin; the *token* lacks the scope. A self-hoster debugging this will look at repository permissions and find nothing wrong.
- **Codex auth mode** for an always-on bot — untested.

*(Check 1 above — fine-grained PAT search — is withdrawn, not outstanding. See below.)*

## Blocking check — withdrawn, and reshaped

**The original check is withdrawn.** It asked whether a GitHub fine-grained PAT could grant pull-request write without merge rights. **Fine-grained PATs are now ruled out by project decision**, so the question has no bearing on anything — and with it, Check 1 above (whether a fine-grained PAT can use the Search API) is moot too. The token is a **classic PAT with `repo` scope**, which searches fine; that was already measured above with a classic-equivalent `gho_` token.

Ruling out fine-grained PATs collapsed [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md)'s third layer, since classic `repo` scope cannot separate merge from pull-request write. The ADR is **amended**: the boundary moves from the credential to the repository, enforced by branch protection. Two new checks replace the withdrawn one.

### Check A — does branch protection bind the token's own user?

The safety model now rests on the coworker being *unable* to merge because the **repository** refuses, not because the token lacks a permission.

Test it: on a throwaway repo, protect the default branch with *require a pull request before merging*, *require at least one approving review*, and *do not allow bypassing the above settings*. Then, with the classic PAT, open a PR and attempt `PUT /repos/{o}/{r}/pulls/{n}/merge`. Attempt a force-push to the default branch as well. **A 405/403 on both confirms the amended model; a 200 breaks it.**

Run it as an account that is an **admin** on the repo. That is the hostile case — self-hosters typically own their repositories, and the entire question is whether bypass-disabled actually binds an owner.

**If merge succeeds, ADR-0002 reopens**, and the only remaining option is accepting the bypass explicitly — egress allow-listing and withholding the credential from the shell were both considered and rejected in the amended ADR. Do not build against layer 3 until this is known.

### Check B — is protection available where self-hosters will need it?

Classic branch-protection rules have historically been **plan-gated on private repositories**; rulesets may be the mechanism that works on a free private repo. Establish which one a self-hoster on a free plan can actually use — "protect your default branch" is useless advice if the button is behind a paywall, and both the setup guide and the preflight check depend on the answer.

Record **which API endpoint preflight should query** to verify protection. Branch protection and rulesets are different endpoints with different response shapes.

### Also confirm while provisioning

- **Withheld scopes behave as expected.** The token grants `repo` and withholds `delete_repo`, `admin:org`, and `workflow`. Confirm that a push touching a workflow file is rejected without `workflow` — that exclusion is doing real work, since a writable CI definition is an execution path around every other control.
- **The org-approval trap** — still worth capturing, now against a classic PAT: an unapproved token authenticates and then silently reads only public data.

## Answer — Checks A and B

Run 2026-07-28 against a live classic PAT (`x-oauth-scopes: repo`, user `shivsarthak`, id `25551419`) on a purpose-made throwaway, `shivsarthak/open-agent-protection-test`. **The credential is not recorded here and was not written to any file in the repo.**

### Check A — does bypass-disabled protection bind an admin? **PASS**

Setup: public repo, ruleset `protect-default`, `enforcement: active`, targeting `~DEFAULT_BRANCH`, rules `deletion` + `non_fast_forward` + `pull_request` (1 approving review), and critically **`bypass_actors: []`**. Acting account is repo **admin** — the hostile case.

| Attempt | Result |
|---|---|
| `PUT /pulls/1/merge` (squash) | **405** — `Repository rule violations found … At least 1 approving review is required by reviewers with write access.` |
| `git push --force origin main` | **rejected** — `GH013: Repository rule violations found for refs/heads/main` / `Cannot force-push to this branch` / `Changes must be made through a pull request.` |

**Bypass-disabled rulesets genuinely bind a repository admin.** ADR-0002's third layer is sound where it can be switched on, and the ADR does not reopen on this axis.

### Check B — is protection available where self-hosters need it? **FAIL — both mechanisms**

Same account, free plan, **private** repo:

| Mechanism | Endpoint | Result |
|---|---|---|
| Classic branch protection | `PUT /branches/main/protection` | **403** — `Upgrade to GitHub Pro or make this repository public to enable this feature.` |
| Repository rulesets | `POST /rulesets` | **403** — *identical message* |

The research hypothesised that rulesets might be the mechanism that works on a free private repo. **It is not — the two are gated identically.** Protection had to be obtained by making the repo public, which is how Check A was run at all.

**Consequence: layer 3 does not exist for a self-hoster on a free plan working in private repositories** — plausibly the modal user. For them the action boundary is layers 1 and 2 alone, which is the posture [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) already calls "the weaker half" when describing Linear. This does not reopen the ADR — Check A holds — but it does mean the ADR's per-repository, opt-in guarantee is additionally **plan-gated**, and that is not currently written down anywhere.

**Open product decision, carried to [build/10](../build/10-branch-protection-verification.md):** that ticket says refuse startup when a default branch is unprotected. Taken literally the product cannot run against free private repos at all. Three options — refuse and document GitHub Pro as a prerequisite; run degraded with a loud startup warning; or refuse only for private repos while allowing public. **Not decided here.**

### The preflight endpoint — answered

Two calls, and the second is the one that matters:

1. `GET /repos/{o}/{r}/rules/branches/{default_branch}` — returns **effective** rules and is *mechanism-agnostic*, so it covers classic protection and rulesets in one shape. Each entry carries `type` and a `ruleset_id`. Check for `pull_request` with `required_approving_review_count >= 1` and for `non_fast_forward`.
2. `GET /repos/{o}/{r}/rulesets/{ruleset_id}` — **bypass state is not on the `/rules` response.** This returns `bypass_actors` and, better, **`current_user_can_bypass`**, observed as `"never"`. That field answers preflight's real question — *can this token's own user bypass this rule?* — directly, without reasoning about actor lists.

So preflight should resolve rules on the default branch, then confirm `current_user_can_bypass == "never"` on each contributing ruleset. Verified rather than inferred.

### Cleanup state

Ruleset deleted (204), PR #1 closed, `test-head` deleted. Deletion of `shivsarthak/open-agent-protection-test` was attempted and **correctly refused (403)** — the token withholds `delete_repo` — so teardown is a human action via the web UI. Decision taken: the repo is **not** kept as a `build/10` fixture; that criterion will be re-verified against whatever repository the self-hoster configures.
