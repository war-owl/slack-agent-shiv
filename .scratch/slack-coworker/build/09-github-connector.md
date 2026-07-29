# 09 — GitHub as a Skill over `gh`, on a GitHub App

**What to build:** The coworker can work with real GitHub data. A person asks it to look into a bug and it searches issues, reads the relevant pull requests, and comments — reaching GitHub through the `gh` CLI, following a human-authored Skill that says how, with a credential that reaches only the repositories the self-hoster picked at install time.

GitHub is **not** an MCP connector. [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) carved it out of [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md): repository selection had nowhere to live in the MCP shape, because outside the tool path nothing of ours can narrow what Codex calls. So the boundary moves entirely to the credential — a **GitHub App installation** scoped to selected repositories — and the procedure moves into a Skill.

**Blocked by:** 04 — Audit: every Write appended; 08 — Preflight; **15 — Skills** (this ticket *is* a Skill, so the Skills mechanism must exist first)

**Status:** ready-for-agent, *after the verification block below*

## Read this first: what this ticket gives up

The MCP shape is gone and so is [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md)'s **layer 2** — there is no tool surface to deny-list and no `tools/list` to pin. GitHub runs on layer 1 (policy in `AGENTS.md` and in the Skill) and layer 3 (branch protection), and [build/10](10-branch-protection-verification.md) makes layer 3 plan-gated and warn-only. **On a free-plan private repository the coworker therefore has no structural boundary on GitHub whatsoever** — `gh pr merge` is reachable and nothing but a sentence in a Markdown file discourages it.

That is the accepted cost of this shape, not an oversight. It is written into the ADR and it must reach the setup story ([build/13](13-setup-story.md)) in language a self-hoster cannot skim past. If it proves intolerable, the reopen path is a first-party MCP server we own — recorded in the ADR as the rejected option most likely to come back.

## Verify first — four assumptions, none measured

The project has never driven `gh` with an installation token. These are assumptions and the first task here is to settle them against a real App:

- **Does `gh` work with a GitHub App installation token at all?** `GH_TOKEN` accepts arbitrary tokens, but an installation token has **no user behind it** — anything resolving `/user` has nothing to resolve. Measure specifically: `gh issue list`, `gh issue comment`, `gh pr view`, `gh pr create`, and `gh search issues`. If `gh pr create` needs a user context, the PR path in [build/12](12-git-checkout-and-pull-request.md) needs `gh api` instead and the Skill must say so.
- **Does `gh search` reach the Search API on an installation token?** `/search/issues` is documented as accepting installation tokens, which is the fact that made this shape attractive — but that is the REST endpoint, not `gh`'s wrapper over it. Confirm the CLI path, not just the API path.
- **Does merge sit under `pull_requests: write`?** Load-bearing. Opening a pull request certainly needs `pull_requests: write`; if merge needs the same permission then the App **cannot** deny merge while permitting the coworker's job, and layer 3 stays the only control. If merge turns out to need `contents: write` alone, a genuinely merge-incapable installation is possible and ADR-0006 gets an amendment restoring the boundary to the credential. GitHub's endpoint docs do not surface the permission block — measure it by attempting a merge with a deliberately narrowed installation.
- **Does `gh` honour a credential helper the way `git` does?** The connect-and-forget requirement rests on it. `git` has `credential.helper`; whether `gh` can be made to call an external minter per invocation — rather than reading a static `GH_TOKEN` — is unverified and decides whether the helper design works for both halves or only for git. If `gh` insists on an environment variable, measure what it does when that variable holds an expired token, and whether re-reading it per invocation is enough.

## Acceptance criteria

### The credential

