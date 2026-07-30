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

- [x] A local checkout is configured and the coworker works inside it
- [x] The coworker can search the codebase and run its tests in the checkout
- [x] Git authentication uses the fine-grained token without embedding it in the remote URL
- [x] A feature branch is pushed over git and produces a permanent audit record
- [x] A pull request is opened through `create_pull_request` on the official GitHub MCP
  server and produces an exact MCP audit record with a link
- [x] Force-pushing to the protected default branch fails
- [x] Force-push to the coworker's own feature branches remains possible and is documented
  as accepted
- [x] The `pre-push` hook from [build/10](10-branch-protection-verification.md) is installed
  on every checkout and documented as defense-in-depth rather than a boundary

## Notes

Layer 2 covers the MCP pull-request path: `merge_pull_request` and `delete_file` are
disabled. Git itself remains a shell path, so the local hook and branch protection cover a
different failure surface. The hook is bypassable with `--no-verify`; branch protection is
the server-side control.

## Comments

**Implemented 2026-07-30.** Configuring `owner/repository` makes an on-demand checkout
command available in each Thread workspace. The prompt lists the repositories but explicitly
reserves the command for tasks that need local code search, edits, or tests. A normal
conversation performs no Git operation; a code task selects exactly one repository, and
only then is it cloned or fetched.

Once materialized, the checkout persists under that Thread's workspace. This is deliberately
not one checkout shared by the instance: Jobs in different Threads run concurrently, while
Jobs in one Thread are sequential and need follow-ups to find the branch and files already
there. A later checkout request fetches without resetting or discarding that Thread's work.

The canonical HTTPS remote contains no credential. A checkout-local helper reads the bearer
variable already named by the enabled GitHub MCP entry and supplies the fine-grained token
only when Git asks for `github.com`; its file contains the variable name, never the value.
Both that helper and the stdin-driven `pre-push` hook are re-imposed before each Job because
they sit in a workspace the agent can edit.

The top seam drives synthetic mentions against real bare Git remotes. One ordinary
conversation asserts that no repository directory exists afterwards. A code Job invokes the
on-demand command, reads the code, runs its test, commits, pushes a feature branch, and emits
the official server's `create_pull_request` event. With two configured repositories another
test asserts only the selected one materializes. The Thread receives two permanent records
in order: the git push and the exact linked MCP result. The real-git matrix also proves the
hook blocks `HEAD:main`, forced non-fast-forwards, and deletion, while `--no-verify`
demonstrates the accepted residual ability to replace the coworker's own feature branch.
