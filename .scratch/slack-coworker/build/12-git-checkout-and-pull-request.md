# 12 — Local checkout, branch push, and MCP pull request

**What to build:** The coworker works in a local checkout where it can grep and run tests,
pushes a feature branch with git, and opens the pull request through GitHub's official MCP
server. The push and pull request appear in the Thread's audit record.

**The seam is restored by
[ADR-0007](../../../docs/adr/0007-github-is-an-official-mcp-server.md):** git owns the
filesystem and branch push; GitHub MCP owns repository metadata and pull-request creation.

**Blocked by:** 09 — GitHub through the official MCP server

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A local checkout is configured and the coworker works inside it
- [ ] The coworker can search the codebase and run its tests in the checkout
- [ ] Git authentication uses the fine-grained token without embedding it in the remote URL
- [ ] A feature branch is pushed over git and produces a permanent audit record
- [ ] A pull request is opened through `create_pull_request` on the official GitHub MCP
  server and produces an exact MCP audit record with a link
- [ ] Force-pushing to the protected default branch fails
- [ ] Force-push to the coworker's own feature branches remains possible and is documented
  as accepted
- [ ] The `pre-push` hook from [build/10](10-branch-protection-verification.md) is installed
  on every checkout and documented as defense-in-depth rather than a boundary

## Notes

Layer 2 covers the MCP pull-request path: `merge_pull_request` and `delete_file` are
disabled. Git itself remains a shell path, so the local hook and branch protection cover a
different failure surface. The hook is bypassable with `--no-verify`; branch protection is
the server-side control.
