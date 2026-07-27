# Linear MCP server — real tool inventory

Retrieved 2026-07-27T20:30Z from `https://mcp.linear.app/mcp` via `tools/list`, authenticated with a **Linear API key as a bearer token** (no OAuth). Server reports `Linear MCP` v1.0.0, protocol `2025-06-18`.

**57 tools.** Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), which makes a deny-list mechanically derivable rather than hand-curated — directly relevant to ticket 12.

- Read-only: 35
- Write, non-destructive: 5
- Destructive: 17

## Full inventory

| Tool | R/W | Destructive | Description |
|---|---|---|---|
| `create_attachment_from_upload` | W | no | Link an already-uploaded Linear assetUrl to an existing issue as an attachment. |
| `create_attachment` | W | no | Deprecated fallback for tiny files only. Accepts base64 file content, verifies SHA-256 checksum, and uploads i |
| `create_initiative_label` | W | no | Create a new Linear initiative label |
| `create_issue_label` | W | no | Create a new Linear issue label |
| `delete_attachment` | W | **yes** | Delete an attachment by ID |
| `delete_comment` | W | **yes** | Delete a Linear comment. Inline description comments (those with non-null `quotedText`) anchor a mark in the e |
| `delete_diff_comment` | W | **yes** | Delete a comment from a Linear diff |
| `delete_status_update` | W | **yes** | Delete (archive) a project or initiative status update. |
| `extract_images` | R | no | Extract and fetch images from markdown content. Use this to view screenshots, diagrams, or other images embedd |
| `get_agent_skill` | R | no | Retrieve a Linear Agent skill by ID, including its full markdown instructions. |
| `get_attachment` | R | no | Retrieve an attachment's content by ID. |
| `get_diff_threads` | R | no | Exact lookup for diff threads. Use with review URLs, GitHub PR URLs, Linear full identifiers, UUIDs, or slugs. |
| `get_diff` | R | no | Exact lookup for a Linear diff. Use with review URLs, GitHub PR URLs, Linear full identifiers, UUIDs, or slugs |
| `get_document` | R | no | Retrieve a Linear document by ID or slug |
| `get_initiative` | R | no | Retrieve detailed information about a specific initiative in Linear |
| `get_issue_status` | R | no | Retrieve detailed information about an issue status in Linear by name or ID |
| `get_issue` | R | no | Retrieve detailed information about an issue by ID, including attachments, git branch name, and active Triage  |
| `get_milestone` | R | no | Retrieve details of a specific milestone by ID or name |
| `get_project` | R | no | Retrieve details of a specific project in Linear |
| `get_release_note` | R | no | Retrieve release notes by ID or slug, including markdown content. |
| `get_release` | R | no | Retrieve details of a release by ID or slug. |
| `get_status_updates` | R | no | List or get project/initiative status updates. Pass `id` to get a specific update, or filter to list. |
| `get_team` | R | no | Retrieve details of a specific Linear team |
| `get_user` | R | no | Retrieve details of a specific Linear user |
| `list_agent_skills` | R | no | List Linear Agent skills available to the authenticated user. |
| `list_comments` | R | no | List comments on a Linear issue, project, initiative, document, project milestone, or project/initiative statu |
| `list_cycles` | R | no | Retrieve cycles for a specific Linear team |
| `list_diffs` | R | no | List Linear diff pull requests visible to the authenticated user |
| `list_documents` | R | no | List documents in the user's Linear workspace |
| `list_initiative_labels` | R | no | List available initiative labels in the Linear workspace |
| `list_initiatives` | R | no | List initiatives in the user's Linear workspace |
| `list_issue_labels` | R | no | List available issue labels in a Linear workspace or team |
| `list_issue_statuses` | R | no | List available issue statuses in a Linear team |
| `list_issues` | R | no | List issues in the user's Linear workspace, including active Triage Intelligence suggestions for issues in tri |
| `list_milestones` | R | no | List all milestones in a Linear project |
| `list_project_labels` | R | no | List available project labels in the Linear workspace |
| `list_projects` | R | no | List projects in the user's Linear workspace |
| `list_release_notes` | R | no | List release notes in the workspace, optionally filtered by pipeline or covered release. |
| `list_release_pipelines` | R | no | List release pipelines in the workspace. |
| `list_releases` | R | no | List releases in the workspace, with optional filtering by pipeline, stage, version, and text. |
| `list_teams` | R | no | List teams in the user's Linear workspace |
| `list_users` | R | no | Retrieve users in the Linear workspace |
| `merge_diff` | W | **yes** | Merge a Linear diff or add it to the repository's merge queue |
| `prepare_attachment_upload` | W | no | Prepare a direct Linear file upload for an existing issue. |
| `resolve_diff_thread` | W | **yes** | Resolve or reopen a top-level comment thread on a Linear diff |
| `save_comment` | W | **yes** | Create or update a comment on a Linear issue, project, initiative, document, project milestone, or project/ini |
| `save_diff_comment` | W | **yes** | Create, reply to, or edit a comment on a Linear diff. Provide urlOrId when creating a comment or reply; provid |
| `save_document` | W | **yes** | Create or update a Linear document. If `id` is provided, updates the existing document; otherwise creates a ne |
| `save_initiative` | W | **yes** | Create or update a Linear initiative. If `id` is provided, updates the existing initiative; otherwise creates  |
| `save_issue` | W | **yes** | Create or update a Linear issue. If `id` is provided, updates the existing issue; otherwise creates a new one. |
| `save_milestone` | W | **yes** | Create or update a milestone in a Linear project. If `id` is provided, updates the existing milestone; otherwi |
| `save_project` | W | **yes** | Create or update a Linear project. If `id` is provided, updates the existing project; otherwise creates a new  |
| `save_release_note` | W | **yes** | Create or update release notes. If `id` is provided, updates the existing release notes; otherwise creates a n |
| `save_release` | W | **yes** | Create or update a release. If `id` is provided, updates the existing release; otherwise creates a new one. Wh |
| `save_status_update` | W | **yes** | Create or update a project/initiative status update. Omit `id` to create, provide `id` to update. |
| `search_documentation` | R | no | Search Linear's documentation to learn about features and usage |
| `submit_diff_review` | W | **yes** | Approve a Linear diff, request changes, or submit a review comment |
