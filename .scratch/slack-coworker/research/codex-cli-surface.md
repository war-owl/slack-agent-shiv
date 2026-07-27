# Codex CLI as an embeddable agent engine

Research ticket for the Slack coworker project. Investigates OpenAI's Codex CLI as a programmatically-driven,
embeddable engine.

## What this documents

| | |
|---|---|
| **Stable version** | `codex-cli 0.145.0` (npm `@openai/codex@0.145.0`, published 2026-07-27) |
| **Repo commit read** | `8495963ac6d15a3ac891517d979f5509d55605c0`, 2026-07-27 (`main`) |
| **Binary exercised** | `codex-cli 0.145.0` installed at `~/.local/bin/codex` |
| **SDK** | npm `@openai/codex-sdk@0.145.0` |
| **Prereleases in flight** | `rust-v0.146.0-alpha.13` (2026-07-27) |
| **Date of research** | 2026-07-28 |

Claims below are marked **[verified]** where I ran the command locally, **[source]** where I read the repo source, and
**[docs]** where they come only from OpenAI's documentation.

> **Pace-of-change warning.** `gh api repos/openai/codex/releases` shows six `0.146.0-alpha.*` prereleases published
> between 2026-07-24 and 2026-07-27 — multiple per day. Treat every version-specific detail here as a snapshot. The
> repo's own `docs/` directory was gutted between releases: `docs/exec.md`, `docs/config.md`, `docs/sandbox.md`,
> `docs/agents_md.md` and others are now 3-line stubs redirecting to `developers.openai.com`, which itself now
> 308-redirects to `learn.chatgpt.com/docs/*`. Anything you bookmark will move.

---

## 1. Non-interactive execution

### The entry point: `codex exec`

`codex exec` (alias `codex e`) is the non-interactive entry point.
[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) **[source]**

```
Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  review  Run a code review against the current repository
```

### Input model

Three ways in, from `cli.rs:81-85` **[source]**:

> Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from
> stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block.

So: prompt-as-argv, prompt-via-stdin (`-` or omitted), or **both** — in which case piped stdin becomes a `<stdin>`
block appended to the argv prompt. The `<stdin>` block behaviour matters for a Slack bot: if you spawn Codex with an
inherited or piped stdin you did not intend as input, it will be consumed as prompt context. I saw this live —
spawning with a redirect produced `Reading additional input from stdin...` on stderr. **[verified]**

### Flags (`codex exec --help`, 0.145.0) **[verified]**

| Flag | Effect |
|---|---|
| `-c, --config <key=value>` | Override any `config.toml` value. Dotted paths for nesting. Value parsed as TOML, falling back to a literal string. |
| `--enable/--disable <FEATURE>` | Sugar for `-c features.<name>=true/false` |
| `--strict-config` | Error on unrecognised `config.toml` fields |
| `-i, --image <FILE>...` | Attach images to the initial prompt |
| `-m, --model <MODEL>` | Model override |
| `--oss` | Use open-source provider |
| `--local-provider <lmstudio\|ollama>` | Pick the local provider |
| `-p, --profile <NAME>` | Layer `$CODEX_HOME/<name>.config.toml` over base config |
| `-s, --sandbox <MODE>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--dangerously-bypass-approvals-and-sandbox` | No sandbox, no prompts. "EXTREMELY DANGEROUS." |
| `--dangerously-bypass-hook-trust` | Run hooks without persisted trust |
| `-C, --cd <DIR>` | Working root |
| `--add-dir <DIR>` | Extra writable directory |
| `--skip-git-repo-check` | Allow running outside a git repo |
| `--ephemeral` | **Do not persist session files to disk** |
| `--ignore-user-config` | Skip `$CODEX_HOME/config.toml` (auth still uses `CODEX_HOME`) |
| `--ignore-rules` | Skip user/project execpolicy `.rules` |
| `--output-schema <FILE>` | JSON Schema constraining the final response |
| `--color <always\|never\|auto>` | |
| `--json` | **Print events to stdout as JSONL** |
| `-o, --output-last-message <FILE>` | Write the final agent message to a file |

Notably **absent**: any `--approval` / `-a` flag. `-a, --ask-for-approval` exists on the top-level `codex` command but
*not* on `codex exec`. See §6.

**Gotcha — flag ordering with subcommands.** Only `model`, `dangerously_bypass_approvals_and_sandbox` and
`bypass_hook_trust` are promoted to clap globals for `exec` (`mark_exec_global_args`, `cli.rs:157-163`) **[source]**.
`--sandbox` is *not* global, so it must precede the subcommand. I hit this:

```
$ codex exec resume <ID> --sandbox read-only "..."
error: unexpected argument '--sandbox' found         # exit 2

$ codex exec --sandbox read-only resume <ID> "..."   # correct
```
**[verified]**

### Structured output

Two distinct things, easy to conflate:

1. **`--json`** — the *event stream* as JSONL (§2).
2. **`--output-schema <FILE>`** — constrains the *model's final message* to a JSON Schema. The final `agent_message`
   item then carries JSON rather than prose. **[docs]**

`--full-auto` has been **removed**. It survives only as a hidden compatibility trap that prints
`warning: --full-auto is deprecated; use --sandbox workspace-write instead.` (`cli.rs:42-50, 103-111`) **[source]**

### Exit behaviour

- Exit `0` on a completed turn. **[verified]**
- Exit `2` on clap argument errors. **[verified]**
- Non-zero if a `required = true` MCP server fails to initialise, or if the git-repo check fails without
  `--skip-git-repo-check`. **[docs]**
