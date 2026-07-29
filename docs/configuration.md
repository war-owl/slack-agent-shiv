# Configuration

One instance file, one MCP registry, and secrets in the environment.

`open-agent.config.json` describes the instance: where the Vault is, what stops a runaway
Job, which model, and where its MCP registry lives. `mcp.json` is the
single extensible registry for every MCP server. Both files **name** credentials by
environment variable and never contain their values, exactly as a
[Skill](../CONTEXT.md#skill) does. `.env` is the keyring.

The environment configures nothing else. Two sources for one setting is how an instance ends
up running with bounds nobody wrote down. The single exception is `CONFIG_PATH`, which says
where the file is and cannot live inside it.

Start from [`open-agent.config.example.json`](../open-agent.config.example.json) and
[`mcp.example.json`](../mcp.example.json). Every instance section is optional. `mcpConfig`
defaults to `mcp.json` beside the instance file; when that default file is absent, the
instance runs without MCP servers. An explicitly named missing MCP file is an error.

**Relative paths resolve against the file's own directory**, not the working directory, so a
checkout that moves stays configured.

## What startup does with it

`src/preflight/` reads this file and then goes and checks it, before the first mention is
accepted. Two severities, and the difference is deliberate:

- **A report** describes an instance that will work. Version drift, the repository list, the
  bounds, the sandbox posture. Some are warnings — "this will behave in a way you may not
  have intended".
- **A refusal** describes an instance that cannot satisfy its configuration: a missing
  named credential, an unreachable connector, or a Skills directory the agent could
  rewrite.

## The sections

### `slack`

```json
"slack": { "botTokenEnvVar": "SLACK_BOT_TOKEN", "appTokenEnvVar": "SLACK_APP_TOKEN" }
```

Which variables hold the two tokens. Naming them is what lets one machine run two instances
against two workspaces. The bot token is checked with `auth.test` at startup and the
workspace it belongs to is printed — which is when you find out you started the instance
against the wrong one.

### `vault`

```json
"vault": { "notes": "./vault/Notes", "skills": "./vault/Skills" }
```

The two halves of the Vault, **divided by who may write them**. `notes` is passed to the
engine as writable; `skills` is passed to nothing, and that omission is the entire
enforcement of the rule that Skills are human-authored.

They must be siblings, under the directory you open in Obsidian, and not in a temporary
directory (`workspace-write` grants those unconditionally, so Skills there would be
writable). Startup refuses to run otherwise — see [docs/skills.md](skills.md). Set `notes`
alone and `skills` follows it.

### `bounds`

What stops a Job that does not stop by itself. Codex supplies none of this — no timeout, no
cap on turns, no budget, no kill switch — so these are the only ones there are. The
three per-Job limits are disabled by default and can be enabled independently:
`turnTimeoutMs`, `maxTurnsPerJob`, and `tokenBudgetPerJob`.

A Job is normally one Turn, and token usage arrives only at Turn completion. A configured
token budget can therefore refuse the *next* Turn but cannot interrupt the one already
spending; configure `turnTimeoutMs` when a hard wall-clock ceiling is required.

`maxConcurrentJobs` still defaults to four to protect shared Slack rate limits, and
`librarianTimeoutMs` defaults to five minutes because curation is best-effort work that
should not hold the next Job indefinitely.

### `engine`

`model`, `reasoningEffort`, and optionally `codexPath`. `low` effort is the right default
across many shallow Jobs; if considered answers come back thin, this is the first dial to
turn, not the prompt.

### `mcpConfig` and `mcp.json`

`mcpConfig` points to the one MCP registry and defaults to `./mcp.json`:

```json
"mcpConfig": "./mcp.json"
```

The registry is an `mcpServers` map. MCP standardizes the protocol and transports, but
does not currently standardize this file format; this is open-agent's validated contract.
The included [`mcp.schema.json`](../mcp.schema.json) provides editor completion.

```json
{
  "$schema": "./mcp.schema.json",
  "mcpServers": {
    "linear": {
      "type": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "bearerTokenEnvVar": "LINEAR_API_KEY",
      "writeTools": ["save_issue", "save_comment"],
      "disabledTools": []
    }
  }
}
```

Adding a server is one new object. A remote server uses `type: "streamable-http"` with:

- `url`
- optional `bearerTokenEnvVar`
- optional non-secret `httpHeaders`
- optional `envHttpHeaders`, mapping header names to environment-variable names

A local server uses `type: "stdio"` with:

- `command` and optional `args`
- optional `cwd`, resolved relative to `mcp.json`
- optional non-secret `env`
- optional `envVars`, naming variables to forward without copying their values into config

Local stdio entries execute software on the host. Pin package versions in their arguments;
startup prints a warning naming every local command. Both transports are handled by the
official [`@modelcontextprotocol/client`](https://github.com/modelcontextprotocol/typescript-sdk)
v2 SDK during preflight. Codex receives the same validated entries through its own MCP
configuration, so there is no second server list to synchronize.

Every enabled entry also carries open-agent's policy:

- **`writeTools`** — which of its tools act on the world, so every use of one is appended to
  the Thread as a permanent record. Required, not defaulted: an absent list means every
  Write through this connector leaves no trace.
- **`disabledTools`** — extra tools to disable. The irreversible ones are blocked for you
  (below), so this is for a judgement this project has not made.
- **`enabled`** — set to `false` to keep an entry without probing or exposing it.
- **`startupTimeoutSec` / `toolTimeoutSec`** — optional Codex MCP timeouts.

MCP inventories are deliberately **not pinned**. Startup verifies that each enabled server
can be reached and reports its current tool count, but tools may appear or disappear without
blocking the service. This keeps upstream server releases from turning into open-agent
outages. If a particular tool should never be available, name it in `disabledTools`.

#### What is blocked for you

Generated per server from the pin, and delivered as Codex's `disabled_tools` — so the tool
does not exist from the coworker's point of view:

| Blocked | Why |
| --- | --- |
| `merge_pull_request` | Publishes a branch into another branch. Not undoable from a Thread. |
| `merge_diff` | Puts commits in a repository. Not undoable from a Thread. |
| `submit_diff_review` | Approves someone's code in the coworker's name. |
| `delete_file` | Removes repository content. |
| Known Linear deletion tools | The deletion tools measured when the safety floor was written. |

The criterion is not "dangerous" but **"can a human undo this after noticing it in the
Thread?"** A wrong comment is embarrassing and stays available; Linear's `save_issue` is an
upsert and stays available too, because drawing that line at argument granularity is not
something the tool path can express.

The fixed floor covers tool names already reviewed by this project. It does not infer that a
new tool is dangerous from its name or MCP annotations. New capabilities are allowed by
default; operators can add tool names to `disabledTools` without maintaining a complete
inventory.

### GitHub through `mcp.json`

```json
"github": {
  "type": "streamable-http",
  "url": "https://api.githubcopilot.com/mcp/",
  "bearerTokenEnvVar": "GITHUB_TOKEN",
  "httpHeaders": {
    "X-MCP-Toolsets": "repos,issues,pull_requests",
    "X-MCP-Exclude-Tools": "merge_pull_request,delete_file"
  },
  "writeTools": [
    "add_issue_comment",
    "create_pull_request",
    "issue_write",
    "pull_request_review_write",
    "update_pull_request"
  ],
  "disabledTools": ["merge_pull_request", "delete_file"],
  "enabled": true
}
```

GitHub is an ordinary connector using GitHub's official MCP server
([ADR-0007](adr/0007-github-is-an-official-mcp-server.md)). Create a fine-grained personal
access token limited to the repositories and permissions this instance needs and put it in
`GITHUB_TOKEN`. The example ships disabled so copying it does not require a GitHub token;
change `enabled` to `true` when ready.

The server-side exclusion header avoids advertising merge and deletion tools. The local
`disabledTools` list and fixed safety floor repeat the restriction in Codex's generated
configuration. This duplication is intentional defence-in-depth, not a second connector
implementation. Git checkout and push remain ordinary local `git`; GitHub metadata, issues,
reviews, and pull-request creation use MCP.

## Version reporting

`RECORDED_CODEX_VERSION` in `src/config.ts` records the version this project last exercised.
It does not refuse startup: preflight reports the installed version and warns on drift.

Codex has no pin because v1 runs against whatever you installed to log in with, and it ships
multiple alphas a day — so the warning is the minimum that must survive that decision.
`pnpm test:contract` checks the engine still behaves as expected.
