#!/usr/bin/env bash
# Empirical checks for ticket 05. Answers the two questions that gate ticket 07
# and could not be established from documentation.
#
#   GH_FINE_TOKEN=github_pat_...  # a FINE-GRAINED PAT (github_pat_ prefix)
#   GH_CLASSIC_TOKEN=ghp_...      # optional: a classic PAT, for comparison
#   LINEAR_TOKEN=lin_api_...      # a Linear API key
#
# Paste the output into .scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md
# under an "## Answer" heading. Requires: curl, jq.

set -uo pipefail
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
note() { printf '  \033[33m·\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- Check 1: can a fine-grained PAT search? -------------------------------
# Docs say fine-grained PATs cannot call the REST Search API (only /search/labels),
# and the GitHub MCP server's six search tools all route through REST search.
# GitHub's docs do not say either way whether GraphQL `search` works.
# If REST fails and GraphQL succeeds, the agent keeps issue search on a
# least-privilege token — which is the outcome worth knowing.

gh_search_check() {
  local token="$1" label="$2"
  [ -z "$token" ] && { note "$label: not provided, skipped"; return; }

  local rest_code
  rest_code=$(curl -s -o /tmp/gh_rest.json -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    'https://api.github.com/search/issues?q=repo:openai/codex+is:issue&per_page=1')
  if [ "$rest_code" = "200" ]; then
    ok "$label REST /search/issues → 200 ($(jq -r '.total_count // "?"' /tmp/gh_rest.json) results)"
  else
    bad "$label REST /search/issues → $rest_code: $(jq -r '.message // "no message"' /tmp/gh_rest.json 2>/dev/null)"
  fi

  local gql_code
  gql_code=$(curl -s -o /tmp/gh_gql.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d '{"query":"query{search(query:\"repo:openai/codex is:issue\",type:ISSUE,first:1){issueCount}}"}' \
    'https://api.github.com/graphql')
  if [ "$gql_code" = "200" ] && jq -e '.data.search' /tmp/gh_gql.json >/dev/null 2>&1; then
    ok "$label GraphQL search → works ($(jq -r '.data.search.issueCount' /tmp/gh_gql.json) issues)"
  else
    bad "$label GraphQL search → $gql_code: $(jq -r '.errors[0].message // .message // "unknown"' /tmp/gh_gql.json 2>/dev/null)"
  fi
}

hdr "CHECK 1 — GitHub search capability by token type"
gh_search_check "${GH_FINE_TOKEN:-}"    "fine-grained"
gh_search_check "${GH_CLASSIC_TOKEN:-}" "classic     "
note "Decision this feeds: does the setup guide ask for a fine-grained or a classic PAT?"

# --- Check 2: Linear's real MCP tool inventory -----------------------------
# Only five tool names are first-party confirmed, all from changelog notes.
# Ticket 07 is designing against a guess until this returns a real list.
# Note: the Linear MCP server may require OAuth rather than an API key —
# a 401 here is itself a finding worth recording.

hdr "CHECK 2 — Linear MCP tool inventory"
if [ -z "${LINEAR_TOKEN:-}" ]; then
  note "LINEAR_TOKEN not provided, skipped"
else
  init=$(curl -s -X POST 'https://mcp.linear.app/mcp' \
    -H "Authorization: Bearer $LINEAR_TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ticket-05-check","version":"0"}}}')
  echo "$init" | head -c 400; echo

  tools=$(curl -s -X POST 'https://mcp.linear.app/mcp' \
    -H "Authorization: Bearer $LINEAR_TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

  if echo "$tools" | grep -q '"tools"'; then
    echo "$tools" | sed 's/^data: //' | jq -r '.result.tools[]? | "  - \(.name): \(.description // "" | .[0:100])"' 2>/dev/null \
      || echo "$tools" | head -c 2000
    ok "inventory retrieved — record the full list on ticket 05"
  else
    bad "tools/list did not return an inventory"
    echo "$tools" | head -c 600; echo
    note "If this is a 401, the finding is: the Linear MCP server needs OAuth, not an API key."
  fi
fi

# --- Check 3: is User.gitHubUserId actually populated? ---------------------
# If it is, it is an automatic Linear→GitHub identity join and it collapses
# most of the identity-mapping fog.

hdr "CHECK 3 — Linear User.gitHubUserId (identity join lead)"
if [ -z "${LINEAR_TOKEN:-}" ]; then
  note "LINEAR_TOKEN not provided, skipped"
else
  resp=$(curl -s -X POST 'https://api.linear.app/graphql' \
    -H "Authorization: $LINEAR_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query{viewer{id name email gitHubUserId}}"}')
  if echo "$resp" | jq -e '.data.viewer' >/dev/null 2>&1; then
    echo "$resp" | jq '.data.viewer'
    if [ "$(echo "$resp" | jq -r '.data.viewer.gitHubUserId // "null"')" = "null" ]; then
      note "gitHubUserId is NULL — no free identity join; the fog patch stands"
    else
      ok "gitHubUserId IS populated — identity mapping largely collapses"
    fi
  else
    bad "query failed: $(echo "$resp" | jq -r '.errors[0].message // .' 2>/dev/null | head -c 200)"
    note "If the field itself is rejected, record that: it means the schema lead was wrong."
  fi
fi

hdr "Done"
note "Record results on ticket 05, then ticket 07 unblocks on the Linear inventory."