- A *turn failure* (model/API error) surfaces as a `turn.failed` JSONL event; the SDK converts this into a thrown
  `Error` (`sdk/typescript/src/thread.ts`) **[source]**. Do not rely on exit code alone — parse the stream.

### The SDK — the better option for this project

**`@openai/codex-sdk`, TypeScript, Apache-2.0.** This is the single most important finding for a TypeScript project.

It is *not* a reimplementation — it is a thin, supported wrapper that spawns the CLI:

> The TypeScript SDK wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over
> stdin/stdout. — [`sdk/typescript/README.md`](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({ workingDirectory: "/path/to/vault", skipGitRepoCheck: true });
const turn = await thread.run("Diagnose the test failure and propose a fix");
console.log(turn.finalResponse, turn.items);
```

Internally it invokes `codex exec --experimental-json` and writes the prompt to stdin
(`sdk/typescript/src/exec.ts`) **[source]**. `--experimental-json` is simply a clap `alias` for `--json`
(`cli.rs:64-70`) **[source]** — the same stream, so SDK and raw-CLI integrations see identical events.

It resolves the binary out of the `@openai/codex` platform packages (`@openai/codex-darwin-arm64` etc.) via
`findCodexPath()`, so `@openai/codex` must be an installed dependency **[source]**. A `codexPathOverride` escape hatch
exists for pointing at a system binary.

Surface (`codexOptions.ts`, `threadOptions.ts`, `turnOptions.ts`) **[source]**:

- `new Codex({ codexPathOverride, baseUrl, apiKey, config, env })` — `config` is a JSON object flattened into repeated
  `--config key=value` TOML overrides, so **the entire `config.toml` surface is reachable from TypeScript**.
- `startThread({ model, sandboxMode, workingDirectory, skipGitRepoCheck, modelReasoningEffort, networkAccessEnabled, webSearchMode, approvalPolicy, additionalDirectories })`
- `thread.run(input, { outputSchema, signal })` → `{ items, finalResponse, usage }`
- `thread.runStreamed(input, opts)` → `{ events: AsyncGenerator<ThreadEvent> }`
- `codex.resumeThread(threadId)`
- `env` fully replaces `process.env` when supplied — useful for keeping Slack/GitHub tokens out of the agent's reach.

A Python SDK exists too (`sdk/python/`) with a richer example set (turn controls, thread lifecycle, login).

### Server / daemon modes

Four, all more capable than `exec` and all flagged experimental to some degree:

| Mode | What it is |
|---|---|
| `codex mcp-server` | Codex as an MCP server over stdio. Full thread/turn control plane. §4 |
| `codex app-server` | The interface behind the VS Code extension. JSON-RPC 2.0, bidirectional. stdio / websocket / unix socket. |
| `codex exec-server` | `[EXPERIMENTAL]` JSON-RPC server for spawning/controlling *subprocesses* via PTY — not an agent driver. |
| `codex remote-control` | `[experimental]` manage the app-server daemon with remote control enabled. |

`codex app-server` is the serious embedding target
([`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))
**[source]**:

- Transports: `--stdio` (default, JSONL), `--listen ws://IP:PORT` (**experimental / unsupported**),
  `--listen unix://PATH`, `--listen off`.
- ws transport also serves `GET /readyz` and `GET /healthz`.
- **Typed schema generation**: `codex app-server generate-ts --out DIR` and
  `codex app-server generate-json-schema --out DIR` emit a TypeScript/JSON-Schema binding *matching the exact binary
  version*. For a TypeScript project this removes most of the protocol-drift risk.
- Bounded queues; JSON-RPC error `-32001` `"Server overloaded; retry later."` under saturation — clients should back
  off with jitter.

---

## 2. Streaming and progress

**Yes — in-thread progress reporting is achievable.** Two tiers of fidelity.

### Tier 1: `codex exec --json` (item-level)

Real output from a live run **[verified]**:

```jsonl
{"type":"thread.started","thread_id":"019fa501-c366-7ea3-a703-225eafe18e5b"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll run that command now."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello'","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":33672,"cached_input_tokens":16128,"cache_write_input_tokens":0,"output_tokens":102,"reasoning_output_tokens":0}}
```

Event union — `sdk/typescript/src/events.ts`, generated from `codex-rs/exec/src/exec_events.rs` **[source]**:

`thread.started` · `turn.started` · `turn.completed` · `turn.failed` · `item.started` · `item.updated` ·
`item.completed` · `error`

Item union — `sdk/typescript/src/items.ts` **[source]**:

| Item type | Payload |
|---|---|
| `agent_message` | `{ text }` — prose, or JSON when `--output-schema` is set |
| `reasoning` | `{ text }` — reasoning *summary* |
| `command_execution` | `{ command, aggregated_output, exit_code?, status }` |
| `file_change` | `{ changes: [{path, kind: add\|delete\|update}], status }` |
| `mcp_tool_call` | `{ server, tool, arguments, result?, error?, status }` |
| `web_search` | `{ query }` |
| `todo_list` | `{ items: [{text, completed}] }` |
| `error` | `{ message }` — non-fatal |

**Critical precision on granularity.** I read the exec JSONL processor
(`codex-rs/exec/src/event_processor_with_jsonl_output.rs`) and enumerated every `ServerNotification` variant it
handles **[source]**: `ConfigWarning`, `Warning`, `Error`, `DeprecationNotice`, `HookStarted/Completed`,
`ItemStarted`, `ItemCompleted`, `ModelRerouted`, `ModelVerification`, `ThreadTokenUsageUpdated`, `TurnCompleted`,
`TurnDiffUpdated`, `TurnPlanUpdated`, `TurnStarted` — everything else falls through a `_ => CodexStatus::Running`
catch-all.

