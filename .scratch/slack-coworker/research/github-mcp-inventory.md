# GitHub MCP server — tool inventory as exposed to a `repo`-scoped token

Retrieved 2026-07-27T20:31Z from `https://api.githubcopilot.com/mcp/` via `tools/list`, authenticated with a **`gh` CLI OAuth token** (`gho_`, scopes: `gist`, `read:org`, `repo`, `workflow`). Inventory is toolset- and token-dependent; this is what one real token actually saw.

**44 tools exposed.** Read-only: 27. Marked destructive: 1.

## The finding that matters

**GitHub's `destructiveHint` annotations are not a usable safety signal.** Exactly one tool is flagged destructive — `delete_file` — while `merge_pull_request` and `push_files` are not. Linear, by contrast, flags 18 of 57 including every `save_*` upsert.

So a deny-list **cannot** be derived mechanically from annotations across both servers. Linear's can be; GitHub's must be hand-curated. Ticket 12 has to account for this asymmetry rather than assuming MCP annotations are a portable safety primitive.

## Full inventory

| Tool | R/W | Destructive |
|---|---|---|
| `get_commit` | R | no |
| `get_file_contents` | R | no |
| `get_label` | R | no |
| `get_latest_release` | R | no |
| `get_me` | R | no |
| `get_release_by_tag` | R | no |
| `get_tag` | R | no |
| `get_team_members` | R | no |
| `get_teams` | R | no |
| `issue_read` | R | no |
| `list_branches` | R | no |
| `list_commits` | R | no |
| `list_issue_fields` | R | no |
| `list_issue_types` | R | no |
| `list_issues` | R | no |
| `list_pull_requests` | R | no |
| `list_releases` | R | no |
| `list_repository_collaborators` | R | no |
| `list_tags` | R | no |
| `pull_request_read` | R | no |
| `run_secret_scanning` | R | no |
| `search_code` | R | no |
| `search_commits` | R | no |
| `search_issues` | R | no |
| `search_pull_requests` | R | no |
| `search_repositories` | R | no |
| `search_users` | R | no |
| `delete_file` | W | **yes** |
| `add_comment_to_pending_review` | W | no |
| `add_issue_comment` | W | no |
| `add_reply_to_pull_request_comment` | W | no |
| `create_branch` | W | no |
| `create_or_update_file` | W | no |
| `create_pull_request` | W | no |
| `create_repository` | W | no |
| `fork_repository` | W | no |
| `issue_write` | W | no |
| `merge_pull_request` | W | no |
| `pull_request_review_write` | W | no |
| `push_files` | W | no |
| `request_copilot_review` | W | no |
| `sub_issue_write` | W | no |
| `update_pull_request_branch` | W | no |
| `update_pull_request` | W | no |
