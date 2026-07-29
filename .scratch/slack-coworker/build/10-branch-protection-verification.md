# 10 — Branch-protection verification

**What to build:** The coworker's inability to do irreversible things is enforced by the repository, not by its token — so the instance refuses to run against a repository where that enforcement is missing. A self-hoster who has not protected a default branch is told which repository and which setting, at startup, rather than finding out when something gets merged.

This is the third layer of the action boundary. It became per-repository and opt-in when fine-grained PATs were ruled out, so this check is the entire mitigation for that weakening — it is not a nicety and must not be dropped for convenience.

**Amended by [ADR-0007](../../../docs/adr/0007-github-is-an-official-mcp-server.md).**
GitHub is back in the MCP tool path, where `merge_pull_request` and `delete_file` are
disabled. Branch protection remains necessary because shell access and a leaked token can
bypass MCP entirely, but it is again the third of three layers.

**Blocked by:** 09 — GitHub through the official MCP server; and Checks A and B on [Provision a Slack app, a test workspace, and GitHub/Linear tokens](../issues/05-provision-accounts-and-tokens.md)

**Status:** ready-for-agent

- [x] Preflight verifies default-branch protection on every configured repository
- [x] **Startup is never refused for missing protection — it warns and continues.** *(Decided; supersedes the original "refuse" criterion.)* An unprotected or unprotectable repository produces a loud, specific startup warning naming the repository and the missing setting, and the instance runs. Rationale: Check B measured protection as unavailable on free-plan private repositories via *both* mechanisms, so refusing would lock out plausibly the modal self-hoster over a condition they cannot fix without paying. The guardrails carry the weight instead.
- [x] The warning distinguishes **unprotected** (fixable — tell them how) from **unprotectable** (`403 Upgrade to GitHub Pro`, not fixable on their plan — tell them what they are running without), because the remedy differs and a single generic message would be useless for both
- [x] The protection checked for is: require a pull request before merging, require at least one approving review, and disallow bypassing including for administrators
- [x] The check queries `GET /repos/{o}/{r}/rules/branches/{default_branch}` for effective rules — **settled by ticket 05**, and mechanism-agnostic, so classic protection and rulesets arrive in one shape
- [x] Bypass state is read separately via `GET /repos/{o}/{r}/rulesets/{ruleset_id}` and asserted as **`current_user_can_bypass == "never"`** — it is *not* present on the `/rules` response
- [x] Because startup is permitted without layer 3, the remaining guardrails are present:
  the MCP deny-list, the `pre-push` hook below, and the git-safety policy in `AGENTS.md`
- [x] Documentation states plainly that **the layer-2 substitutes are weaker than what they replace.** A deny-listed tool did not exist; a Skill that says "do not merge" is a sentence the model may disregard and a compromised issue comment may argue against. This is the most-weakened point in the whole action boundary and should be named as such rather than buried in a list
- [ ] A repo-managed `pre-push` hook is installed on every checkout the wrapper creates, blocking pushes to the default branch, non-fast-forwards, and remote deletions — **stdin-driven**, judging the destination ref and `git merge-base --is-ancestor`, never the command line. See [`research/local-git-enforcement.md`](../research/local-git-enforcement.md) for the tested script and the two ways the obvious version fails. **The installer and real-git matrix ship here; build/12 owns calling it for each checkout it creates.**
- [x] Documentation states plainly that the hook is **defence-in-depth, not a boundary** — `--no-verify`, `core.hooksPath`, an editable hook file under `workspace-write`, and `curl` to the merge endpoint all bypass it
- [x] Verified against a real repository: an attempt to merge to the protected default branch with the coworker's own token fails
- [x] Documentation states plainly that **Linear has no equivalent third layer** and runs
  on policy and the MCP deny-list alone

> ~~If wayfinder ticket 05 Check A finds that bypass-disabled protection does **not** bind a repository admin…~~ **Check A has run and passed** — a ruleset with `bypass_actors: []` blocks an admin's merge (`405`) and force-push (`GH013`). ADR-0002 does not reopen. What did change is Check B: protection is unavailable on free private repos via *either* mechanism. **Resolved by decision — the instance warns and runs rather than refusing**, on the grounds that a self-hoster should not be locked out by a paywall they cannot clear. The consequence is that this ticket's guardrails stop being belt-and-braces and become the actual mitigation.

## Comments

### Implementation

Preflight now takes repository names from `open-agent.config.json`, discovers each default
branch through GitHub, reads effective rules, and checks every contributing ruleset's
`current_user_can_bypass`. The HTTP adapter distinguishes the measured plan-gating message
from ordinary authorization failures: only the former degrades to a warning.

The hook installer writes an executable checkout-local hook and sets `core.hooksPath`.
A real bare-remote test covers `HEAD:main`, a `+refspec` non-fast-forward, deletion, and
ordinary new/fast-forward feature pushes. It is intentionally not invoked yet because the
wrapper does not create checkouts until build/12; that ticket owns the single remaining
criterion rather than this layer inventing a second checkout lifecycle.

Live read-only verification against `shivsarthak/slack-agent` found `main` unprotected and
named all three missing requirements. The historical destructive verification remains Check
A on ticket 05; it is not repeated against a non-throwaway repository.
