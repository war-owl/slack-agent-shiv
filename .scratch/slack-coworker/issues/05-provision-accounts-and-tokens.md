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

- A **Slack test workspace and app** (manifest, scopes, install, `xapp-`/`xoxb-` tokens) — nothing else has been done here.
- A **fine-grained GitHub PAT** to close Check 1.
- The **org-approval trap** — untested; needs a fine-grained PAT against an org repo.
- **Codex auth mode** for an always-on bot — untested.

## Blocking check added by ticket 12

**Can a GitHub fine-grained PAT grant pull-request write *without* merge rights?**

[ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) makes the credential the security boundary — the agent has shell access, so `gh api -X PUT …/pulls/N/merge` bypasses any MCP tool policy. The entire safety model rests on the token being *unable* to merge.

Test it: create a fine-grained PAT with `Pull requests: write` on a throwaway repo, open a PR, and attempt `PUT /repos/{o}/{r}/pulls/{n}/merge`. A 403 confirms the model; a 200 breaks it.

**If it returns 200, ticket 12 reopens** and must choose between sandbox egress allow-listing, withholding the credential from the shell, or accepting the bypass explicitly. Do not build against ADR-0002 until this is known.

While that token exists, it also closes the original Check 1 (whether a fine-grained PAT can use the Search API) and the org-approval trap check — same token, same sitting.
