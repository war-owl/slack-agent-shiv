# 12 — The local checkout: branch push and pull request, both over the shell

**What to build:** The coworker does real repository work. A person delegates a code change; the coworker works in a local checkout where it can actually grep the codebase and run the tests, pushes a branch, and opens the pull request with `gh`. The pull request appears in the Thread's audit record.

**The seam this ticket used to be about is gone.** [ADR-0005](../../../docs/adr/0005-connectors-are-mcp-config.md) called *git for the filesystem, MCP for the pull request* a deliberate split; [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) withdrew the MCP half. Half the reasoning survives — a checkout still costs no new credentials, and no API can grep a codebase or run its tests — but the push and the pull request are now the same mechanism under the same installation token, so what remains is one path rather than two.

**Blocked by:** 09 — GitHub as a Skill over `gh`

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A local checkout is configured and the coworker works inside it
- [ ] The coworker can search the codebase and run its tests in the checkout
- [ ] A branch is pushed over git, authenticated through the **credential helper** from [build/09](09-github-connector.md) rather than by a token baked into the remote URL — a `x-access-token:<token>@github.com` remote embeds a credential that expires in an hour and strands the Job when it does
- [ ] A Job running well past one hour still pushes successfully at the end of it, with no human action and no visible expiry — the connect-and-forget requirement, tested here as well as in 09 because the checkout is where a stale embedded credential would bite
- [ ] The pull request is opened with `gh` and lands in the audit channel with a link
- [ ] Force-pushing to the protected default branch fails — and it is documented that this now confirms **less** than it used to. The same test previously showed the boundary holding against the shell *as well as* against the tool policy; with no tool policy left for GitHub, the shell is the only path and this is the only test of it
- [ ] Force-push to the coworker's own feature branches remains possible and is documented as accepted — losing one costs a redo
- [ ] The `pre-push` hook from [build/10](10-branch-protection-verification.md) is installed on every checkout this ticket creates, and it is restated that the hook is defence-in-depth rather than a boundary

## Notes

**Layer 2 is absent here, and that changes what this ticket proves.** When the pull request was opened over MCP, `merge_pull_request` was a deny-listed tool and the force-push test was the *second* line of evidence. Now the only controls on this path are branch protection — plan-gated and warn-only per build/10 — and the local hook, which `--no-verify` skips. A self-hoster whose default branch is unprotected has nothing structural stopping `gh pr merge` from the same shell that runs the tests. Say this in the setup story, not only here.
