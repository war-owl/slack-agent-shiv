---
status: superseded
superseded_by: 0007-github-is-an-official-mcp-server.md
---

# GitHub is a Skill over `gh`, authenticated by a GitHub App

This decision was superseded by
[ADR-0007](0007-github-is-an-official-mcp-server.md) before its runtime path was built.

The design introduced a special GitHub App probe, installation-token minting, a future
credential helper, a GitHub Skill, a `gh` audit shim, and special preflight behavior. It
successfully narrowed repository access at the credential, but duplicated connector
machinery while the project already had a generic MCP seam. At supersession time only the
startup probe existed; Jobs still had no App-backed authentication for real GitHub work.

The durable lesson is retained: repository scope belongs in the credential, and branch
protection is the server-side merge boundary. The implementation now obtains repository
scope from a fine-grained token and uses GitHub's official MCP server.
