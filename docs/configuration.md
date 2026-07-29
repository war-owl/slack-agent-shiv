# Configuration

One file, and secrets in the environment.

`open-agent.config.json` describes the instance: where the Vault is, what stops a runaway
Job, which model, which connectors, which GitHub App. It **names** credentials — the
environment variable each one lives in — and never contains them, exactly as a
[Skill](../CONTEXT.md#skill) does. So it is safe to commit, diff, and paste into an issue,
and `.env` is not configuration at all: it is the keyring.

The environment configures nothing else. Two sources for one setting is how an instance ends
up running with bounds nobody wrote down. The single exception is `CONFIG_PATH`, which says
where the file is and cannot live inside it.

Start from [`open-agent.config.example.json`](../open-agent.config.example.json). Every
section is optional; a missing file runs the shipped defaults, which is a Slack bot with a
Vault and no connectors.

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
defaults are in `src/config.ts` with the reasoning for each number; lower them freely.

The one to lower first is `turnTimeoutMs`. A Job is normally one Turn, so an hour is in
practice the ceiling on unattended spend, and the token budget cannot help: usage arrives at
turn completion, so it can refuse the *next* Turn but not stop the one that is spending.

### `engine`

`model`, `reasoningEffort`, and optionally `codexPath`. `low` effort is the right default
across many shallow Jobs; if considered answers come back thin, this is the first dial to
turn, not the prompt.

### `connectors`

Each entry is an MCP server ([ADR-0005](adr/0005-connectors-are-mcp-config.md)). The wrapper
is not in the tool path: Codex holds the connection and calls it directly, so a connector is
configuration rather than code.

```json
{
  "name": "linear",
  "url": "https://mcp.linear.app/mcp",
  "bearerTokenEnvVar": "LINEAR_API_KEY",
  "writeTools": ["save_issue", "save_comment"],
  "pinnedTools": ["get_issue", "list_issues", "…every tool it advertises"],
  "disabledTools": []
}
```

- **`writeTools`** — which of its tools act on the world, so every use of one is appended to
  the Thread as a permanent record. Required, not defaulted: an absent list means every
  Write through this connector leaves no trace.
- **`pinnedTools`** — the whole inventory, as it stood when a human last reviewed it.
  Startup probes the live server and **refuses to run** when the two disagree, naming what
  appeared and what went away. This is not a formality: Linear shipped `merge_diff` into a
  surface nobody re-reviewed, and MCP's own `destructiveHint` annotations cannot be trusted
  to flag that sort of thing.
- **`disabledTools`** — extra tools to disable. The irreversible ones are blocked for you
  (below), so this is for a judgement this project has not made.

**Adding a connector is a first-run review.** Leave `pinnedTools` empty and startup refuses,
printing the inventory to paste in. That is on purpose: the one moment somebody is certainly
watching is the moment they add the connector, and an inventory adopted without being read
is a review that never happened.

#### What is blocked for you

Generated per server from the pin, and delivered as Codex's `disabled_tools` — so the tool
does not exist from the coworker's point of view:

| Blocked | Why |
| --- | --- |
| `merge_diff` | Puts commits in a repository. Not undoable from a Thread. |
| `submit_diff_review` | Approves someone's code in the coworker's name. |
| `delete_*` (any server) | The commonest irreversible verb. |

The criterion is not "dangerous" but **"can a human undo this after noticing it in the
Thread?"** A wrong comment is embarrassing and stays available; Linear's `save_issue` is an
upsert and stays available too, because drawing that line at argument granularity is not
something the tool path can express.

Generated rather than configured so it cannot be forgotten and cannot be mistyped — a
deny-list naming a tool that does not exist is a boundary that silently is not there.

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
