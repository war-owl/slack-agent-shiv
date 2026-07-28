# 12 — Git for the filesystem, MCP for the pull request

**What to build:** The coworker does real repository work. A person delegates a code change; the coworker works in a local checkout where it can actually grep the codebase and run the tests, pushes a branch over git, and opens the pull request over MCP. The pull request appears in the Thread's audit record.

The seam is deliberate: a checkout costs no new credentials, and the API can neither grep nor run tests.

**Blocked by:** 09 — GitHub connector

**Status:** ready-for-agent

- [ ] A local checkout is configured and the coworker works inside it
- [ ] The coworker can search the codebase and run its tests in the checkout
- [ ] A branch is pushed over git, authenticated with the same token
- [ ] The pull request is opened over MCP, not over git, and lands in the audit channel with a link
- [ ] Force-pushing to the protected default branch fails, confirming the boundary holds against the shell and not only against the tool policy
- [ ] Force-push to the coworker's own feature branches remains possible and is documented as accepted — losing one costs a redo
