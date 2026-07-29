# Configuration

One instance file, one MCP registry, and secrets in the environment.

`open-agent.config.json` describes the instance: where the Vault is, what stops a runaway
Job, which model, which GitHub App, and where its MCP registry lives. `mcp.json` is the
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
- **A refusal** describes an instance whose boundaries are not the ones this documentation
  claims. A connector whose tool surface nobody has reviewed, a Skills directory the agent
  could rewrite, a GitHub App carrying `administration`. None is survivable, because in each
  case the instance would run *perfectly* while being a different instance from the one
  described here.

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
| `merge_diff` | Puts commits in a repository. Not undoable from a Thread. |
| `submit_diff_review` | Approves someone's code in the coworker's name. |
| Known Linear deletion tools | The deletion tools measured when the safety floor was written. |

The criterion is not "dangerous" but **"can a human undo this after noticing it in the
Thread?"** A wrong comment is embarrassing and stays available; Linear's `save_issue` is an
upsert and stays available too, because drawing that line at argument granularity is not
something the tool path can express.

The fixed floor covers tool names already reviewed by this project. It does not infer that a
new tool is dangerous from its name or MCP annotations. New capabilities are allowed by
default; operators can add tool names to `disabledTools` without maintaining a complete
inventory.

### `github`

```json
"github": {
  "appIdEnvVar": "GITHUB_APP_ID",
  "privateKeyPathEnvVar": "GITHUB_APP_PRIVATE_KEY_PATH",
  "owner": "your-org",
  "repositories": ["your-org/your-repo"]
}
```

A **GitHub App**, not a token ([ADR-0006](adr/0006-github-is-a-skill-over-gh.md)). You pick
the repositories in GitHub's installation UI, and that picker is the boundary — an
installation token cannot reach a repository the installation was not granted.

- **`owner`** is only needed when the App is installed in more than one place. With several
  installations and no `owner`, startup refuses rather than picking one: which account the
  coworker acts on is the difference between two audiences.
- **`repositories`** is a *statement of intent*, not an allow-list — nothing of ours sits
  between the coworker and `gh`. Startup compares it against what the installation actually
  grants and refuses on a mismatch, because the likeliest mistake on this path is that the
  picker and this file disagree, and its natural failure is a 404 deep inside a `gh` call
  three hours into a Job.

Leave the whole section out and GitHub is simply not configured. Startup says so and carries
on, which is a legitimate way to run this.

**What startup checks:** that `gh` is on `PATH` (a missing one is fatal — since ADR-0006 the
coworker reaches GitHub by running it), that the App's private key can sign, that an
installation token can actually be **minted**, what repositories that token reaches, and
that the App does not carry `administration`, `members`, or `workflows`. Each of those three
is a route around every other control.

**It also states what is missing.** An instance with GitHub configured runs **without layer
2 entirely**: there is no tool surface to disable and no inventory to pin, so nothing
structurally prevents it from merging a pull request. What stands in its place — the Skill's
instruction, the `AGENTS.md` policy, the pre-push hook, branch protection — is weaker than a
tool that does not exist. That warning prints on every startup, deliberately.

## Version pins

`RECORDED_CODEX_VERSION` and `RECORDED_GH_VERSION` in `src/config.ts`. Neither is a pin that
refuses to start: both report what is installed and warn on drift.

Codex has no pin because v1 runs against whatever you installed to log in with, and it ships
multiple alphas a day — so the warning is the minimum that must survive that decision. `gh`
has no pin because it is stable in a way Codex is not, and locking somebody out over a minor
version would have nothing behind it.

If either drifts and the coworker starts behaving strangely, this is the first thing to
suspect. `pnpm test:contract` checks the engine still behaves as expected.
