# The real integration surface for GitHub and Linear

Research for the Slack coworker map, ticket `03-github-linear-surface-research`.
Date of research: 2026-07-28. Everything below is from first-party sources: `docs.github.com`,
the `github/github-mcp-server` repository, `linear.app/docs`, `linear.app/developers`, the
`linear/linear` SDK repository (which contains Linear's published GraphQL schema), the
Model Context Protocol specification, and live protocol probes against the two hosted
endpoints. Where I could not establish something from a primary source, it is called out
explicitly rather than inferred.

Two artefacts were pinned for exactness:

- `github/github-mcp-server` @ `eb088df` (2026-07-23) — <https://github.com/github/github-mcp-server>
- `linear/linear` @ 2026-07-22 release commit, `packages/sdk/src/schema.graphql` (49,840 lines) —
  <https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql>

---

## 0. Executive summary

| | GitHub | Linear |
|---|---|---|
| Official MCP server | Yes — both hosted **and** self-runnable | Yes — hosted only |
| Source available | Yes, MIT, Go (`github/github-mcp-server`) | No. Closed-source, centrally hosted |
| Endpoint | `https://api.githubcopilot.com/mcp/` | `https://mcp.linear.app/mcp` |
| Transport | Streamable HTTP (remote); stdio (local binary/Docker) | Streamable HTTP; deprecated SSE at `/sse` |
| Tool inventory published | **Yes**, exhaustively, with parameters, in the README | **No**. Prose capability statements only |
| Read-only mode | `/readonly` path, `X-MCP-Readonly` header, `--read-only` flag | `/mcp/readonly` path, or request only the `read` scope |
| Simplest working credential | One PAT in an env var | One personal API key in an env var |
| Long-lived credential exists | Yes (classic PAT, or fine-grained PAT with long/no expiry) | Yes (personal API key, no documented expiry) |
| Fallback API | REST **and** GraphQL | GraphQL only |

The headline: **both connectors can be MCP-only in v1, and both can be driven by a single
static token that a self-hoster pastes into a config file.** Neither requires you to
register an OAuth application, stand up a callback server, or implement token refresh —
provided you accept the "acts as a human user" identity model. The interesting design
pressure is not availability; it is *shape* (§6).

Two findings that will surprise:

- **A GitHub fine-grained PAT cannot call the Search API** (except `/search/labels`), which
  kills six of the GitHub MCP server's tools including `search_issues`. Verified against
  GitHub's own docs dataset and the MCP server's source. §2.1.
- **Linear publishes no tool inventory for its MCP server.** Only five tool names are
  first-party confirmed, and those from changelog bug-fix notes. §1.2.

---

## 1. MCP servers

### 1.1 GitHub

GitHub publishes an official MCP server, open source under MIT, in Go, at
<https://github.com/github/github-mcp-server>. It is available in two deployment modes,
built from the same codebase.

**Remote (hosted).** URL `https://api.githubcopilot.com/mcp/`, Streamable HTTP.
> "**URL:** https://api.githubcopilot.com/mcp/" — [`docs/remote-server.md`](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)

> "The remote GitHub MCP server is built using this repository as a library, and binding it into GitHub server infrastructure with an internal repository." — same file

A live probe confirms it is a spec-compliant OAuth 2.1 protected resource:

```
$ curl -X POST https://api.githubcopilot.com/mcp/ -d '{"jsonrpc":"2.0",...,"method":"initialize"}'
HTTP/2 401
www-authenticate: Bearer error="invalid_request",
  error_description="No access token was provided in this request",
  resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"
```

```json
// GET https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp
{"resource":"https://api.githubcopilot.com/mcp",
 "authorization_servers":["https://github.com/login/oauth"],
 "scopes_supported":["repo","read:org","read:user","user:email","read:packages",
   "write:packages","read:project","project","gist","notifications","workflow","codespace"],
 "bearer_methods_supported":["header"],
 "resource_name":"GitHub MCP Server"}
```

That `scopes_supported` array is the authoritative list of classic OAuth scopes the hosted
server understands.

**Local (stdio).** Docker image `ghcr.io/github/github-mcp-server`, or a Go binary from
releases, run as `github-mcp-server stdio`. Authentication is a PAT via
`GITHUB_PERSONAL_ACCESS_TOKEN`, an interactive OAuth login, or GitHub App credentials
(§2.1). There is also an `http` subcommand documented in
[`docs/streamable-http.md`](https://github.com/github/github-mcp-server/blob/main/docs/streamable-http.md).

**Toolsets.** Tools are grouped into toolsets, selectable by env var (`GITHUB_TOOLSETS`),
flag (`--toolsets`), URL path (`/x/{toolset}`), or header (`X-MCP-Toolsets`). The default
toolset is:

> "The default configuration is: context, repos, issues, pull_requests, users" — [README](https://github.com/github/github-mcp-server/blob/main/README.md#default-toolset)

Counting the README's own tool listing at commit `eb088df`: **86 tools total**, of which the
default toolset is **42** (context 3, repos 19, issues 9, pull_requests 10, users 1). The
full toolset list is: `context`, `actions`, `code_quality`, `code_security`, `copilot`,
`copilot_issue_intents`, `dependabot`, `discussions`, `gists`, `git`, `issues`, `labels`,
`notifications`, `orgs`, `projects`, `pull_requests`, `repos`, `secret_protection`,
`security_advisories`, `stargazers`, `users`, plus remote-only `copilot_spaces` and
`github_support_docs_search`.

**Concrete tool inventory for the operations a coworker needs.** All quoted from the
[README's Tools section](https://github.com/github/github-mcp-server/blob/main/README.md#tools);
"Required OAuth Scopes" annotations are the README's own.

*Issues* (toolset `issues`, 9 tools):

| Tool | What it does | Notable parameters |
|---|---|---|
| `issue_read` | "Get issue details" | `method`: `get` / `get_comments` / `get_sub_issues` / `get_parent` / `get_labels` |
| `issue_write` | "Create or update issue/pull request" | `method`: `create` / `update`; `title`, `body`, `assignees[]`, `labels[]`, `milestone`, `state`, `state_reason`, `type`, `issue_fields[]`, `duplicate_of` |
| `add_issue_comment` | "Add comment to issue or pull request" | `issue_number`, `body`, or `reaction` + `comment_id` |
| `list_issues` | "List issues" | `labels[]`, `state`, `since` (ISO 8601), `orderBy`+`direction`, `field_filters[]`, cursor pagination via `after` |
| `search_issues` | "Search issues" | `query` — "Search query using GitHub issues search syntax"; optional `owner`/`repo` narrowing |
| `sub_issue_write` | "Change sub-issue" | `method`: `add` / `remove` / `reprioritize`; `replace_parent`; uses `sub_issue_id` (an **id**, not a number) |
| `list_issue_types` | org-level issue types | |
| `list_issue_fields` | org/repo custom issue fields | |
| `get_label` | single label lookup | |

*Pull requests* (toolset `pull_requests`, 10 tools):

| Tool | What it does |
|---|---|
| `create_pull_request` | "Open new pull request" — `head`, `base`, `title`, `body`, `draft`, `reviewers[]`, `maintainer_can_modify` |
| `pull_request_read` | 9 methods: `get`, `get_diff`, `get_status`, `get_files`, `get_commits`, `get_review_comments`, `get_reviews`, `get_comments`, `get_check_runs` |
| `update_pull_request` | "Edit pull request" |
| `update_pull_request_branch` | rebase/update PR branch |
| `merge_pull_request` | with `merge_method` |
| `pull_request_review_write` | create/submit/delete reviews; also `resolve_thread` / `unresolve_thread` via `threadId` |
| `add_comment_to_pending_review` | line-level review comment on the requester's pending review |
| `add_reply_to_pull_request_comment` | threaded reply to a review comment |
| `list_pull_requests` | filter by `state`, `base`, `head`, sort |
| `search_pull_requests` | GitHub PR search syntax |

*Repos* (toolset `repos`, 19 tools) — the ones that matter for code work:
`get_file_contents`, `get_repository_tree` (with `recursive` and `path_filter`),
`list_branches`, `create_branch`, `create_or_update_file`, `push_files` ("Array of file
objects to push, each object with path (string) and content (string)"), `delete_file`,
`list_commits`, `get_commit`, `search_code`, `search_commits`, `search_repositories`,
`fork_repository`, `create_repository`, `list_repository_collaborators`, releases/tags tools.

*Projects* (toolset `projects`, 3 tools): `projects_get`, `projects_list`, `projects_write`.
`projects_write` covers `create_project`, `add_project_item`, `update_project_item`,
`delete_project_item`, `create_project_status_update`, `create_iteration_field`. Field
values are set with `updated_field` — `{"name": "Status", "value": "In Progress"}`.
Required scopes: `read:project` for reads, `project` for writes.

*Context* (toolset `context`, 3 tools): `get_me`, `get_teams`, `get_team_members`.
The README calls this toolset "**Strongly recommended**".

**Read-only and lockdown.** `--read-only` / `GITHUB_READ_ONLY=1` / `/readonly` path /
`X-MCP-Readonly` header restrict to read tools. Separately, **lockdown mode**
(`--lockdown-mode`, `GITHUB_LOCKDOWN_MODE`, `X-MCP-Lockdown`) is a prompt-injection
mitigation: it "limits the content that the server will surface from public repositories…
the server checks whether the author of each item has push access". `issue_read:get` and
`pull_request_read:get` error out for untrusted authors; comment-listing methods filter
them. For an agent that reads arbitrary public issues, this is a relevant safety knob.

### 1.2 Linear

Linear publishes a **hosted-only, closed-source** MCP server.

> "Our MCP server uses Streamable HTTP as the primary transport, accessible at the following address."
> — [linear.app/docs/mcp](https://linear.app/docs/mcp)

- Read-write: `https://mcp.linear.app/mcp`
- Read-only: `https://mcp.linear.app/mcp/readonly` — "which only ever exposes read tools"
- Deprecated SSE fallback: `https://mcp.linear.app/sse` — "a deprecated fallback for clients
  that do not support Streamable HTTP. For all new setups, use the primary Streamable HTTP
  endpoint"

Both remotes are also registered in the official MCP registry under the Linear-owned name
`app.linear/linear`
(`GET https://registry.modelcontextprotocol.io/v0/servers?search=linear`), listing
`{"type":"sse","url":"https://mcp.linear.app/sse"}` and
`{"type":"streamable-http","url":"https://mcp.linear.app/mcp"}`.

A live probe confirms full MCP-spec OAuth compliance:

```
$ curl -X POST https://mcp.linear.app/mcp -d '{"jsonrpc":"2.0",...,"method":"initialize"}'
HTTP/2 401
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
  error="invalid_token"
```

```json
// /.well-known/oauth-protected-resource/mcp
{"resource":"https://mcp.linear.app/mcp","authorization_servers":["https://mcp.linear.app"],
 "scopes_supported":["read","write"],"bearer_methods_supported":["header"]}

// /.well-known/oauth-protected-resource/mcp/readonly
{"resource":"https://mcp.linear.app/mcp/readonly","authorization_servers":["https://mcp.linear.app"],
 "scopes_supported":["read"],"bearer_methods_supported":["header"]}

// /.well-known/oauth-authorization-server
{"issuer":"https://mcp.linear.app",
 "authorization_endpoint":"https://mcp.linear.app/authorize",
 "token_endpoint":"https://mcp.linear.app/token",
 "registration_endpoint":"https://mcp.linear.app/register",
 "scopes_supported":["read","write","openid","email"],
 "grant_types_supported":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],
 "code_challenge_methods_supported":["S256"],
 "revocation_endpoint":"https://mcp.linear.app/token",
 "client_id_metadata_document_supported":true}
```

Note this is a *separate* authorization server from Linear's normal OAuth
(`https://linear.app/oauth/authorize` — §2.2), fronted at `mcp.linear.app`, with dynamic
client registration enabled (`/register`), which is what lets `codex mcp login linear`
work with no app registration by the self-hoster.

**Tool inventory — Linear does not publish one.** This is a real gap and I want to be
unambiguous about it. The only first-party capability statement is:

> "The Linear MCP server has tools available for finding, creating, and updating objects in
> Linear like issues, projects, and comments — with more functionality on the way."
> — [linear.app/docs/mcp](https://linear.app/docs/mcp)

I checked and found no enumeration at: `linear.app/docs/mcp` (and its `.md` variant),
`linear.app/developers/*` (there is **no** MCP page there — `/developers/mcp` returns 404),
the MCP launch changelog
[2025-05-01-mcp](https://linear.app/changelog/2025-05-01-mcp), the expansion changelog
[2026-02-05-linear-mcp-for-product-management](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management),
Linear's GitHub org (no MCP repo), and the MCP registry entry.

What *is* first-party evidence of specific tool names: Linear's changelog release notes
mention tools by name when fixing them. Scraping <https://linear.app/changelog> yields these
confirmed identifiers:

- `save_issue` — "Links added through `save_issue` now go through the integration-aware
  `attachmentLinkURL` path…"
- `save_project` — "`save_project` no longer accepts issue-level label IDs, and label arrays
  sent as JSON strings are parsed instead of silently wiping existing labels"
- `save_document` — "Added initiative and cycle parameters to the `save_document` tool to
  create or reparent documents under an initiative or cycle"
- `list_comments` — "`list_comments` now returns comments on archived issues"; and
  separately, pagination support "via cursor, limit, and orderBy parameters"
- `save_customer_need` — "Added source URL support to the `save_customer_need` tool"

Plus prose-only capabilities from the Feb 2026 changelog: "Create and edit initiatives /
Create and edit initiative updates / Create and edit project milestones / Create and edit
project updates / Manage project labels / Support for loading images", and from a July 2026
entry: "Added read-only MCP tools for listing and retrieving Linear Agent skills" and
"Added support for managing releases, release notes, and release issue associations through
the MCP server".

The naming convention visible here is a **`save_*` upsert** pattern (create-or-update in one
tool) plus `list_*` / `get_*` readers — structurally similar to GitHub's `issue_write` /
`issue_read` consolidation but with different verbs.

**Unverified.** Web search surfaces `list_issues`, `get_issue`, `list_projects`,
`get_project`, `list_users` attributed to Linear docs, but I could not locate the
first-party page that states them and I am not treating them as established. **The
authoritative way to obtain the list is to authenticate a client and call `tools/list`.**
This is a genuine build-time action item: before finalising the connector interface, run
`codex mcp login linear` (or a raw Streamable HTTP client with an API key) and capture the
`tools/list` response.

### 1.3 Both are Codex-ready

Codex CLI supports stdio and Streamable HTTP MCP servers, configured in `~/.codex/config.toml`
([developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp), now redirecting to
<https://learn.chatgpt.com/docs/extend/mcp?surface=cli>). HTTP keys: `url` (required),
`bearer_token_env_var`, `http_headers`, `env_http_headers`, `auth` (`oauth` or `chatgpt`).
Universal keys: `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60),
`enabled_tools` (allow list), `disabled_tools` (deny list). `codex mcp login <server>` runs
the OAuth flow.

Both vendors ship Codex-specific setup instructions:

GitHub —
[`docs/installation-guides/install-codex.md`](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-codex.md):
```toml
[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_PAT_TOKEN"
```
> "The `--bearer-token-env-var` option is required for PAT-authenticated access to the hosted GitHub MCP server."

Linear — [linear.app/docs/mcp](https://linear.app/docs/mcp):
```toml
[features]
experimental_use_rmcp_client = true
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
```
> "Note: If this is the first time you are using an MCP in Codex you will need to enable the
> `rmcp` feature for this to work."
Then `codex mcp login linear`.

The `enabled_tools` / `disabled_tools` keys are worth noting for the connector design: the
default GitHub toolset alone is 42 tools, and Codex lets you prune per-server without a
custom proxy.

---

## 2. Auth

### 2.1 GitHub

**Credential types.**

| Type | Prefix | Expiry | Refresh | Fit for a single-user self-hosted agent |
|---|---|---|---|---|
| Classic PAT | `ghp_` | Optional; "**Personal access tokens (classic) do not have an expiration requirement**" ([org PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization#enforcing-a-maximum-lifetime-policy-for-personal-access-tokens)) | none | Works, but grants access to every repo you can access |
| Fine-grained PAT | `github_pat_` | Optional; infinite allowed unless policy blocks; explicit max 366 days | none | **Best default** — with one serious caveat (Search, below) |
| GitHub App installation token | `ghs_` | **1 hour** | re-mint from a JWT | Best for true unattended longevity; acts as the *app* |
| GitHub App user access token | `ghu_` | **8 hours** by default | refresh token valid **6 months** | Good if activity must be attributed to you; needs durable storage |
| OAuth App token | `gho_` | "OAuth app tokens do not expire until the person who authorized the OAuth App revokes the token" | n/a | GitHub recommends a GitHub App instead |
| `GITHUB_TOKEN` | — | job end; max 24h refresh | n/a | Actions-only; not applicable |

Prefix table: [About authentication to GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#githubs-token-formats).
GitHub's own steer: "Personal access tokens are intended to access GitHub resources on behalf
of yourself… **for long-lived integrations, you should use a GitHub App**"
([Managing your PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#about-personal-access-tokens)).
There is a **limit of 50 fine-grained PATs per user** (same page).

**Least-privilege, fine-grained PAT.** Permission slugs and UI names from the
[repository permissions table](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#repository-permissions);
per-endpoint levels from
[Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and its generating dataset `github/docs → src/github-apps/data/fpt-2022-11-28/fine-grained-pat-permissions.json`.

*(a) Read-only:*

| Capability | Permission |
|---|---|
| List/get issues, issue comments, timeline, labels | **Issues: Read** |
| List/get PRs, changed files, commits, reviews, review comments | **Pull requests: Read** |
| Read file contents, branches, commits | **Contents: Read** |
| `GET /repos/{owner}/{repo}`, collaborators, topics, tags | **Metadata: Read** |

*(b) Read + write / comment / PR creation:*

| Capability | Permission |
|---|---|
| Create / update an issue | **Issues: Write** |
| Comment on an issue | **Issues: Write** |
| Comment on a PR (goes through the *issues* comment endpoint) | **Pull requests: Write** (endpoint accepts either) |
| PR reviews, review comments, request reviewers | **Pull requests: Write** |
| **Create a pull request** (`POST /repos/{o}/{r}/pulls`) | **Pull requests: Write** — and *only* that, per the docs dataset (`additional-permissions: false`) |
| Create/update/delete files via API; create/update branch refs; merge a PR | **Contents: Write** |
| `git push` over HTTPS | **Contents: Write** |
| Edit `.github/workflows/*` | **Workflows: Write** (separate) |

So the working v1 token is: **Metadata: Read + Issues: Read and write + Pull requests: Read and
write + Contents: Read and write**, scoped to selected repositories.

Two notes on the PR-creation question. The API call itself needs only **Pull requests: Write** —
but a PR needs a head branch with commits on it, and creating/pushing that branch needs
**Contents: Write**. GitHub's own pre-filled token template for *"Update code and open a pull
request"* sets `&contents=write&pull_requests=write&workflows=write`
([URL parameters](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters)).

On **Metadata: Read** being mandatory: it is the only repository permission with no write level,
and the docs' URL-parameter example says of `...&contents=read` — "Try the URL to create a token
with **`contents:read` and `metadata:read`**", i.e. GitHub adds it automatically. *I could not
find an explicit sentence saying it cannot be deselected*; treat "always on" as
observed-and-UI-enforced rather than doc-stated.

**⚠️ The Search gap — the most consequential finding in this section.**

**A fine-grained PAT can call exactly one Search endpoint: `GET /search/labels`.** The other
six — `/search/issues`, `/search/code`, `/search/repositories`, `/search/commits`,
`/search/topics`, `/search/users` — are not available to it.

Source: [Endpoints available for fine-grained PATs](https://docs.github.com/en/rest/authentication/endpoints-available-for-fine-grained-personal-access-tokens),
verified directly against the dataset that generates it:

```
$ curl .../github/docs/main/src/github-apps/data/fpt-2022-11-28/fine-grained-pat.json
search -> ['search-labels']

$ ... /user-to-server-rest.json
search -> ['search-code','search-commits','search-issues-and-pull-requests','search-labels',
           'search-repositories','search-topics','search-users']

$ ... /server-to-server-rest.json     # installation tokens
search -> [same seven]
```

**This directly breaks GitHub MCP tools.** I checked the server's implementation: its search
tools call go-github's REST search client, not GraphQL.

- `search_issues` → `pkg/github/issues.go:1975` — `client.Search.Issues`
- `search_pull_requests` → `pkg/github/search_utils.go:155` — `client.Search.Issues`
- `search_repositories` → `pkg/github/search.go:96` — `client.Search.Repositories`
- `search_code` → `pkg/github/search.go:301` — `client.Search.Code`
- `search_users` / `search_orgs` → `pkg/github/search.go:421` — `client.Search.Users`
- `search_commits` → `pkg/github/search.go:626` — `client.Search.Commits`

With a fine-grained PAT, **six MCP tools are dead**, including `search_issues` — which is the
natural way to answer "what's assigned to me across the org". A classic PAT with `repo` works;
a GitHub App token works; a fine-grained PAT does not. GitHub's GraphQL `search` connection may
be a workaround, but GitHub only says "test your app to ensure it has the required permissions
for the GraphQL queries you want to make"
([choosing permissions for GraphQL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-graphql-api-access))
— **I could not confirm from documentation whether GraphQL `search` works for fine-grained
PATs. Test empirically.**

**Classic PAT scopes.** Reference:
[Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes).
There is **no read-only scope for private repositories**. Options are `public_repo`
("Limits access to public repositories. That includes **read/write** access…"), `repo`, and
`read:org`. The read tier and the write tier collapse into the same scope.

> `repo` — "Grants **full access to public and private repositories** including read and write
> access to code, commit statuses, repository invitations, collaborators, deployment statuses,
> and repository webhooks."

> "Your personal access token (classic) **can access every repository that you can access**."
> — [Creating a PAT (classic)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic)

For an agent this is the decisive argument against classic PATs: there is no way to say
"read-only" or "these three repos". The GitHub MCP server does at least mitigate the *tool*
surface — it reads `X-OAuth-Scopes` from a classic PAT at startup and hides tools the token
cannot use ("**Note:** This feature applies to **classic PATs** (tokens starting with `ghp_`).
Fine-grained PATs, GitHub App installation tokens, and server-to-server tokens don't support
scope detection and show all tools" —
[`docs/scope-filtering.md`](https://github.com/github/github-mcp-server/blob/main/docs/scope-filtering.md)).
That is tool hygiene, not access control.

**⚠️ Organization approval — the biggest self-hoster onboarding trap.**

> "**Require administrator approval** — An organization owner must approve each fine-grained
> personal access token that can access the organization… **This is the default value.**"
> — [Setting a PAT policy for your organization](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization#enforcing-an-approval-policy-for-fine-grained-personal-access-tokens)

> "If you selected an organization as the resource owner and the organization requires approval
> for fine-grained PATs, then your token will be marked as **`pending`** until it is reviewed by
> an organization administrator. Your token will only be able to **read public resources** until
> it is approved."
> — [Creating a fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

The failure mode is nasty for an agent: it authenticates successfully and then 403/404s on every
private call. And perversely, "**Only fine-grained personal access tokens, not personal access
tokens (classic), are subject to approval**" — the less secure credential has less friction,
which is exactly why users reach for it. SAML SSO adds a third, separate authorization step:
"To use a personal access token or SSH key to access resources owned by an organization that
uses SAML single sign-on, **you must also authorize** the personal token or SSH key"
([About authentication to GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#authorizing-for-saml-single-sign-on)).

**Local-server auth alternatives.** The self-runnable server supports three modes, exactly one at
a time, and a PAT always wins:

- **PAT** — `GITHUB_PERSONAL_ACCESS_TOKEN`. "A static token still takes precedence: if
  `GITHUB_PERSONAL_ACCESS_TOKEN` is set, the server uses it and skips OAuth entirely."
  ([`docs/oauth-login.md`](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md))
- **OAuth login** — authorization code + PKCE with a loopback callback, or a device-code fallback
  for headless runs; the token is kept "**in memory only** — nothing is written to disk". Official
  builds ship a baked-in OAuth app so github.com needs no client ID. Notably: "GitHub App tokens
  that expire are refreshed transparently using the refresh token, so long-running sessions keep
  working without re-authorizing." Also supports `--oauth-scopes`, which both narrows the grant
  *and* filters the exposed tool list to match.
- **GitHub App** — `--app-id`, `--app-installation-id`, `--app-private-key-path`. "It signs a
  short-lived JWT with the app's private key, exchanges it for an installation access token, and
  **refreshes the token before it expires**." This is the only fully non-interactive,
  self-renewing mode. Not available for the `http` command.
  ([`docs/github-app-auth.md`](https://github.com/github/github-mcp-server/blob/main/docs/github-app-auth.md))

**Plan requirements.** "The GitHub MCP server is available to all GitHub users regardless of plan
type", but "tools that interact with Copilot Cloud Agent require a paid Copilot license", and org
users need the "MCP servers in Copilot" policy enabled to use MCP with Copilot
([Setting up the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server)).
Enterprise Managed Users have PATs disabled by default. The hosted remote server is GHEC-only for
enterprise deployments: "Currently available only on GitHub Enterprise Cloud (GHEC). Remote hosting
for GHES is not supported at this time."
([`docs/policies-and-governance.md`](https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md))

**Rate limits.** REST: unauthenticated 60/hr; **PAT (either type) 5,000/hr**; installation tokens
5,000/hr scaling to 12,500 (15,000 for GHEC orgs); `GITHUB_TOKEN` 1,000/hr per repo. GraphQL:
5,000 points/hr per user. Critically, **all credentials on one account share one 5,000/hr pool** —
"if an app with a 15,000 request limit makes 10,000 requests on your behalf, you will have
exhausted the 5,000 request budget for your personal access tokens"
([Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-authenticated-users)).
Your agent competes with your IDE, `gh`, and Copilot.

Secondary limits matter more for a commenting agent: max 100 concurrent requests; 900
points/minute per REST endpoint; 90s CPU per 60s wall; and **"no more than 80 content-generating
requests per minute and 500 per hour"** — that last one is what an agent posting comments in a
loop will hit first. Point costs: GET = 1, POST/PATCH/PUT/DELETE = **5**; GraphQL query 1,
mutation 5. Headers: `x-ratelimit-{limit,remaining,used,reset,resource}`, plus `retry-after` on
secondary violations. Prescribed behaviour: honour `retry-after`; otherwise wait at least one
minute and back off exponentially.

**Git over HTTPS.** A PAT is the password:

> "Once you have a personal access token, you can enter it instead of your password when
> performing Git operations over HTTPS… When prompted for your password, enter your personal
> access token instead of a password."
> — [Using a PAT on the command line](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#using-a-personal-access-token-on-the-command-line)

The permission is **Contents** (Read to clone/fetch, Write to push): GitHub's own token templates
are *"Push access to repositories"* → `?...&contents=write` and *"Read repository contents"* →
`?...&contents=read`. Classic equivalent: "To use your token to access repositories from the
command line, select **`repo`**." For unattended use, inject the token via a credential helper or
`GIT_ASKPASS` — the docs warn "Don't pass your personal access token as plain text in the command
line."

**SSH deploy keys** are an alternative for git only, and a poor one here. Per
[Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys):
"Deploy keys only grant access to a **single repository**"; they are "usually **not protected by
a passphrase**"; they "**don't have an expiry date**"; they "**aren't linked directly to
organization membership**"; and "Deploy keys with write access can perform the same actions as an
organization member with admin access". Decisively for this project: **a deploy key cannot call
the REST or GraphQL API at all**, so it can never be the single credential — it would only ever
be a second one. A fine-grained PAT with Contents: Write covers both git and API in one.

### 2.2 Linear

**Personal API key — the minimum credential.**

> "For personal scripts API keys are the easiest way to access the API. Visit Security &
> access settings to create and manage them." — [linear.app/developers/graphql](https://linear.app/developers/graphql)

Created at Settings → Account → Security & Access (<https://linear.app/settings/account/security>).

**The header format is a trap**: Linear API keys go in `Authorization` with **no `Bearer`
prefix** for the GraphQL API. Verbatim from
[linear.app/developers/graphql](https://linear.app/developers/graphql):

```sh
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: <Replace this with your API Key>" \
  --data '{ "query": "{ issues { nodes { id title } } }" }' \
  https://api.linear.app/graphql
```

OAuth access tokens by contrast use `Authorization: Bearer <token>`. But the **MCP server
accepts either form as a bearer credential**:

> "The MCP server supports passing OAuth token and API keys directly in the
> `Authorization: Bearer <yourtoken>` header instead of using the interactive authentication
> flow." — [linear.app/docs/mcp](https://linear.app/docs/mcp)

API keys are scopable at creation:

> "For each key you create, you can choose to give it full access to the data your user can
> access, or restrict it to certain permissions (Read, Write, Admin, Create issues, Create
> comments). You can also limit an API key's access to specific teams in your workspace."
> — [linear.app/docs/api-and-webhooks](https://linear.app/docs/api-and-webhooks)

Admins can disable member API key creation (Settings → Administration → API → Member API keys);
that setting never applies to admins.

**OAuth 2.0** — [linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication):

| Endpoint | URL |
|---|---|
| Authorize | `GET https://linear.app/oauth/authorize` |
| Token (exchange, refresh, client_credentials) | `POST https://api.linear.app/oauth/token` |
| Revoke | `POST https://api.linear.app/oauth/revoke` |

PKCE supported (`code_challenge_method` `plain` or `S256`). Scopes are **comma-separated**,
not space-separated. Scope list:

| Scope | Verbatim description | Source |
|---|---|---|
| `read` | "(Default) Read access for the user's account. This scope will always be present." | [oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication) |
| `write` | "Write access for the user's account. If your application only needs to create comments, use a more targeted scope" | same |
| `issues:create` | "Allows creating new issues and their attachments" | same |
| `comments:create` | "Allows creating new issue comments" | same |
| `timeSchedule:write` | "Allows creating and modifying time schedules" | same |
| `admin` | "Full access to admin level endpoints. You should never ask for this permission unless it's absolutely needed" | same |
| `app:assignable` | "Allow the app to be assigned as a delegate on issues and made a member of projects" | [developers/agents](https://linear.app/developers/agents) |
| `app:mentionable` | "Allow the app to be mentioned in issues, documents, and other editor surfaces" | same |
| `customer:read` / `customer:write` | customer data | same |
| `initiative:read` / `initiative:write` | initiative data | same |

Note the MCP-specific authorization server advertises only `["read","write","openid","email"]`
— the fine-grained `issues:create` / `comments:create` scopes are **not** offered through the
MCP OAuth path.

**Least privilege, Linear:**

- **(a) Read-only.** OAuth `scope=read`, or MCP endpoint `/mcp/readonly`, or a personal API
  key restricted to **Read** (optionally team-scoped). Linear states the guarantee
  explicitly: "Clients that request `read` are granted read-only access, and the underlying
  token can't reach write APIs" ([docs/mcp](https://linear.app/docs/mcp)).
- **(b) Read + comment + move tickets.** Effectively **`read,write`**. There is no granular
  scope for updating issue state — `issueUpdate` needs `write`, and `write` subsumes
  `comments:create`. If you only ever comment and never change state, `read,comments:create`
  is genuinely narrower. Never request `admin`. For API keys, the analogous choice is
  Read + Write, plus a team restriction.

**Actor authorization (`actor=app`)** — [linear.app/developers/oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization).
By default an OAuth token acts as the authorizing user: "actions performed with the OAuth
token will appear to come from that user." With `actor=app`, "the user will instead authorize
installing the app within the workspace, actions performed with the received OAuth token will
come from the app itself. This is particularly useful for agents and service accounts."
Constraints from [developers/agents](https://linear.app/developers/agents): installation is
workspace-scoped so an admin must install it; "integrations using the `actor=app` mode are not
able to also request `admin` scope"; and assigning an issue to an app sets it as the
**`delegate`**, not the `assignee`. Per-mutation attribution is also available without
`actor=app` via `createAsUser` + `displayIconUrl` on `issueCreate`/`commentCreate`, rendering
as "User (via Application)".

**Linear Agents.** Linear has a first-class agent concept:
> "Agents behave similar to other users in a workspace. They can be @mentioned, delegated
> issues through assignment, create and reply to comments, collaborate on projects and
> documents, etc." — [linear.app/developers/agents](https://linear.app/developers/agents)

The interaction model is `AgentSession` (created automatically on mention/delegation) plus
`AgentActivity` emissions; an agent "should emit a `thought` activity within 10 seconds to
acknowledge the session has begun". This is visible in the schema (`Issue.agentSessions`,
`Comment.agentSession`, `User.supportsAgentSessions`). **This is out of scope for v1** — it is
an inbound, event-driven surface, and the map rules out acting unprompted — but it is the
shape Linear expects agents to take, and worth knowing the door exists.

**Minimum for a working install (both):** one GitHub PAT and one Linear API key, each in an
environment variable. No app registration, no callback server, no browser flow.

---

## 3. Token lifecycle

### 3.1 GitHub

| Credential | Expires | Refresh | What a weeks-long process must do |
|---|---|---|---|
| Classic PAT | Optional; no expiration requirement | none | Nothing, if set to no expiry. But GitHub "will automatically revoke an OAuth token or personal access token when the token **hasn't been used in one year**" — irrelevant for a running agent. |
| Fine-grained PAT | Optional; `expires_in` accepts "Integer between **1 and 366**, or `none` for non-expiring. If not provided, the default is 30 days" | none | Set `none` for personal-account repos. For org repos expect a cap: "the **default maximum lifetime policy for organizations is set to expire within 366 days**". Build a rotation reminder and treat 401 as "rotate". |
| GitHub App installation token | **1 hour** | mint a new one from an RS256 JWT (`iat` 60s in the past, `exp` "**no more than 10 minutes into the future**"), `POST /app/installations/{id}/access_tokens` | Cache with `expires_at`, refresh at ~50 min, never cache the JWT. Custody of a `.pem`. Octokit does this for you: "The SDK will take care of generating an installation access token for you and will **regenerate the token once it expires**." |
| GitHub App user access token | **8 hours** (`expires_in: 28800`) | refresh token, **6 months** (`refresh_token_expires_in: 15897600`) | Persist access + refresh tokens and both expiries **to durable storage**; rotate the stored refresh token on every refresh; a human must re-auth twice a year. |
| OAuth App token | never, until revoked | n/a | Nothing — but GitHub recommends against OAuth apps. |

Sources: [Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation),
[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[Generating a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
[Enforcing a maximum lifetime policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization#enforcing-a-maximum-lifetime-policy-for-personal-access-tokens),
[Supported query parameters](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#supported-query-parameters).

Expiring user access tokens are **opt-out, not opt-in**: "When you create your app, expiration of
user access tokens is enabled unless you opt out"
([Activating optional features](https://docs.github.com/en/apps/maintaining-github-apps/activating-optional-features-for-github-apps)),
and turning it off "is not recommended due to the security implications".

Two silent failure modes worth designing for:

1. **Org lifetime policy blocks rather than revokes.** "Setting this policy does not revoke or
   disable these tokens. Users will learn that their existing token is non-compliant when
   **API calls for your organization are rejected**." An agent will see 403s on one org while
   everything else keeps working.
2. **Public leak auto-revokes.** "If a valid OAuth token, GitHub App token, or personal access
   token is **pushed to a public repository or public gist, the token will be automatically
   revoked**." An agent that can push and can read its own config can revoke its own credential.

### 3.2 Linear

| Credential | Expires? | Refresh? | Revocation |
|---|---|---|---|
| Personal API key | **No documented expiry.** Nothing on [docs/api-and-webhooks](https://linear.app/docs/api-and-webhooks), [docs/security-and-access](https://linear.app/docs/security-and-access), or [developers/graphql](https://linear.app/developers/graphql) mentions expiry, and there is no `ApiKey` type or `expiresAt` in the public schema. | n/a | Manual: Settings → Account → Security & Access, or admin via Settings → Administration → API |
| OAuth access token (authorization_code) | **Yes — 24 hours.** "The access token is valid for 24 hours and will need to be refreshed when it expires." Response shows `"expires_in": 86399`. | **Yes**, `grant_type=refresh_token`. A **new refresh token is returned on every refresh** (rotation), with a documented **30-minute grace period** to replay a lost refresh request. | `POST https://api.linear.app/oauth/revoke` with `token` and optional `token_type_hint` |
| OAuth client_credentials token (`app` actor) | **Yes — 30 days** (`expires_in: 2591999`). "The token generated using this grant type will be an `app` actor token that has access to all public teams in the workspace and is valid for 30 days." | **No refresh token.** "your server is expected to fetch a new token if it receives a 401 error." Also invalidated by client-secret rotation. | same revoke endpoint |

All OAuth lifecycle claims: [linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication).
That page also notes "All OAuth2 applications were migrated to the new refresh token system
on April 1, 2026."

**What this means for a process that runs for weeks.**

- **Personal API key → nothing to do.** It keeps working until a human revokes it, the user
  is deactivated, or an admin disables member keys. This is decisively the simplest option
  for a single-user self-hosted instance. Costs: the agent *is* that human in the audit
  trail, it inherits exactly that human's team visibility, and it shares that human's
  rate-limit quota across all their keys ("Requests are associated with the authenticated
  user, which means all requests by the same user share the same quota even when using
  different API keys" — [rate-limiting](https://linear.app/developers/rate-limiting)).
- **OAuth authorization_code → you must build durable refresh-token rotation.** The access
  token dies daily and each refresh replaces the refresh token. Persist the new refresh token
  atomically *before* discarding the old one; on a lost response, replay within 30 minutes.
  A process holding tokens only in memory loses the connection on restart. Note that if you
  delegate OAuth to Codex via `codex mcp login linear`, Codex owns this storage and refresh —
  which is a reason to prefer letting the engine hold the credential rather than the app.
- **OAuth client_credentials → re-mint on 401.** No refresh machinery, but a 30-day ceiling
  means any process outliving a month *must* handle it. Cleanest fit if you want the agent to
  act as itself rather than as a person.

**Cross-cutting risk:** an MCP OAuth session held by the engine (Codex) is not visible to the
supervising app. If the token goes stale mid-job, the failure surfaces as a tool error inside
the agent loop, hours into a walked-away task. A static token has no such failure mode. This
is an argument for static tokens in v1 independent of the setup-simplicity argument.

---

## 4. Fallback surfaces

### 4.1 Linear: GraphQL only

There is **no REST data API**.

> "Linear's public API is built using GraphQL. It's the same API we use internally for
> developing our applications." — [linear.app/developers/graphql](https://linear.app/developers/graphql)

Endpoint `https://api.linear.app/graphql`; introspection enabled; public schema explorer at
Apollo Studio (`Linear-API`, no login). The only non-GraphQL HTTP endpoints are OAuth
token/revoke and webhook delivery.

**Official TypeScript SDK: `@linear/sdk`** — [linear.app/developers/sdk](https://linear.app/developers/sdk).
> "The Linear Typescript SDK exposes the Linear GraphQL schema through strongly typed models
> and operations."

It is codegen'd from the schema (`_generated_sdk.ts`), maintained in the `linear/linear`
monorepo, authenticated with `new LinearClient({ apiKey })` or `{ accessToken }`. Linear
recommends it — with a caveat that matters for an agent doing bulk reads:
> "This applies especially if you're using our SDK. If you're fetching lots of different
> entities or dependencies… it's always recommended to write your own custom GraphQL queries"
> — [rate-limiting](https://linear.app/developers/rate-limiting)

The SDK's lazy relation traversal is an easy accidental N+1 against a complexity budget.

**Rate limits** ([linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting)),
leaky bucket:

| Auth | Requests/hr | Complexity points/hr |
|---|---|---|
| API key | 2,500 (per user) | 3,000,000 |
| OAuth app | 5,000 (per user / app user) | 2,000,000 |
| Unauthenticated | 600 (per IP) | 100,000 |

Single query max complexity: **10,000 points**. Cost model: "Each property is 0.1 point, each
object is 1 point and any connection multiplies its children's points based on the given
pagination argument, or the default 50." Headers: `X-RateLimit-Requests-{Limit,Remaining,Reset}`,
`X-Complexity`, `X-RateLimit-Complexity-{Limit,Remaining,Reset}`, and per-endpoint variants.
Rate-limit errors are **HTTP 400** with `errors[].extensions.code === "RATELIMITED"` — not 429.
Default page size is 50.

⚠️ **The rate-limit page contradicts itself**: the prose says "When authenticated using an API
key you can make up to **5,000 requests per hour**" while the table says API key = 2,500 and
OAuth = 5,000. Assume 2,500 for API keys.

**Full-text and semantic search** (from the schema; documented in schema docstrings, not on the
filtering page):
- `searchIssues(term: String!, filter: IssueFilter, includeComments: Boolean, teamId: String, …)`
  — "Search issues by text query using full-text and vector search… **Rate-limited to 30
  requests per minute.**"
- `searchProjects`, `searchDocuments` — same shape and limit.
- `semanticSearch(query: String!, types: [SemanticSearchResultType!], …)` — "Search for issues,
  projects, initiatives, and documents using natural language."
- `issueSearch` is deprecated in favour of `searchIssues`.

**Filtering** ([linear.app/developers/filtering](https://linear.app/developers/filtering)) is
genuinely rich and worth knowing before writing a client. Comparators: `eq`, `neq`, `in`,
`nin`, plus `lt/lte/gt/gte` for numeric/date and
`contains/startsWith/endsWith/…IgnoreCase` for strings. Boolean composition via `and:`/`or:`.
Relation filtering nests: `assignee: { email: { eq: "…" } }`, `state: { type: { eq: "started" } }`,
`labels: { name: { eq: "Bug" } }`, `comments: { body: { contains: "👍" } }`. Collection filters
support `every:`. Relative dates use ISO 8601 durations: `completedAt: { gt: "-P2W" }`.

The full `IssueFilter` input (from the schema) supports 60+ predicates including `assignee`,
`delegate`, `creator`, `state`, `team`, `project`, `projectMilestone`, `cycle`, `labels`,
`parent`, `children`, `comments`, `priority`, `estimate`, `dueDate`, all the timestamps,
`slaStatus`, and existence predicates like `hasBlockingRelations`.

**Is a hand-written Linear client warranted in v1?** Probably not, with one caveat. The MCP
server covers issues/projects/comments CRUD, which is the whole of a v1 coworker's Linear
needs. The case for `@linear/sdk` appears if: (a) `tools/list` reveals the MCP filter surface
is coarser than `IssueFilter` — plausible, since MCP tools flatten arguments and `IssueFilter`
is a recursive input type; or (b) you need a specific query the MCP server does not expose.
Because Linear is GraphQL-only with a maintained typed SDK, a fallback client is *cheap* to
add later — this is a genuinely deferrable decision, and the deferral is safe.

### 4.2 GitHub: REST and GraphQL

GitHub offers both. On choosing:
> "You don't need to exclusively use one API over the other… Occasionally, a feature may be
> supported on one API but not the other."
> — [Comparing GitHub's REST API and GraphQL API](https://docs.github.com/en/rest/about-the-rest-api/comparing-githubs-rest-api-and-graphql-api)

> "The ability to define precisely the data you want—and *only* the data you want—is a
> powerful advantage over traditional REST API endpoints… GraphQL lets you replace multiple
> REST requests with *a single call*."
> — [About the GraphQL API](https://docs.github.com/en/graphql/overview/about-the-graphql-api)

Known GraphQL-leaning areas relevant here: **Projects (v2)** is documented exclusively through
GraphQL in
[Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects),
which instructs you to use "a token that has the `read:project` scope (for queries) or
`project` scope (for queries and mutations)". *Caveat: that page does not say REST access is
impossible; it simply only documents GraphQL. I could not find a first-party statement that
Projects v2 has no REST surface.* PR review-thread resolution is likewise GraphQL-shaped —
note the MCP server's `pull_request_review_write` takes a `threadId` of the form
`PRRT_kwDOxxx`, a GraphQL node ID.

**Rate limits** are summarised in §2.1: 5,000 req/hr shared across every credential on the
account, and — the one that actually bites — a secondary limit of **80 content-generating
requests per minute and 500 per hour**. An agent that comments in a loop hits that long before
the primary limit.

**Is a hand-written GitHub client warranted in v1?** The MCP tool inventory is unusually
complete — 86 tools with explicit parameters, covering issue read/write/comment/label/sub-issue,
PR create/read/review/merge, file read/write, branch create, code and commit search, and
Projects v2. Functionally, I found no v1 coworker operation the MCP server cannot express.

**Except one, and it is caused by the credential rather than the server: search.** As
established in §2.1, a fine-grained PAT can only call `/search/labels`, and the MCP server's
six search tools go through REST search. That leaves three routes, and the choice has to be
made in v1 because "which issues are assigned to me across the org" is a first-hour question:

1. **Classic PAT with `repo`** — search works; access control is all-or-nothing.
2. **GitHub App installation token** — search works, rate limits are higher and scale, tokens
   self-renew. Cost: app registration, private-key custody, a token-cache layer, and the agent
   acts as an app rather than as you.
3. **Fine-grained PAT + a small GraphQL fallback for search** — keeps least privilege, but
   *whether GraphQL `search` works for a fine-grained PAT is unverified* (§7). If it does, this
   is a genuinely narrow hand-written client: one query, one code path.

The other reasons to add a client remain non-functional and deferrable: response-size control
(MCP tool results land in the model's context; a targeted GraphQL query returns less) and
deterministic bulk operations that should not cost model tokens.

The stronger point is §5: for *code* work, the answer is neither REST nor GraphQL — it is a
checkout.

---

## 5. Repo access: API versus checkout

This distinction is sharper than it first looks, and it is decisive because the engine is a
local CLI with filesystem access.

**What the API gives you.** Through the MCP `repos` toolset: `get_file_contents`,
`get_repository_tree` (recursive, path-filtered), `search_code`, `list_commits`, `get_commit`,
`create_branch`, `create_or_update_file`, `push_files`, `delete_file`. Enough to read any
single file you can name, walk the tree, and write a commit containing a set of
`{path, content}` pairs.

What it does *not* give you, at any price:

- **Running anything.** No tests, no typecheck, no linter, no build, no `git bisect`.
- **Cheap repeated reads.** Every file read is a network round trip that lands in the model's
  context window.
- **Real search.** `search_code` is GitHub's code search — indexed, not grep. No regex over
  working state, no `rg -A5`, no cross-file refactor verification.
- **Coherent multi-file edits.** `create_or_update_file` needs the current blob `sha` "if the
  file already exists". `push_files` takes whole file contents, meaning the model must
  reproduce every unchanged byte of every touched file. This is exactly the failure mode where
  agents silently truncate files.
- **Any of the engine's native strengths.** Codex CLI's value is precisely apply-patch, shell,
  and iterate. Denying it a filesystem reduces it to a chat model with a slow, lossy file API.

**What a checkout costs.** A PAT that can read/write repository contents doubles as the
password for Git over HTTPS:

> "You can use a personal access token in place of a password when authenticating to GitHub in
> the command line or with the API… When prompted for your password, enter your personal access
> token instead."
> — [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

So the incremental setup cost over the API-only path is: **zero new credentials**, plus disk,
plus a decision about where clones live and how they are kept fresh. The operational surface it
adds is real but ordinary — a workspace directory, `git fetch` before work, a branch per job,
cleanup policy, and a concurrency rule (two jobs must not share a worktree; `git worktree` is
the obvious answer).

**Recommendation.** v1 should have a checkout for repositories the coworker does code work in,
and use the MCP server for everything *about* the repo — issues, PRs, comments, reviews,
search across repos it has not cloned. Concretely:

- **API/MCP:** read an issue, comment, open a PR, read a PR diff, read review comments, move a
  project item, search issues across the org.
- **Checkout:** understand a codebase, change code, run tests, produce a commit that is
  actually correct.

The clean seam is: **the coworker pushes a branch with git, then calls `create_pull_request`
over MCP.** Neither surface has to do the other's job.

A note on the middle path: if a checkout is deferred, `push_files` plus `create_pull_request`
*can* open a PR without one. It will be a worse PR, because nothing verified it. That is a
legitimate v1 scope cut, but it should be a stated one rather than a discovered one.

---

## 6. Shape mismatch

This is where the connector interface actually gets designed. Every row below is a place where
a naive shared abstraction leaks.

### 6.1 The unit of work: issue vs issue

Superficially aligned, structurally not.

| | GitHub | Linear |
|---|---|---|
| Container | **Repository** (required) | **Team** (required) — `IssueCreateInput.teamId: String!` |
| Human identifier | `#123`, unique per repo | `ENG-123` (`Issue.identifier`), unique per workspace; `Issue.number` per team |
| Stable id | numeric `id` **and** `number`, different things | UUID `id` |
| Prior identifiers | — | `Issue.previousIdentifiers: [String!]!` (issues can move teams) |
| Is a PR an issue? | **Yes.** "Every pull request is an issue, but not every issue is a pull request" — [REST issue comments](https://docs.github.com/en/rest/issues/comments) | No such notion |

The identifier collision is not academic: GitHub's own sub-issue API mixes them —
`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` takes `{"sub_issue_id": 1}`, an
**id**, in the body of a URL keyed by **number**
([REST sub-issues](https://docs.github.com/en/rest/issues/sub-issues)). The MCP tool inherits
this: `sub_issue_write` documents "`sub_issue_id`: The ID of the sub-issue to add. **ID is not
the same as issue number**". Any connector reference type must carry enough to disambiguate.

Also: a Linear issue can *change teams* (`IssueUpdateInput.teamId`), which rewrites its
identifier and appends to `previousIdentifiers`. A GitHub issue can be transferred between
repositories, which changes its number. Neither service's human-facing identifier is a stable
key. **Cache the opaque id; render the human identifier.**

### 6.2 Status: two-value enum vs team-scoped state machine

This is the largest mismatch.

**GitHub.** `state` is `"open"` or `"closed"`, full stop. `state_reason` is
`"completed" | "not_planned" | "duplicate" | "reopened" | null`
([REST issues](https://docs.github.com/en/rest/issues/issues)). Everything richer — "In
Review", "Blocked", "Ready for QA" — lives in **labels** (repo-scoped, flat strings) or in a
**Projects v2 single-select field** (project-scoped, e.g. `{"name": "Status", "value": "In
Progress"}` via `projects_write`). There is no canonical workflow.

**Linear.** Status is a `WorkflowState` row, and the schema is emphatic that it belongs to a
team:

```graphql
type WorkflowState implements Node {
  name: String!
  position: Float!
  team: Team!          # non-null — states are strictly team-scoped
  type: String!        # "triage" | "backlog" | "unstarted" | "started"
                       # | "completed" | "canceled" | "duplicate"
  inheritedFrom: WorkflowState
}
```
> "The team that this workflow state belongs to. **Each team has its own set of workflow
> states.**" — schema docstring

Note `type` is a `String!`, **not a GraphQL enum**, despite having a fixed documented domain.
Teams carry `defaultIssueState` and `triageIssueState`; sub-teams can inherit states via
`inheritedFrom`.

**Consequences for the interface.**
1. "Move this ticket to In Progress" is a *lookup* on Linear (resolve team → states → find one
   whose `name` or `type` matches) and is *not expressible* on GitHub except as a label or a
   project field write.
2. The only genuinely portable status vocabulary is the **`type` category** — open/closed maps
   onto `started`/`completed` reasonably, and `canceled` ≈ `not_planned`. Anything finer is
   Linear-only.
3. A connector interface that models status as a free string and requires the caller to resolve
   it per-service will be honest. One that defines a shared `Status` enum will lie in one
   direction or the other.

### 6.3 Labels

| | GitHub | Linear |
|---|---|---|
| Scope | Repository | `IssueLabel.team: Team` — **nullable**, so labels are *either* team-scoped *or* workspace-level |
| Structure | Flat | Hierarchical: `parent: IssueLabel`, `children`, `isGroup: Boolean!` (label groups) |
| Lifecycle | Delete | `retiredAt` / `retiredBy` — labels are retired, not just deleted |
| Inheritance | — | `inheritedFrom: IssueLabel` (sub-teams) |
| Semantic load | **High** — labels carry status, priority, type, area | Lower — status, priority, project, cycle all have first-class fields |

The last row is the design pressure. On GitHub, "add the `blocked` label" is often the only way
to express something Linear has a real field for. A connector that maps labels ↔ labels
one-to-one is correct and useless; a connector that tries to interpret GitHub labels as status
is clever and wrong. Best answer is probably: expose labels as labels, and let the *agent*
(which reads the repo's label list) do the interpretation.

### 6.4 The middle container: repo vs team vs project

Three axes, and they do not line up.

- **GitHub `Repository`** — the container for issues, PRs, and code. Hard boundary; issues
  cannot span repos.
- **Linear `Team`** — the container for issues, workflow states, labels, and cycles. Hard
  boundary for states. Teams nest (`Team.parent`, `Team.children`, `Team.ancestors`) with
  optional workflow inheritance. Has a short `key` (e.g. `ENG`) that prefixes issue identifiers.
- **Linear `Project`** — **workspace-level and cross-team**: `Project.teams` is a *connection*,
  many-to-many. Has its own `status: ProjectStatus!` (distinct type from `WorkflowState`),
  `lead`, `members`, `startDate`/`targetDate`, `health`, `progress`, `projectMilestones`,
  `projectUpdates`, its own `comments`, and its own labels (`Project.labels`, and a
  changelog-confirmed MCP rule that "`save_project` no longer accepts issue-level label IDs").
- **GitHub `Projects v2`** — an org- or user-owned board that *references* issues and PRs from
  any repo as items with custom fields. Closer to a Linear view than to a Linear Project: it has
  no lead, no milestones, no updates, no comments of its own.
- **Linear `Cycle`** — team-scoped time box (`Cycle.team: Team!`, `startsAt`/`endsAt`,
  `isActive`). GitHub's nearest neighbours are the repo-scoped `milestone` (a due date and a
  name) and a Projects v2 iteration field. Neither is the same thing.
- **Linear `Initiative`** — a level above Project, with sub-initiatives. No GitHub analogue.
- **Linear `ProjectMilestone`** — `project: Project!`, so a milestone belongs to a project.
  GitHub's `milestone` belongs to a *repository* and is applied to issues directly. Same word,
  different parent.

There is no honest three-way mapping here. The pragmatic move is to treat "where does this work
live" as a **service-specific coordinate** that the connector surfaces as opaque, named handles
(`repo`, or `team` + optional `project`) rather than as a normalised `Container` type.

### 6.5 Comment threading

| | GitHub issue comments | GitHub PR review comments | Linear comments |
|---|---|---|---|
| Threading | **None.** Flat, "ordered by ascending ID" ([REST issue comments](https://docs.github.com/en/rest/issues/comments)) | **Yes**, one level | **Yes**, one level |
| Reply mechanism | — | `in_reply_to_id`, or `POST /pulls/{n}/comments/{id}/replies` | `CommentCreateInput.parentId` |
| Depth limit | — | "**Replies to replies are not supported.**" ([REST pull comments](https://docs.github.com/en/rest/pulls/comments)) | `parent` / `children` only; no stated max depth, but the model is parent→children, i.e. one level in practice |
| Anchored to code | — | Yes — "comments made on a portion of the unified diff during a pull request review" | No |
| Resolvable | — | Yes (`resolve_thread` via GraphQL node id `PRRT_…`) | Yes — `Comment.resolvedAt`, `resolvingUser`, `resolvingComment` |
| Attachable to | Issue or PR | PR diff hunk | Issue, Project, ProjectUpdate, Initiative, InitiativeUpdate, Document, Post — `Comment` has a nullable FK for each |

Two things fall out. First, **GitHub has two different comment systems on the same object** —
timeline comments (flat) and review comments (threaded, anchored) — and the MCP server exposes
them as different tools (`add_issue_comment` vs `add_comment_to_pending_review` /
`add_reply_to_pull_request_comment`). A connector `comment()` method has to pick one or take a
discriminator. Second, **Linear comments are polymorphic across seven parent types** where
GitHub's attach only to issues/PRs. A shared `Comment` type either loses Linear's parent variety
or invents GitHub parents that do not exist.

Since the coworker's own natural idiom is "reply in the thread", Linear's threading is directly
usable and GitHub's issue timeline is not. Worth knowing before promising thread-shaped
behaviour on both.

### 6.6 Hierarchy and relations

| | GitHub | Linear |
|---|---|---|
| Parent/child | Sub-issues: `GET/POST /issues/{n}/sub_issues`, `GET /issues/{n}/parent`, `DELETE …/sub_issue`, `PATCH …/sub_issues/priority`. MCP: `sub_issue_write` with `add`/`remove`/`reprioritize` and `replace_parent`. Note "there is no writable parent field" — you re-parent by `add` with `replace_parent=true`. | `Issue.parent` / `Issue.children`, plus `subIssueSortOrder`. Writable directly via `IssueUpdateInput.parentId`. Team settings `autoCloseChildIssues` / `autoCloseParentIssues`. |
| Typed relations | **None** for issues. Closest is a "duplicate" `state_reason` plus `duplicate_of`. | First-class `IssueRelation` node with `enum IssueRelationType { blocks, duplicate, related, similar }`, reachable via `Issue.relations` / `inverseRelations`, with filter predicates `hasBlockingRelations`, `hasBlockedByRelations`, etc. |
| Classification | Org-level **issue types** — "You can create up to 25 issue types"; defaults task/bug/feature ([managing issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/configuring-issues/managing-issue-types-in-an-organization)) | Labels + `Issue.priority` (`Float!` with `priorityLabel`) + `estimate` |

"This ticket is blocked by that one" is expressible in Linear and simply is not in GitHub.

### 6.7 Identity

This is the connector's hardest cross-cut, and it feeds the identity-mapping fog in the map.

- **GitHub** identifies people by `login` (a string handle) and numeric `id`. Email is often
  private. `get_me` returns the authenticated user. Assignment takes logins
  (`issue_write.assignees`: "Usernames to assign to this issue").
- **Linear** identifies people by UUID, with `email: String!` (non-null),
  `name`, `displayName`. Assignment takes `assigneeId` (UUID) — you must resolve a human to a
  UUID first.
- **Linear knows about GitHub.** `User.gitHubUserId: String` and `User.hasGitHubCodeAccess`
  exist in the schema. That is a first-party bridge for one leg of the mapping, populated when
  the workspace has the GitHub integration configured. Worth probing; I have not verified how
  reliably it is populated.
- **Bots and apps are modelled differently.** Linear has `User.app: Boolean!`,
  `Comment.botActor: ActorBot`, `Comment.onBehalfOf: User`, `ExternalUser`, and
  `Issue.delegate` (distinct from `assignee` — an app assigned an issue becomes its *delegate*).
  GitHub has a `Bot` actor type and app-authored content but no delegate concept.
- **Attribution differs.** Linear can attribute a single mutation to a display name without
  changing the token identity (`createAsUser` + `displayIconUrl`, rendering "User (via
  Application)"). GitHub has no equivalent — content is authored by whoever the token is.

The practical implication: **Slack user → GitHub login → Linear UUID is a three-way mapping with
no reliable automatic join**, except possibly `User.gitHubUserId`. For a single-human v1 the
honest answer is a small hand-written config block (`{slack_user_id, github_login, linear_email}`),
not a resolution algorithm.

### 6.8 Querying

- **GitHub**: a **search-query string DSL** — `search_issues(query: "…")` using "GitHub issues
  search syntax", plus per-endpoint filters on `list_issues` (`labels[]`, `state`, `since`,
  `orderBy`). Two different filtering idioms in one API.
- **Linear**: a **structured, recursive filter object** — `IssueFilter` with 60+ predicates,
  nested relation filters, `and`/`or` composition, `every:` on collections, and ISO 8601
  relative durations. Plus separate `searchIssues` / `semanticSearch` queries for text, at
  30 rpm.

A shared `list(filter)` signature has to pick a representation. A string DSL loses Linear's
structure; a structured filter has to be compiled down to GitHub's query syntax and will not
round-trip. This is a strong argument for **not** unifying query at all in v1 — let each
connector expose its native query surface and let the agent, which is good at writing both,
choose.

### 6.9 Summary table of mismatches

| Concept | GitHub | Linear | Shared abstraction viable? |
|---|---|---|---|
| Work item | Issue (repo-scoped, `#123`) | Issue (team-scoped, `ENG-123`) | Yes, with opaque ids |
| Status | `open`/`closed` + `state_reason` | Team-scoped `WorkflowState` with 7 `type` categories | **Only at the category level** |
| Priority | none (labels) | `priority: Float!` + `priorityLabel` | No |
| Estimate | none | `estimate: Float` | No |
| Label | repo-scoped, flat, semantically overloaded | team-or-workspace, hierarchical, groups, retirable | Partially — as opaque strings |
| Container | Repository | Team (+ optional cross-team Project) | No — keep service-specific |
| "Project" | Projects v2 board of cross-repo items | Cross-team Project with lead/milestones/updates | No — same word, different thing |
| Time box | repo `milestone` | team `Cycle` | No |
| Comment | flat on issues; threaded+anchored on PR diffs | threaded, resolvable, 7 parent types | Partially — flat post only |
| Hierarchy | sub-issues, `id`-keyed, no writable parent | `parentId`, writable | Yes |
| Typed relations | none | blocks/duplicate/related/similar | No |
| Person | `login` string | UUID + non-null email | Only via explicit config mapping |
| Query | search-string DSL | structured recursive filter | No |
| Code | first-class (repo, PR, diff, branch) | referenced only (`branchName`, attachments, coding sessions) | N/A — GitHub-only |

---

## 7. What I could not establish

Stated plainly, because guessing here would be worse than a gap:

1. **The exact tool inventory of Linear's MCP server.** No first-party enumeration exists
   anywhere I could find. Only five tool names are confirmed, and those from changelog bug-fix
   notes. Resolve by authenticating and calling `tools/list`. This should happen before the
   connector interface is frozen.
2. **Whether Linear personal API keys expire.** Nothing in the docs and no `expiresAt` in the
   schema. Absence of documentation is not a guarantee.
3. **Linear's `read` scope boundary** — whether it covers customers and initiatives without
   `customer:read` / `initiative:read`. The agents page implies they are gated separately; no
   explicit statement.
4. **The precise mutation surface behind each Linear API-key permission checkbox** (Read /
   Write / Admin / Create issues / Create comments). Named but never mapped to mutations.
5. **Whether GitHub Projects v2 has any REST surface.** The docs only document GraphQL; they do
   not state REST is impossible.
6. **Linear comment threading depth.** Schema shows `parent`/`children` with no stated maximum.
7. **How reliably `User.gitHubUserId` is populated** in a real workspace.
8. **Linear's rate limit for API keys** — the docs contradict themselves (2,500 vs 5,000).
9. **Whether GitHub's GraphQL `search` connection works for a fine-grained PAT.** The REST
   restriction is documented and verified; GitHub says only "test your app to ensure it has the
   required permissions for the GraphQL queries you want to make". This determines whether
   option 3 in §4.2 exists at all. **Ten-minute empirical test; do it early.**
10. **Whether "Metadata: Read" can be deselected on a fine-grained PAT.** Observed to be
    auto-added by GitHub's own docs example, but never stated as mandatory.

---

## 8. Implications for the connector interface

1. **MCP is very nearly sufficient for v1 on both sides.** GitHub's server covers every
   operation a coworker needs with published, parameterised tools; Linear's covers
   issues/projects/comments by its own statement. Treat `@linear/sdk` and Octokit as deferred
   optimisations — adding either later is additive and forces no rewrite. The single possible
   v1 exception is a GraphQL search shim for GitHub, and only if the fine-grained-PAT route is
   chosen (see 4).

2. **But "connectors are just MCP servers" is not a sufficient plugin API.** Two things the
   engine cannot do for you: *tool-surface control* (42 GitHub tools by default, 86 available;
   which subset, read-only or not, is policy the app must own) and *credential lifecycle*
   (which token, whose identity, what happens on 401). The plugin interface should be, at
   minimum, "a connector contributes an MCP server config plus a credential plus a tool
   allow/deny list" — which maps cleanly onto Codex's `enabled_tools` / `disabled_tools`.

3. **Static tokens for v1; OAuth is a real cost with a real failure mode.** One GitHub PAT and
   one Linear API key get a working install with no app registration, no callback port, no
   refresh loop. Linear OAuth means 24-hour tokens with rotating refresh tokens and durable
   storage; the alternative (`codex mcp login`) pushes that state into the engine where the app
   cannot see it fail. For a job that runs for hours after the human walks away, a credential
   that cannot expire mid-job is worth a lot.

4. **But GitHub's credential choice is not free, and it is a v1 decision, not a v2 one.** The
   Search gap means "fine-grained PAT" and "the agent can search issues" are mutually exclusive
   unless GraphQL search works. Resolve this before writing the setup guide, because it
   determines what the guide *tells people to create*. Whatever the answer, document the
   org-approval trap: the default is "Require administrator approval", and an unapproved token
   authenticates fine and then reads only public data — a failure that looks like a bug, not a
   permission problem. The connector interface should surface credential health explicitly
   (a startup preflight that calls `get_me` and one private read) rather than discovering it
   three hours into a job.

5. **Do not normalise status. Normalise the *category*, and pass the rest through.**
   `open|closed` versus a team-scoped state machine with seven type categories is the mismatch
   that will bend any shared model. The defensible shared vocabulary is roughly
   `{backlog, started, completed, canceled}` derived from Linear's `WorkflowState.type` and
   GitHub's `state` + `state_reason`. Everything finer should be a service-specific operation
   the agent invokes by name.

6. **Do not normalise the container.** Repository / Team / Project / Cycle / Initiative /
   Projects v2 do not form a lattice. Expose named, opaque coordinates per service and let
   configuration bind them ("this Slack channel's work lives in `acme/api` and Linear team
   `ENG`").

7. **Do not normalise query.** A search-string DSL and a recursive filter object do not
   round-trip. Let each connector expose its native query and let the model write it.

8. **Comments are the one place a genuinely shared operation exists** — "post text on this
   thing" works on both. Note that it is *flat* on GitHub issues and *threaded* on Linear, so
   `reply_to` must be optional and may be ignored.

9. **Identity is configuration, not inference.** Slack ↔ GitHub `login` ↔ Linear UUID has no
   reliable automatic join. `User.gitHubUserId` is a lead worth probing but not a foundation.
   For single-human v1, a hand-written mapping block is the honest design.

10. **Give GitHub a checkout; that asymmetry is real and should be visible in the interface.**
   Linear is purely an API surface. GitHub is an API surface *plus* a filesystem surface, and
   the filesystem surface is where the engine earns its keep. A connector interface that
   pretends the two services are symmetric will either under-serve GitHub or invent a
   meaningless "workspace" concept for Linear. Better: connectors declare what they
   contribute — MCP tools, and optionally a working directory — and only GitHub declares the
   second.

11. **Two empirical checks gate this decision. Both are ten-minute tasks; do them before
    freezing the interface.**
    - Run `tools/list` against `https://mcp.linear.app/mcp` with a Linear API key. This is the
      largest known unknown in the document and determines whether Linear needs a fallback
      client in v1.
    - Run a GraphQL `search` query with a fine-grained PAT. This determines GitHub's credential
      story and therefore what the setup guide asks a self-hoster to create.