That means **`codex exec --json` deliberately drops all the delta notifications**. No
`item/agentMessage/delta`, no `item/commandExecution/outputDelta`, no `item/reasoning/summaryTextDelta`. You get
whole items on start and on completion, and nothing in between.

The one exception is the plan/todo list: `TurnPlanUpdated` is mapped into `item.started` (first plan) then
`item.updated` (every revision) on a `todo_list` item (`event_processor_with_jsonl_output.rs:556-580`) **[source]**.
**In `exec`, `item.updated` fires only for the todo list.** Confirmed by my run, which emitted only
`item.started`/`item.completed`.

For Slack this is arguably a feature — item-level events map cleanly to "🔧 Ran `pytest`" thread posts without
token-flood rate-limit problems, and the todo list is a ready-made checklist to edit-in-place.

Note that `command_execution.aggregated_output` arrives **whole, at completion**. A 40-minute build streams nothing
until it finishes.

### Tier 2: `codex app-server` / `codex mcp-server` (delta-level)

The app-server protocol exposes everything exec discards
([`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))
**[source]**:

- Lifecycle is always `item/started` → item-specific deltas → `item/completed`.
- `item/agentMessage/delta` — streamed reply text.
- `item/commandExecution/outputDelta` — **live stdout/stderr**.
- `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`.
- `item/plan/delta` (experimental).
- `turn/diff/updated` — `{ threadId, turnId, diff }`, the aggregated unified diff after every file change. A
  ready-made "what changed" view.
- `turn/plan/updated` — `{ turnId, explanation?, plan: [{step, status}] }`.
- `thread/tokenUsage/updated` — running cost.
- `mcpServer/startupStatus/updated`, `configWarning`, `warning`, `model/rerouted`, `model/safetyBuffering/updated`.
- Richer item set than exec: `plan`, `collabToolCall`, `imageView`, `sleep`, `enteredReviewMode`/`exitedReviewMode`,
  `contextCompaction`, `dynamicToolCall`.

Per-connection opt-out via `initialize.params.capabilities.optOutNotificationMethods` (exact method names) — so you
can subscribe to deltas for commands but suppress agent-message deltas, which is exactly the knob a Slack integration
wants.

### Out-of-band: the `notify` hook

`notify = ["python3", "/path/to/notify.py"]` in `config.toml` runs an external program on agent events, receiving JSON
with thread id, turn id and messages **[docs]**. A crude but process-independent progress channel.

---

## 3. Sessions and resumption

**Yes, sessions persist by default, and resumption works.**

### Storage

Sessions are "rollout" files: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`. **[verified]**

Example: `/Users/shiv/.codex/sessions/2026/07/28/rollout-2026-07-28T00-46-24-019fa501-c366-7ea3-a703-225eafe18e5b.jsonl`

The trailing UUID **is** the `thread_id` from the `thread.started` event — so the id you get on stdout at second one
tells you the on-disk path. **[verified]**

Format: JSONL, one record per line, each `{ timestamp, type, payload }`. Record types observed across real sessions
**[verified]**:

| `type` | `payload.type` | Notes |
|---|---|---|
| `session_meta` | — | `{ session_id, cwd, originator, cli_version, source, thread_source, model_provider, base_instructions, history_mode, context_window, git: { commit_hash, branch, repository_url } }` |
| `turn_context` | — | one per turn |
| `world_state` | — | |
| `response_item` | `message`, `reasoning`, `function_call`, `function_call_output`, `web_search_call`, `custom_tool_call`, `custom_tool_call_output` | the raw model transcript |
| `event_msg` | `task_started`, `task_complete`, `user_message`, `agent_message`, `token_count`, `patch_apply_end`, `web_search_end`, `turn_aborted`, `thread_rolled_back`, `thread_settings_applied` | the event stream |

This is a plain, greppable, append-only audit log of everything the agent did — useful in its own right for a coworker
that must explain itself.

`~/.codex` also contains SQLite stores (`state_5.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`, `logs_2.sqlite`) and
`history.jsonl`. **[verified — observed on disk; their schemas and stability are undocumented, and `memories_1.sqlite`
in particular hints at a native memory feature I could not find documentation for. Treat as unstable internals.]**

### Resuming

```bash
codex exec resume <SESSION_ID> "next instruction"
codex exec resume --last "next instruction"
codex exec --sandbox read-only resume <SESSION_ID> "..."   # note flag order, §1
```

Verified end-to-end **[verified]**: I ran a first turn, let the process exit, then resumed by id in a fresh process.
The resumed run emitted the **same** `thread_id`, appended to the **same** rollout file (record counts grew:
`task_started` 1→2, `turn_context` 1→2, `user_message` 1→2), and the model correctly answered a question about the
earlier turn. So:

> **A long job survives a process restart at turn granularity.**

`--last` also takes `--all` to disable cwd filtering. Top-level `codex` additionally offers `resume`, `fork`,
`archive`, `unarchive`, and `delete` subcommands (`codex --help`) **[verified]**.

### Forking

`codex fork` (interactive) and `thread/fork` (app-server) create a new thread id with copied history
**[source/docs]**. `thread/fork` accepts `ephemeral: true` for in-memory-only branches. Useful if the coworker wants
to speculatively explore without polluting the main thread.

### Caveats

- **Resumption is turn-granular, not mid-turn.** If the process dies 20 minutes into a turn, resuming starts a *new*
  turn. The partial work *is* in the rollout (function calls and outputs are appended as they happen **[verified]** —
  the crashed session's file will contain them), so the model gets that context back and won't redo everything blindly
  — but there is no "resume this turn from where the tool call left off" primitive.
- Any side effects already committed (a pushed branch, a filed Linear issue) are of course not rolled back.
- `--ephemeral` disables all of this. Do not set it for long jobs.
- Retention/pruning policy for `~/.codex/sessions` is **not documented**; I could not establish whether Codex ever
  garbage-collects old rollouts. Assume unbounded growth and plan to prune.

---

## 4. MCP support — both directions

### 4a. Codex as an MCP *client* (consuming external servers)

Yes. Configured in `config.toml` under `[mcp_servers.<id>]`, or managed via CLI.

**CLI** (`codex mcp --help`, 0.145.0) **[verified]**: subcommands `list`, `get`, `add`, `remove`, `login`, `logout`.

```
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)

Options:
      --env <KEY=VALUE>              Environment variables (stdio servers only)
      --url <URL>                    URL for a streamable HTTP MCP server
      --bearer-token-env-var <VAR>   Bearer token env var (HTTP servers only)
      --oauth-client-id <CLIENT_ID>  OAuth client identifier
      --oauth-resource <RESOURCE>    OAuth resource parameter
```

**stdio server:**
```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
```

**Streamable HTTP server:** set `url` instead of `command`; bearer token or OAuth (with automatic callback handling)
**[docs]**.

Per-server keys **[docs]**: `command`, `url`, `enabled`, `env`, `enabled_tools` (allowlist), `disabled_tools`
(denylist), `tool_timeout_sec`. Tool approval modes `auto` / `prompt` / `writes` / `approve`. A `required = true`
server that fails to start makes `codex exec` exit non-zero **[docs]**.

MCP config is **shared** across the ChatGPT desktop app, Codex CLI and the IDE extension **[docs]**.

Live MCP calls surface as `mcp_tool_call` items in the event stream with `server`, `tool`, `arguments`, `result`,
`error`, `status` **[source]** — so a Slack bot can narrate "called `linear.create_issue`" for free.

**This is the obvious integration path for GitHub and Linear**: point Codex at their MCP servers rather than writing
custom connectors.

### 4b. Codex exposed *as* an MCP server

Yes — `codex mcp-server` (stdio, JSON-RPC 2.0, line-delimited).
[`codex-rs/docs/codex_mcp_interface.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)
**[source]**

```bash
codex mcp-server | your_mcp_client
npx @modelcontextprotocol/inspector codex mcp-server   # inspection UI
```

> Status: experimental and subject to change without notice

It is far more than a "run a prompt" tool — it is a full control plane:

- **Threads**: `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`
- **Turns**: `turn/start`, **`turn/steer`**, **`turn/interrupt`**
- **Account**: `account/read`, `account/login/start`, `account/login/cancel`, `account/logout`,
  `account/rateLimits/read`
- **Config**: `config/read`, `config/value/write`, `config/batchWrite`
- **Catalog**: `model/list`, `app/list`, `collaborationMode/list`
- **Events**: `codex/event/*` live agent event notifications
- **Approvals (server → client)**: `applyPatchApproval`, `execCommandApproval`

`turn/steer` and `turn/interrupt` are significant for this project: a human could redirect or stop a running job
**from the Slack thread**, mid-flight. `codex exec` offers no equivalent (only killing the process / an `AbortSignal`).

The legacy `codex` and `codex-reply` tools return standard MCP `CallToolResult` with content mirrored into
`structuredContent` alongside `threadId` **[source]**.

Authoritative schema: `codex-rs/app-server-protocol/src/protocol/{common,v1,v2}.rs`. Note the doc's own warning:
"Method names, fields, and event shapes may evolve."

---

## 5. Configuration

### Location and layering

- User config: `~/.codex/config.toml` (`$CODEX_HOME` overrides the directory).
- Project config: `.codex/config.toml`, **loaded only when the project is trusted** **[docs]**.
- Profiles: `$CODEX_HOME/<name>.config.toml`, layered via `-p/--profile <name>` **[verified from `--help`]**.
- CLI: `-c key=value` with dotted paths, TOML-parsed **[verified]**.
- `--ignore-user-config` skips `config.toml` entirely (auth still resolves via `CODEX_HOME`).

**Project config cannot override** `openai_base_url`, `chatgpt_base_url`, `model_provider`, `model_providers`,
`notify`, `profile`, `profiles`, `otel` and related telemetry keys — those must live in user config **[docs]**. Good
news for a self-hosted bot: an untrusted repo cannot repoint the model provider.

### Main keys **[docs]**

| Key | Values |
|---|---|
| `model` | e.g. `gpt-5.5` |
| `model_provider` | id from `model_providers`, default `openai` |
| `model_context_window` | int |
| `model_reasoning_effort` | `minimal \| low \| medium \| high \| xhigh` |
| `model_reasoning_summary` | `auto \| concise \| detailed \| none` |
| `approval_policy` | `untrusted \| on-request \| never`, or granular (§6) |
| `sandbox_mode` | `read-only \| workspace-write \| danger-full-access` |
| `sandbox_workspace_write` | `network_access`, `writable_roots`, exclusion flags |
| `mcp_servers.<id>` | §4a |
| `notify` | command array invoked with JSON event payloads |
| `history.persistence` | `save-all \| none`; `history.max_bytes` |
| `project_doc_max_bytes` | AGENTS.md budget, default 32 KiB (§7) |
| `shell_environment_policy` | `inherit`, `set`, `exclude` (glob patterns) |
| `otel` | `environment`, `exporter`, `log_user_prompt` |
| `cli_auth_credentials_store` | `file \| keyring \| auto` |

`shell_environment_policy` deserves attention for this project — it controls which env vars reach subprocesses:

```toml
[shell_environment_policy]
inherit = "none"
set = { PATH = "/usr/bin", MY_FLAG = "1" }
exclude = ["AWS_*", "AZURE_*"]
```

That is how you keep the Slack bot token and Linear API key out of anything the agent shells out to.

### Non-OpenAI providers — **the significant finding**

You *can* point Codex at a custom provider:

```toml
model = "gpt-5.4"
model_provider = "proxy"

[model_providers.proxy]
name = "OpenAI using LLM proxy"
base_url = "http://proxy.example.com"
env_key = "OPENAI_API_KEY"
```

Full `ModelProviderInfo` field set (`codex-rs/model-provider-info/src/lib.rs:89-144`) **[source]**: `name`,
`base_url`, `env_key`, `env_key_instructions`, `experimental_bearer_token`, `auth` (command-backed token helper),
`aws` (SigV4), `wire_api`, `query_params`, `http_headers`, `env_http_headers`, `request_max_retries`,
`stream_max_retries`, `stream_idle_timeout_ms`, `websocket_connect_timeout_ms`, `requires_openai_auth`,
`supports_websockets`, `supports_standalone_web_search`.

Command-backed auth, for credential helpers **[docs]**:
```toml
[model_providers.proxy.auth]
command = "/usr/local/bin/fetch-codex-token"
args = ["--audience", "codex"]
timeout_ms = 5000
```

**But the wire protocol is now Responses-API-only.** From
[`codex-rs/model-provider-info/src/lib.rs:54-84`](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)
**[source]**:

```rust
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
}
```

There is exactly **one** variant. The deserializer rejects `chat` explicitly:

```rust
"chat" => Err(serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)),
_ => Err(serde::de::Error::unknown_variant(&value, &["responses"])),
```

with the message:

> `wire_api = "chat"` is no longer supported.
> How to fix: set `wire_api = "responses"` in your provider config.
> More info: https://github.com/openai/codex/discussions/7782

Grepping the whole `codex-rs` tree for `chat_completions|ChatCompletions` returns **zero** hits **[verified]** — the
code path is gone, not merely deprecated.

Per [discussion #7782](https://github.com/openai/codex/discussions/7782) **[docs]**: announced 2025-12-09, removal
completed around 2026-02-01. The `ollama-chat` provider id was removed alongside it (`lib.rs:51-52`) **[source]**.

**Consequence for this project:** "point it at Claude / a local model" is *not* a simple config edit. Any alternative
provider must serve an OpenAI **Responses API** — not Chat Completions. Most third-party gateways (LiteLLM, OpenRouter)
and local runtimes historically speak Chat Completions. The discussion records users hitting exactly this wall with
LM Studio and LiteLLM, and a community bridge translating Chat↔Responses.

Built-in providers (`built_in_model_providers`, `lib.rs:438-465`) **[source]**: `openai`, `amazon-bedrock`, `ollama`,
`lmstudio` — the latter two constructed with `WireApi::Responses`. The comment is explicit about the policy:

> We do not want to be in the business of adjudicating which third-party providers are bundled with Codex CLI, so we
> only include the OpenAI and open source ("oss") providers by default.

Configured providers *extend* built-ins; built-ins are generally **not overridable** (Amazon Bedrock is a narrow
exception allowing `base_url`, `auth`, `http_headers`, `aws.profile`, `aws.region`) **[source]**.

Local models: `--oss` with `--local-provider ollama|lmstudio` (default ports 11434 / 1234; `CODEX_OSS_PORT`
overrides) **[source]**.

---

## 6. Sandboxing and approvals

### Sandbox modes **[verified from `--help`]**

| Mode | Effect |
|---|---|
| `read-only` | **Default.** Agent may read but not write; no command may modify the filesystem. |
| `workspace-write` | Writes allowed in the workspace (plus `--add-dir` roots). Network **off** by default; enable with `sandbox_workspace_write.network_access = true`. |
| `danger-full-access` | No restrictions. |

Enforcement is OS-level: **Seatbelt** on macOS, **Landlock/seccomp** on Linux **[docs]**; the repo also carries
`codex-rs/linux-sandbox`, `codex-rs/windows-sandbox-rs`, and `codex-rs/bwrap` **[source]**. `codex sandbox` is exposed
as a standalone subcommand for running arbitrary commands inside the Codex sandbox — potentially useful independently.

Additional layer: **execpolicy** `.rules` files (user and project scope), skippable with `--ignore-rules`
(`codex-rs/execpolicy`) **[source]**.

### Approval policies **[verified from `codex --help`]**

- `untrusted` — only "trusted" commands (ls, cat, sed) run unattended; anything else escalates.
- `on-request` — the model decides when to ask.
- `never` — never ask. **"Execution failures are immediately returned to the model."**

Plus a granular form **[docs]**:
```toml
approval_policy = { granular = { sandbox_approval = true, rules = true, mcp_elicitations = true, request_permissions = true, skill_approval = true } }
```

### How approvals behave headlessly — **the key answer**

**In `codex exec`, they don't. Approvals are hard-disabled.**

From [`codex-rs/exec/src/lib.rs:422-428`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)
**[source]**:

```rust
let overrides = ConfigOverrides {
    model,
    review_model: None,
    // Default to never ask for approvals in headless mode. Rebuild below if
    // the fully resolved reviewer is AutoReview.
    approval_policy: Some(AskForApproval::Never),
    ...
```

This is why `codex exec` has no `-a/--ask-for-approval` flag. The safety boundary in `exec` is **entirely the
sandbox**, not the approval prompt. Anything the sandbox permits happens without asking; anything it forbids fails,
and the failure text goes straight back to the model, which will typically try another route.

(The SDK's `ThreadOptions.approvalPolicy` maps to `--config approval_policy="..."` **[source]** and its type includes
an `on-failure` value not present in the CLI's enum — likely vestigial. Setting a non-`never` policy under `exec` has
no interactive channel to surface on; I did not test what it does in practice. **Unestablished.**)

**To get approvals with nobody at a terminal, you must use `app-server` / `mcp-server`.** There, approvals are
server→client JSON-RPC *requests* the client must answer
([`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md))
**[source]**:

1. `item/started` — pending `commandExecution` with `command`, `cwd`.
2. `item/commandExecution/requestApproval` — `{ itemId, threadId, turnId, environmentId, approvalId?, command, cwd, commandActions, reason, availableDecisions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments? }`.
3. Client responds: `accept` · `acceptForSession` · `acceptWithExecpolicyAmendment` · `applyNetworkPolicyAmendment` · `decline` · `cancel`.
4. `serverRequest/resolved` — `{ threadId, requestId }`.
5. `item/completed` — `status: completed | failed | declined`.

File changes follow the same shape via `item/fileChange/requestApproval` (with an optional `grantRoot`). There is also
`item/permissions/requestApproval` from the built-in `request_permissions` tool, and
`mcpServer/elicitation/request` for MCP servers asking for structured input (form / `openai/form` / url modes).

> **This maps precisely onto the project's open "Permission model" question.** An approval request becomes a Slack
> message with Approve/Deny buttons; the button click resolves the JSON-RPC request. The turn blocks until answered.
> `codex exec` cannot do this at all.

Note also the `[UNSTABLE]` auto-approval reviewer (`item/autoApprovalReview/started|completed`) carrying
`{ status, riskLevel: low|medium|high|critical, userAuthorization, rationale }` — an LLM-judged auto-approval path.
Explicitly "expected to change soon."

### Safety implications for unattended GitHub / Linear work

- The sandbox constrains **filesystem and network**, not **semantics**. `workspace-write` + `network_access = true`
  is enough to `git push --force`, close a Linear issue, or comment on a PR. There is no "GitHub write requires
  approval" primitive — the sandbox cannot tell a `gh pr view` from a `gh pr merge`.
- Since `exec` runs at `approval_policy = never`, an `exec`-based coworker is **unsupervised by construction** within
  whatever the sandbox allows. This sits awkwardly with the map's "delegate-and-walk-away, *not* unsupervised action"
  framing.
- Mitigations available: `execpolicy` `.rules` for command-level allow/deny; scoped tokens (a GitHub token without
  `delete_repo`, a Linear key without admin); `shell_environment_policy.exclude` to withhold credentials from
  subprocesses; `enabled_tools`/`disabled_tools` per MCP server; and running the whole thing in a container.
- `--dangerously-bypass-approvals-and-sandbox` also skips the git-repo check (`lib.rs:790-793`) **[source]**. It
  should never appear in this project outside an externally-sandboxed container.

---

## 7. Instructions and context — AGENTS.md

**[docs — [learn.chatgpt.com/docs/agent-configuration/agents-md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)]**

### Discovery order

1. **Global**: `~/.codex/AGENTS.md` (or `AGENTS.override.md` if present).
2. **Project**: walking from the git root down to the cwd, checking each level for `AGENTS.override.md`, then
   `AGENTS.md`, then fallback filenames.

### Precedence

Files are **concatenated root-first**, so files nearer the cwd land later in the combined prompt:

> files closer to your current directory override earlier guidance because they appear later in the combined prompt

### Budget

- `project_doc_max_bytes`, **default 32 KiB**.
- On overflow Codex "stops adding files once the combined size reaches the limit" — a silent truncation that drops the
  *deepest, most specific* files, since it accumulates root-first.
- Workarounds: raise the limit, or spread instructions across nested directories.

### Refresh

Rebuilt at startup and "once per run; in the TUI this usually means once per launched session."

### As a memory substrate — assessment

Attractive: it is Markdown in the vault, human-editable, Obsidian-compatible, needs no retrieval machinery, and is
loaded automatically.

But it is a poor fit for *evolving* memory:

- **32 KiB total, silently truncated.** Accumulated memory grows without bound; AGENTS.md does not.
- **Always-on, unfiltered.** Every byte is in every prompt regardless of relevance — the opposite of the map's "the
  right memory surfaces at the right moment."
- **Refreshed once per run**, so a long job cannot learn something and immediately re-read it as instruction.
- Truncation drops the most specific guidance first, which is the reverse of what you want.

Realistic split: AGENTS.md as the small, stable **operating manual** (conventions, tone, guardrails, where the vault
lives); a separate retrieval mechanism over vault notes for the growing corpus. Note the undocumented
`~/.codex/memories_1.sqlite` **[verified — exists on disk; purpose and stability unknown]** suggests OpenAI is building
something native here; worth re-checking before committing to a design.

Adjacent mechanisms worth knowing: `codex-rs/core-skills` + `docs/skills.md` (→ `developers.openai.com/codex/skills`),
`~/.codex/skills`, `~/.codex/rules`, `~/.codex/plugins`, and `codex-rs/hooks` for lifecycle hooks **[verified — present
in repo/on disk; not investigated in depth]**.

---

## 8. Licence and embedding

### Licence

**Apache License 2.0** throughout **[verified]**:

- Root [`LICENSE`](https://github.com/openai/codex/blob/main/LICENSE): "Copyright 2025 OpenAI", standard Apache-2.0.
- `codex-cli/package.json` → `"license": "Apache-2.0"` (`@openai/codex`).
- `sdk/typescript/package.json` → `"license": "Apache-2.0"` (`@openai/codex-sdk`).
- [`NOTICE`](https://github.com/openai/codex/blob/main/NOTICE): includes Ratatui-derived code under MIT.

No CLA required for *use* (`docs/CLA.md` governs contributions only). Apache-2.0 is permissive, patent-granting, and
compatible with essentially any open-source licence this project might pick. Obligations if you redistribute: preserve
the licence and `NOTICE`, state changes, no trademark rights. **Nothing here obstructs bundling or depending on Codex
CLI in an open-source project.**

> **Caveat.** The Apache-2.0 licence covers the *software*. It does not cover the *service*: using Codex against
> OpenAI's models is governed by OpenAI's terms, and ChatGPT-plan authentication in particular is tied to a personal
> subscription. That is a per-self-hoster concern, not a distribution blocker, but the README's framing ("use Codex as
> part of your Plus, Pro, Business, Edu, or Enterprise plan") is aimed at a human at a keyboard, not a bot running
> 24/7. **I did not locate an authoritative statement on whether ChatGPT-plan auth is permitted for an always-on
> automated agent — unestablished, and worth resolving before recommending it in setup docs.** API-key auth is the
> documented recommendation for automation.

### What an end user must install

**Runtime — one of:**
```bash
npm install -g @openai/codex                                  # npm
brew install --cask codex                                     # Homebrew
curl -fsSL https://chatgpt.com/codex/install.sh | sh           # macOS/Linux installer
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"   # Windows
```
Or a platform binary from GitHub Releases (`codex-aarch64-apple-darwin.tar.gz`,
`codex-x86_64-unknown-linux-musl.tar.gz`, …). Standalone installers pull from `releases.openai.com/codex` with a GitHub
Releases fallback (`CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false` forces GitHub).

The CLI is a **compiled Rust binary**; the npm package is a thin launcher (`bin/codex.js`) over per-platform vendor
packages. `engines: node >= 16` for the CLI package, `>= 18` for the SDK.

**For SDK-based embedding**, both are needed — `@openai/codex-sdk` locates the binary through
`@openai/codex`'s optional platform dependencies **[source]**:

```bash
npm install @openai/codex-sdk @openai/codex
```

Platform coverage: darwin x64/arm64, linux x64/arm64 (musl), win32 x64/arm64 **[source]**. Anything else throws
`Unsupported platform`.

**Authentication — one of** **[docs]**:

| Method | How |
|---|---|
| ChatGPT sign-in | `codex login` (browser). Plus/Pro/Business/Edu/Enterprise. |
| API key | `OPENAI_API_KEY`, or `CODEX_API_KEY` inline. **Recommended for automation.** |
| Device code | `codex login --device-auth` (beta) — headless boxes |
| Copy credentials | move `~/.codex/auth.json` from a machine with a browser |
| SSH tunnel | forward `localhost:1455` for the OAuth callback |
| Enterprise | `CODEX_ACCESS_TOKEN` for non-interactive workspace access |

Credentials land in `~/.codex/auth.json` (or the OS keyring, per `cli_auth_credentials_store` = `file|keyring|auto`).
`auth.json` holds live access tokens — treat as a secret; a self-hosted deployment must mount it carefully.

The SDK injects `CODEX_API_KEY` on top of whatever `env` you supply **[source]**. The docs warn: *"Do not expose
`OPENAI_API_KEY` or `CODEX_API_KEY` to untrusted code in the same process environment"* — directly relevant, since the
agent runs model-authored shell commands. Use `shell_environment_policy` to strip them.

`codex doctor` diagnoses installation, config, auth and runtime health **[verified from `--help`]** — a good thing to
wire into the project's setup story.

---

## Implications and risks

### Is in-thread progress reporting achievable? — **Yes, comfortably.**

`codex exec --json` gives a clean JSONL stream over stdout with `thread.started` / `turn.started` / `item.started` /
`item.completed` / `turn.completed`, and typed items for commands, file changes, MCP tool calls, web searches,
reasoning summaries and a live todo list. That maps almost one-to-one onto Slack thread posts, and the `todo_list`
item (the only thing that emits `item.updated` in exec) is a natural fit for a single edit-in-place checklist message.
Item-level rather than token-level granularity is a *benefit* here — Slack rate limits make token streaming a
liability anyway.

Two real limits: `command_execution.aggregated_output` only arrives at completion, so a long build is silent while it
runs; and there is no delta stream at all in `exec`. If live command output or streaming reasoning turns out to matter,
`app-server` provides `item/commandExecution/outputDelta`, `item/agentMessage/delta`,
`item/reasoning/summaryTextDelta`, `turn/diff/updated` and per-connection notification opt-out — at the cost of
speaking an experimental JSON-RPC protocol.

### Can long jobs survive a restart? — **Yes, at turn granularity.**

Verified end-to-end. Sessions persist by default as append-only JSONL rollouts under
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; the `thread_id` from the first event both identifies the
thread and locates the file. `codex exec resume <id>` in a fresh process reuses the id, appends to the same file, and
restores context.

The gap: resumption is **turn-granular**. A crash 20 minutes into a turn cannot resume that turn — you start a new one.
The partial transcript *is* on disk, so the model isn't blind, but the job model must treat "turn" as the unit of
durability and must reconcile side effects (a branch already pushed, an issue already filed) itself. Two further
unknowns: no documented retention/pruning policy for `~/.codex/sessions` (plan to prune), and `--ephemeral` silently
disables all of it.

### What the project needs that Codex CLI does not appear to provide

1. **Approvals in the simple path.** `codex exec` hard-codes `approval_policy: Never` (`exec/src/lib.rs:427`). There is
   no way to surface a confirmation from `exec`. Interactive approval-with-nobody-at-a-terminal *is* solved — but only
   via `app-server`/`mcp-server`, which is documented as "experimental and subject to change without notice." **This is
   the sharpest architectural fork in the road**: `exec`+SDK is stable, ergonomic, TypeScript-native and cannot ask
   permission; `app-server` can ask permission, can `turn/steer` and `turn/interrupt` mid-flight, and streams deltas —
   but is unstable. The map's open "Permission model" question effectively decides which engine interface is used.

2. **Semantic guardrails on external actions.** The sandbox governs filesystem and network, not intent. Nothing
   distinguishes reading a PR from merging one. Safe unattended GitHub/Linear work must come from scoped tokens,
   `execpolicy` rules, and per-MCP-server `disabled_tools` — the project has to build this policy layer itself.

3. **Model-provider freedom.** `WireApi` has exactly one variant, `Responses`. Chat Completions support was *removed*
   (not deprecated) around 2026-02-01, and grepping the tree confirms the code path is gone. Any non-OpenAI backend
   must serve an OpenAI Responses API. For a self-hosted open-source tool whose users will reasonably expect
   "bring your own model," this is a genuine constraint to document up front — and it partly contradicts the framing of
   Codex as a neutral engine.

4. **A memory substrate.** AGENTS.md is capped at 32 KiB, silently truncated deepest-first, always-on regardless of
   relevance, and refreshed once per run. It works as a stable operating manual; it cannot be the evolving memory. The
   project still owns retrieval. (Watch `~/.codex/memories_1.sqlite` — undocumented, but OpenAI appears to be building
   here.)

5. **Cost control.** `turn.completed.usage` reports tokens *after* the fact. There is no budget ceiling, no
   max-turns/max-tokens kill switch. The project must enforce spend limits externally — the map's "Cost and model
   policy" item gets no help from Codex.

6. **Stability itself.** Multiple alpha releases per day; the in-repo docs were replaced by redirect stubs; the
   documentation host moved from `developers.openai.com` to `learn.chatgpt.com` mid-research; `--full-auto` was
   removed; `wire_api = "chat"` was removed; `ollama-chat` was removed. For an open-source project that self-hosters
   install and forget, **pin the Codex version explicitly** and treat upgrades as deliberate work. One strong
   mitigation if `app-server` is chosen: `codex app-server generate-ts --out DIR` emits bindings matching the exact
   binary version, turning protocol drift into a compile error rather than a runtime surprise.

### Two capabilities worth noting that the project has *not* yet scoped

- **`dynamicTools`** (app-server, experimental, requires `capabilities.experimentalApi = true`): the client registers
  its own tool schemas and Codex calls back via `item/tool/call`, with the client returning content items. This would
  let GitHub, Linear and "post an update to Slack" be *in-process TypeScript functions* rather than MCP servers — a
  materially different connector architecture from the one the map assumes.
- **`turn/steer` and `turn/interrupt`**: a human could redirect or stop a running job from the Slack thread mid-flight.
  Nothing in the map contemplates this, and it is a natural fit for "delegate and walk away, but glance back."

---

## Sources

**Repository** — `openai/codex` @ `8495963ac6d15a3ac891517d979f5509d55605c0` (2026-07-27), read from a local clone:

- [`README.md`](https://github.com/openai/codex/blob/main/README.md)
- [`LICENSE`](https://github.com/openai/codex/blob/main/LICENSE), [`NOTICE`](https://github.com/openai/codex/blob/main/NOTICE)
- [`codex-cli/package.json`](https://github.com/openai/codex/blob/main/codex-cli/package.json)
- [`sdk/typescript/README.md`](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), `package.json`, `src/{exec,thread,events,items,codexOptions,threadOptions,turnOptions}.ts`
- [`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs)
- [`codex-rs/exec/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)
- [`codex-rs/exec/src/exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)
- [`codex-rs/exec/src/event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
- [`codex-rs/model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)
- [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [`codex-rs/exec-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md)
- [`codex-rs/docs/codex_mcp_interface.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)
- [Discussion #7782 — Chat Completions removal](https://github.com/openai/codex/discussions/7782)

**Official documentation** (`developers.openai.com/codex/*` → `learn.chatgpt.com/docs/*`):

- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Security / sandboxing](https://learn.chatgpt.com/docs/security)
- [Authentication](https://learn.chatgpt.com/docs/auth)

**Locally executed** — `codex-cli 0.145.0`: `codex --help`, `codex exec --help`, `codex mcp --help`,
`codex mcp add --help`, a live `codex exec --json` run, a live `codex exec resume` run, and inspection of
`~/.codex/sessions/**/rollout-*.jsonl`.