- [ ] Authentication is a **GitHub App**: the instance holds an App ID and private key, mints installation access tokens, and never holds a long-lived user token
- [ ] The App is installed against **selected repositories**, chosen in GitHub's own UI, and preflight reports the resolved list at startup so the self-hoster sees the actual reach rather than the intended one
- [ ] The token handed to a Job is narrowed to the repositories in play via `repositories` / `repository_ids` where that is narrower than the installation — a Job cannot widen its own reach by asking differently, and this is verified by a test that attempts a repository outside the set
- [ ] The App manifest declares `issues`, `pull_requests`, `contents`, and `metadata`, and **does not declare** `administration`, `members`, or `workflows` — the App-permission equivalents of the PAT scopes ADR-0002 withheld, with the reasoning for each exclusion carried over
- [ ] **Connect and forget: the self-hoster installs the App once and never touches GitHub authentication again** — no refresh to run, no scheduled rotation, no expiry to notice. This is a requirement and it outranks implementation convenience
- [ ] **A Job never holds a token.** A credential-helper script outside the sandbox's writable root mints one on demand; `git` reaches it via `credential.helper` and `gh` via the same script. Do **not** inject a token at Job start and refresh it in place — that design fails exactly when a long Job is most expensive to lose
- [ ] A Job running well past one hour completes GitHub work at the end of it without the coworker ever seeing a 401 — tested with a deliberately shortened token lifetime rather than by waiting an hour
- [ ] The helper is executable by the agent and **not editable** by it, verified by the same test shape build/15 uses for Skills — a credential minter the agent can rewrite is not a credential boundary
- [ ] Installation failure is loud: an App that is not installed, or an organisation that has not approved it, fails visibly at startup rather than degrading to public-only reads the way an unapproved PAT did

### The Skill

- [ ] A human-authored Skill states the procedure: which `gh` commands to use for reading, searching, and commenting, that the token is in the environment, and that merging is not the coworker's to do
- [ ] The Skill lives outside the sandbox's writable root per [build/15](15-skills.md), so the coworker follows it and cannot edit it — a Skill it could rewrite is a Skill that stops saying "do not merge"
- [ ] The Skill **names the environment variable and contains no credential**, per build/15's rule
- [ ] The coworker reaches the Skill by traversal from the Root note like any other Note, with no bespoke discovery path

### Reading, writing, and the record

- [ ] The coworker can read issues, pull requests, and code, and can **search** issues across the installed repositories
- [ ] Writes — commenting, opening a pull request, updating an issue — each appear in the Thread's audit channel naming the thing written and linking to it
- [ ] **A `gh` shim early on `PATH` records every invocation** for the audit channel to read, recovering most of what [build/04](04-audit-writes.md) loses when exact MCP tool calls become pattern-matched shell commands
- [ ] Documentation states that the shim is **audit, not a boundary** — `gh api`, `curl`, and the raw binary all go around it — in the same register build/10 uses for the `pre-push` hook
- [ ] A Write made by a means the shim did not see still produces a record, even a vague one, rather than silently producing none

### Choosing the repository

- [ ] The repository in play is worked out from the request; there is **no durable per-Thread binding**
- [ ] A human who sees it pick the wrong repository redirects it with a mention, and the coworker switches
- [ ] It is documented that this correction **queues at the Turn boundary** per [build/06](06-queue-at-turn-boundary.md) rather than interrupting — so "wrong repo" lands after the current Turn, which on this path is more likely to be exercised than build/06 anticipated
- [ ] A Job that cannot tell which repository is meant **asks in the Thread** instead of guessing

## Notes

**This ticket changes [build/15](15-skills.md)'s framing.** Its closing note said a Skill is not a connector and does not reopen ADR-0005. GitHub — the flagship connector — is now a Skill, so that note was wrong and has been corrected. The mechanism build/15 builds is load-bearing for real capability, not an escape hatch for odd cases.

**The two halves of this decision hold each other up.** build/15 already requires that anything reached by Skill have a genuinely scoped credential, because a Skill sits outside the tool path — it says a read-only database role is a requirement rather than a recommendation. The App installation scoped to selected repositories is exactly that requirement met for GitHub.
