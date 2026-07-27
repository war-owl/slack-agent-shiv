# How agents accumulate and recall memory

Research for the Slack coworker map. Resolves `issues/04-memory-patterns-research.md`.

**Date of research:** 2026-07-28. Several of the primary sources below are betas or research previews and move fast; re-verify before building against them.

**How to read this file.** Statements attributed to a cited source are **documented fact** — a claim the source itself makes, usually with the wording preserved. Anything in a block marked **[Synthesis]** is my reading, inference, or judgement, not something a source says. Where I could not establish something from a primary source, I say so explicitly rather than filling the gap.

**Scope note.** The engine decision (OpenAI Codex CLI, running locally, filesystem access, MCP client) means the file-based section is load-bearing and the hosted-store section is comparison material. I have documented the hosted options at the depth the ticket asked for, but weighted the investigation as instructed.

---

## 0. The two-line summary

Every production system surveyed converges on the same shape: **a small always-loaded index, plus a larger corpus loaded on demand.** They disagree only about what the index is (a hand-written instructions file, an agent-written `MEMORY.md`, a set of skill descriptions, a mounted directory), and about who is allowed to write to it.

The second convergence is less advertised: **nobody has solved decay.** The most sophisticated primary sources — Anthropic's `dreams` API, Codex's background memory generation — treat curation as a separate, asynchronous, model-driven pass over accumulated memory, and both of them are new enough to be labelled research preview or recently shipped.

---

## 1. File-based memory as a pattern

### 1.1 Codex CLI — `AGENTS.md` (human-written) and `~/.codex/memories/` (agent-written)

Codex has **two distinct mechanisms**, and the distinction matters for this project.

**`AGENTS.md` — human-written instructions, always loaded.**

The [AGENTS.md convention](https://agents.md) describes the file as "a **README for agents**: a dedicated, predictable place to provide the context and instructions to help AI coding agents work on your project." It is "just standard Markdown. Use any headings you like; the agent simply parses the text you provide." Nesting is supported for monorepos, with the rule that "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." The site claims over 60,000 open-source projects use it, and lists Codex, Jules, Aider, Cursor, VS Code, GitHub Copilot, and Zed as supporting tools.

Codex's own implementation ([Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) is more specific about discovery and precedence:

1. Global scope: `~/.codex/AGENTS.override.md` if present, otherwise `~/.codex/AGENTS.md`
2. Project scope: walking from the Git root down to the current directory, checking each level for `AGENTS.override.md`, then `AGENTS.md`, then configured fallback filenames
3. Merge order: files concatenate from root down. "Files closer to your current directory override earlier guidance because they appear later in the combined prompt."

Note that "override" here is positional, not structural — a later file wins because the model reads it last, not because anything is parsed and merged. This is the same mechanism Claude Code uses (§1.2) and the same limitation applies.

**There is a hard size cap.** The [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `project_doc_max_bytes` as the "Maximum bytes read from `AGENTS.md` when building project instructions." The AGENTS.md guide states the default is **32 KiB** across the combined set, and advises: "Raise the limit or split instructions across nested directories when you hit the cap." Related keys: `project_doc_fallback_filenames` ("Additional filenames to try when `AGENTS.md` is missing") and `model_instructions_file` ("Replacement for built-in instructions instead of `AGENTS.md`").

> **[Synthesis]** The 32 KiB cap is the single most concrete number in this whole document, and it is a hard design constraint for this project. It is a *silent truncation*, not an error — an always-loaded memory index that grows past it starts losing its tail without telling anyone. Whatever the vault layout, the always-loaded slice has to be budgeted well under 32 KiB and something has to enforce that.

**`~/.codex/memories/` — agent-written memory, generated in the background.**

Separately, Codex ships a first-party memory feature ([Memories](https://learn.chatgpt.com/docs/customization/memories)). The documented behaviour:

- Storage is at `~/.codex/memories/`, containing "summaries, durable entries, recent inputs, and supporting evidence" from prior chats.
- Generation is **asynchronous and background**, not at end-of-turn: Codex "waits until a chat has been idle long enough to avoid summarizing work that's still in progress," and "skips active or short-lived sessions."
- Secrets are redacted from generated memory fields, but the docs still say plainly: **"Don't store secrets in memories."**
- Scope is **global to the Codex installation, not per-project.**
- Enabled via Settings > Personalization or `[features] memories = true` in `config.toml`. Config keys: `memories.use_memories` (default `true`; when false, Codex skips injecting existing memories into future sessions), `memories.generate_memories` (default `true`), `memories.disable_on_external_context` (default `false`; when enabled, threads that used MCP tools, web search, or tool search are kept out of memory generation).
- `/memories` in the TUI controls per-chat behaviour — whether the current chat can use existing memories and whether it can feed future ones — without changing global settings.

> **[Synthesis]** Three things about Codex memories bear directly on this project. First, **it is global, not per-project** — which is exactly wrong for a coworker whose whole value is per-project accumulation, so we would be building alongside it rather than on top of it. Second, `memories.disable_on_external_context` exists because OpenAI evidently considers MCP/web-search-derived content a memory-poisoning surface; a Slack coworker reading GitHub and Linear over MCP is *entirely* external context, so if we relied on Codex memories at all, that default matters. Third — and most usefully — the *shape* is worth stealing: background generation after idle, not synchronous write-at-end-of-turn. A Slack bot that finishes a job and immediately writes memories is summarising work whose outcome it hasn't seen reviewed.

**Codex's tool surface** ([Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli)): file inspection and edits, running local commands and dev tools, MCP servers (local or remote, via `codex mcp`), packaging repeatable instructions as skills, and `--search` for live web search. The docs do not explicitly enumerate grep/glob-style tools by name — I could not establish from primary sources whether Codex exposes dedicated search tools or expects the model to reach for `rg`/`grep` through shell. Either way, shell access means grep-over-a-vault is available.

### 1.2 Claude Code — `CLAUDE.md` and auto memory

Claude Code's [memory documentation](https://code.claude.com/docs/en/memory) is the most detailed primary source found, and it draws the distinction this project needs most sharply. It states outright that there are **two complementary memory systems**:

| | CLAUDE.md files | Auto memory |
| :--- | :--- | :--- |
| **Who writes it** | You | Claude |
| **What it contains** | Instructions and rules | Learnings and patterns |
| **Scope** | Project, user, or org | Per repository, shared across worktrees |
| **Loaded into** | Every session | Every session (first 200 lines or 25KB) |
| **Use for** | Coding standards, workflows, project architecture | Build commands, debugging insights, preferences Claude discovers |

Both are "loaded at the start of every conversation," and — importantly — "Claude treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook instead."

**CLAUDE.md conventions:**

- Load order runs broadest to most specific: managed policy → user (`~/.claude/CLAUDE.md`) → project (`./CLAUDE.md` or `./.claude/CLAUDE.md`) → local (`./CLAUDE.local.md`). Files in the directory hierarchy *above* the working directory load in full at launch; **files in subdirectories load on demand when Claude reads files in those directories.**
- "All discovered files are concatenated into context rather than overriding each other."
- Imports use `@path/to/import` syntax, recursive to "a maximum depth of four hops." Import parsing skips code spans and fenced blocks, so `` `@README` `` stays literal.
- **Size guidance is explicit:** "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." And: "Splitting into `@path` imports helps organization but doesn't reduce context, since imported files load at launch."
- **Consistency is called out as a failure mode:** "if two rules contradict each other, Claude may pick one arbitrarily. Review your CLAUDE.md files, nested CLAUDE.md files in subdirectories, and `.claude/rules/` periodically to remove outdated or conflicting instructions."
- `.claude/rules/*.md` supports **path-scoped rules** via YAML frontmatter — `paths: ["src/api/**/*.ts"]` — which "only load into context when Claude works with matching files." Rules without a `paths` field load unconditionally.
- On the AGENTS.md relationship: "Claude Code reads `CLAUDE.md`, not `AGENTS.md`." The documented workaround is a `CLAUDE.md` containing `@AGENTS.md` plus Claude-specific additions, or a symlink.

**Auto memory** is the closest documented analogue to what this project wants:

- On by default (`autoMemoryEnabled`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to disable).
- Storage: `~/.claude/projects/<project>/memory/`, keyed off the git repository so all worktrees share one directory. Machine-local; "Files are not shared across machines or cloud environments."
- Layout is **an index plus topic files**:
  ```
  MEMORY.md          # Concise index, loaded into every session
  debugging.md       # Detailed notes on debugging patterns
  api-conventions.md # API design decisions
  ```
- "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation. Content beyond that threshold is not loaded at session start."
- **The index limit is actively enforced.** After a write, Claude Code measures the file: if near the limit it "reminds Claude to shorten it: keep one line per entry, move detail into topic files, and merge or drop stale entries." If over, "the write still succeeds, but Claude Code returns an error telling Claude to rewrite the index, because everything past the limit is dropped on the next load."
- "Topic files like `debugging.md` or `patterns.md` are not loaded at startup. Claude reads them on demand using its standard file tools when it needs the information."
- **Freshness is tracked in frontmatter:** when Claude writes a memory file that begins with YAML frontmatter, Claude Code records a `modified` field as an ISO 8601 timestamp. "The timestamp shows how current the fact is, both to you and to Claude when it reads the memory back." Claude Code "never adds frontmatter to a file that has none."
- "Claude doesn't save something every session. It decides what's worth remembering based on whether the information would be useful in a future conversation."
- Auto memory files are "plain markdown you can edit or delete at any time," browsable with `/memory`.
- Auto memory is **not** inherited by subagents (except forks); a subagent's own auto memory is a separate directory.

> **[Synthesis]** This is the single most transferable design in the survey, and it is transferable *because* it is just files. The four moving parts are: (a) one index file with a hard, enforced load budget; (b) topic files the agent reads on demand with ordinary file tools; (c) the index's job is to say *what is stored where*, not to store it; (d) a machine-written `modified` timestamp so both human and agent can see staleness. Every one of those is reproducible under Codex CLI with nothing but a directory and a paragraph of `AGENTS.md`. The one part we would have to build ourselves is the enforcement: Claude Code measures the index after every write and errors when it overflows. Without that, the index grows past the load budget and silently loses its tail — the same failure as Codex's 32 KiB cap.

### 1.3 Other open-source harnesses

**OpenHands** ([Microagents / Skills overview](https://docs.openhands.dev/openhands/usage/microagents/microagents-overview)) has the most explicit taxonomy of *loading modes* found anywhere. Five skill categories: permanent context (repository-wide, e.g. `AGENTS.md`), keyword-triggered, path-triggered rules, organization skills, and global skills. Three loading models: "Always-on context injected at conversation start," "On-demand skills triggered by user keywords or agent-invoked lookups," and "Path-triggered rules deterministically applied to matching files."

Directories, in precedence order: `.agents/skills/` (primary, recommended), `.openhands/skills/` (deprecated), `.openhands/microagents/` (deprecated). Repository-level skills override user-level `~/.agents/skills/`. Frontmatter is required for keyword-triggered and path-triggered skills, optional for general ones.

Two normative statements are directly relevant here: "For repository-wide, always-on instructions, prefer a root-level AGENTS.md file," and "On-demand skills help keep the system prompt smaller because the agent sees a summary first and reads the full content only when needed." (Historically, repository instructions lived in `.openhands/microagents/repo.md`; that path is now marked deprecated in favour of `.agents/skills/`.)

**Cline Memory Bank** ([docs.cline.bot](https://docs.cline.bot/best-practices/memory-bank)) is the most prescriptive file schema. Six core markdown files in `memory-bank/`, hierarchically related:

- `projectbrief.md` — foundation document; "source of truth for project scope"
- `productContext.md` — rationale, problems solved, UX objectives
- `systemPatterns.md` — architecture, design patterns, component relationships
- `techContext.md` — stack, setup, constraints, dependencies
- `activeContext.md` — current work focus, recent changes, next steps; "changes most frequently"
- `progress.md` — completed work, remaining tasks, known issues

The protocol is unusually strict: Cline "MUST read ALL memory bank files at the start of EVERY task - this is not optional." The framing is that "after every memory reset, I begin completely fresh. The Memory Bank is my only link to previous work." Curation is human-triggered: the phrase **"update memory bank"** forces a comprehensive review across all files. The docs give **no guidance on staleness thresholds or maximum file sizes** — I checked specifically and found none.

> **[Synthesis]** Cline is the interesting negative example. Read-everything-every-time is simple and it works at six files. It does not survive a vault of hundreds of notes, and the docs' silence on size limits is exactly the gap Claude Code fills with its 200-line index budget. Cline also shows that human-triggered curation ("update memory bank") is a real, shippable design point — it puts a human in the loop at the moment of consolidation, which is cheap and avoids the whole class of wrong-belief-written-autonomously problems. For a v1 that wants to be deliberately thin, "the human types a phrase and the agent consolidates" is a defensible answer.

**Aider** ([Specifying coding conventions](https://aider.chat/docs/usage/conventions.html)) uses a `CONVENTIONS.md` loaded with `/read CONVENTIONS.md` or `aider --read CONVENTIONS.md`: "This way it is marked as read-only, and cached if prompt caching is enabled." Aider's separate [repository map](https://aider.chat/docs/repomap.html) is a generated, not accumulated, index: "a list of the files in the repo, along with the key symbols which are defined in each file." Notably, `aider --show-repo-map > map.md` can dump the map for another repo to read as a file — an explicit index-as-artifact pattern.

**Anthropic Agent Skills** ([overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)) is the cleanest statement of the progressive-disclosure ladder, with token costs attached:

| Level | When loaded | Token cost | Content |
| --- | --- | --- | --- |
| Level 1: Metadata | Always (at startup) | ~100 tokens per Skill | `name` and `description` from YAML frontmatter |
| Level 2: Instructions | When Skill is triggered | Under 5k tokens | SKILL.md body |
| Level 3+: Resources | As needed | None until accessed | Bundled files; scripts run via bash, only output enters context |

"This lightweight approach means you can install many Skills without context penalty: until a Skill is triggered, only its name and description occupy context." And: "Files don't consume context until accessed, so Skills can include comprehensive API documentation, large datasets, or extensive examples. There's no context penalty for bundled content that isn't used."

The `description` field is doing the retrieval work: "The `description` is what Claude matches your request against when determining whether to trigger the Skill, so it must say both what the Skill does and when to use it." Constraints: `name` max 64 chars, lowercase/numbers/hyphens; `description` non-empty, max 1024 chars, no XML tags.

**Letta / MemGPT** ([memory blocks](https://docs.letta.com/guides/agents/memory-blocks)) is the non-file counterexample worth knowing. Memory blocks are structured units with four fields — `label`, `description`, `value`, `limit` (a character cap) — "prepended to the agent's prompt in an XML-like format," so they are "always visible - no retrieval needed." Blocks can be shared across agents ("Update once, visible everywhere") and support a `read_only` field. The docs stress: "When making memory blocks, it's crucial to provide a good `description` field that accurately describes what the block should be used for." Letta separately maintains out-of-context archival memory and (per [Letta's blog](https://www.letta.com/blog/agent-memory/)) sleep-time agents that "share memory with the main agent and perform ongoing consolidation during idle periods."

> **[Synthesis]** Letta's `limit` per block and Claude Code's 200-line index cap are the same idea reached independently: **a memory slot that is always in context must have an enforced size, or it eats the context window.** The `description`-drives-selection pattern recurs a third time here (Skills, Letta, OpenHands triggers). If there is one design rule the whole survey agrees on, it is: *every memory unit needs a short machine-readable statement of when it is relevant, separate from its content.*

### 1.4 What makes file-based memory work, and how it degrades

**Why it works** (documented):

- Cost is near-zero and there is no vendor coupling. Files are the substrate every one of these harnesses already has.
- Auditability: Claude Code says plainly, "Auto memory files are plain markdown you can edit or delete at any time." Cline, OpenHands, Codex, and Aider are all the same. The human can read, fix, and delete without an API.
- It composes with progressive disclosure for free — a file that isn't read costs nothing (Agent Skills: "There's no context penalty for bundled content that isn't used").
- It composes with version control. Anthropic's [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) pairs a `claude-progress.txt` with git history: agents "read the git logs and progress files to get up to speed on what was recently worked on."

**How it degrades as the corpus grows** (documented, with sources):

1. **Silent truncation at the load cap.** Codex truncates the combined `AGENTS.md` set at `project_doc_max_bytes` (32 KiB default). Claude Code drops everything past 200 lines / 25 KB of `MEMORY.md`. Neither surfaces this to the user as a first-class error at read time; Claude Code only errors *at write time* if it detects overflow.
2. **Adherence falls before the cap does.** Claude Code: "Longer files consume more context and reduce adherence" — and the recommendation is 200 lines, an order of magnitude below its own 25 KB limit. Adherence degrades continuously; the cap is just where content vanishes.
3. **Context rot.** [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases." Framed as an "attention budget."
4. **Contradictions become arbitrary.** Claude Code: "if two rules contradict each other, Claude may pick one arbitrarily." Since nested files are *concatenated*, not merged, nothing detects the contradiction.
5. **Cross-team noise in large trees.** Claude Code ships `claudeMdExcludes` specifically because "In large monorepos, ancestor CLAUDE.md files may contain instructions that aren't relevant to your work." The existence of the escape hatch is evidence of the failure mode.
6. **Instructions are context, not enforcement.** Claude Code: "Claude reads it and tries to follow it, but there's no guarantee of strict compliance, especially for vague or conflicting instructions." A memory that is *loaded* is not thereby *obeyed*.

---

## 2. Hosted / tool-based memory (documented for comparison)

### 2.1 Anthropic's client-side memory tool

[Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). GA on the Messages API, no beta header, all Claude 4+ models. Declared as `{"type": "memory_20250818", "name": "memory"}` — that entry "is the entire configuration."

**The key architectural fact:** "The memory tool operates client-side: Claude requests file operations, and your application executes them. You control where and how the data is stored through your own infrastructure." And: "The `/memories` path is a prefix that your handler maps onto real storage, such as a per-user directory or keys in a database."

**The six commands the backend must implement**, with their documented contracts:

| Command | Params | Contract highlights |
| --- | --- | --- |
| `view` | `path`, optional `view_range` | Directories: listing "up to 2 levels deep," human-readable sizes, tab-separated, excluding hidden items and `node_modules`. Files: contents with 6-char right-aligned 1-indexed line numbers, tab separator. Error on >999,999 lines. |
| `create` | `path`, `file_text` | Returns `"File created successfully at: {path}"`. Reference behaviour errors if the file exists, but "Claude's tool description says `create` 'creates or overwrites' a file, so expect `create` calls on paths that already exist." |
| `str_replace` | `path`, `old_str`, optional `new_str` | Omitting `new_str` deletes `old_str`. Must error on zero matches and on multiple matches (listing line numbers). |
| `insert` | `path`, `insert_line`, `insert_text` | Inserts *after* `insert_line`; `0` inserts at the beginning. |
| `delete` | `path` | Recursive for directories. "The tool description tells Claude it cannot delete the `/memories` directory itself, so reject a `delete` whose path is the memory root." |
| `rename` | `old_path`, `new_path` | Must error rather than overwrite an existing destination. Reject renaming the memory root. |

**The API injects a system prompt automatically** when the tool is present — you do not send it:

```
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the `view` command of your `memory` tool to check for earlier progress.
2. ... (work on the task) ...
   - As you make progress, record status / progress / thoughts etc in your memory.
ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.
```

Anthropic ships helpers: `BetaAbstractMemoryTool` (Python, C#), `betaMemoryTool` (TypeScript), `BetaMemoryToolHandler` (Java), plus a ready-made `BetaLocalFilesystemMemoryTool` for Python and TypeScript. Go, Ruby, and PHP have no helper.

**Security guidance** (the doc is unusually direct that these are the caller's problem): path traversal is called out with a warning — "A malicious path such as `/memories/../../secrets.env` can reach files outside the `/memories` directory. Your implementation must validate every path in every command." Suggested safeguards: validate paths start with `/memories`, canonicalise and verify containment, reject `../` / `..\\`, watch for URL-encoded traversal (`%2e%2e%2f`), use built-in path utilities. Also: "Track memory file sizes and cap how large a file can grow"; "Periodically delete memory files that haven't been accessed in a long time"; on sensitive data, "Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes the file."

**What it gives you that plain files do not:** [Synthesis] Honestly — very little, for this project. It gives you (a) a fixed six-command protocol so the model's memory operations arrive as structured tool calls you can log, gate, or redact centrally rather than as arbitrary shell/edit calls; (b) the auto-injected memory protocol prompt; (c) an interception point where you can strip secrets before the write lands. That's a real seam. But it is an Anthropic-API-side tool: it presupposes you own the Messages API loop. Under Codex CLI you don't — Codex owns the loop and already has file tools. Reimplementing the six commands as an MCP server would be possible but would buy the interception seam at the cost of duplicating what Codex's own file tools already do.

### 2.2 Anthropic Managed Agents memory stores

[Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory). Public beta. Memory-store endpoints use the `agent-memory-2026-07-22` beta header (note: *not* `managed-agents-2026-04-01`; sending both on a memory-store request returns 400).

**Object model:**

| Object | ID prefix | Scope |
| --- | --- | --- |
| Memory store | `memstore_...` | Workspace |
| Memory | `mem_...` | Store; addressed by `path` |
| Memory version | `memver_...` | Immutable snapshot per mutation |

**Addressing.** A store is "a workspace-scoped collection of text documents optimized for Claude." Each memory "is addressed by a path and can be read and edited directly through the API or Console, allowing for tuning, importing, and exporting." Individual memories are capped at **100 kB (~25k tokens)**; a store holds **max 2,000 memories**. The docs advise: "Structure memory as many small focused files, not a few large ones."

**Mounting.** "When you attach a store to a session, it is mounted as a directory inside the session's sandbox. The agent reads and writes it with the same file tools it uses for the rest of the filesystem, and a note describing each mount is automatically added to the system prompt, telling the agent where to look."

Mechanically: attached in the session's `resources[]` at **creation time only** — "adding or removing one from a running session is not supported." Mounted under `/mnt/memory/<slug>/`, where the slug is the store's display name lowercased with non-alphanumeric runs collapsed to hyphens; the exact path is returned in `mount_path` and the docs say to read it from there rather than construct it. Writes under the mount persist back to the store; "writes to any other path under `/mnt/memory/` land in container-local scratch and are lost when the session ends." Max **8 memory stores per session**. `access` is `read_write` (default) or `read_only`, and is "enforced at the filesystem level." An optional per-session `instructions` field (max 4,096 chars) is shown to the agent alongside the store's `name` and `description` — and the `description` "is passed to the agent, telling it what the store contains."

**Versioning.** "Every change to a memory creates an immutable **memory version**, giving you an audit trail and point-in-time recovery for everything the agent writes." Each version records `operation` (`created`/`modified`/`deleted`) and `created_by` — an actor with type `session_actor` / `api_actor` / `user_actor`. Versions belong to the store, not the memory, and "survive even after the memory itself is deleted, so the audit trail stays complete." Retention: "Versions are retained for 30 days; however, the recent versions are always kept regardless of age." There is **no restore endpoint** — "to roll back, retrieve the version you want and write its `content` back with `memories.update`."

**Redaction.** "Redact scrubs content out of a historical version while preserving the audit trail (who did what, when). Use it for compliance workflows such as removing leaked secrets, PII, or user deletion requests." It clears `content`, `content_sha256`, `content_size_bytes`, and `path`, keeping everything else. Critical precondition: **"A version that is the current head of a live memory cannot be redacted. Write a new version first (or delete the memory), then redact the old one."**

**Preconditions on updates.** `memories.update` accepts an optimistic-concurrency precondition: `{"type": "content_sha256", "content_sha256": ...}`. "The update only applies if the stored content hash still matches the one you read; on mismatch, re-read the memory and retry against the fresh state." Mismatch returns 409 `memory_precondition_failed_error`. `memories.create` does not overwrite — a path collision returns 409 `memory_path_conflict_error` with a `conflicting_memory_id`.

**Prompt-injection warning, verbatim:** "Memory stores attach with `read_write` access by default. If the agent processes untrusted input (user-supplied prompts, fetched web content, or third-party tool output), a successful prompt injection could write malicious content into the store. Later sessions then read that content as trusted memory. Use `read_only` for reference material, shared lookups, and any store the agent does not need to modify."

**Documented curation practices:** use focused stores rather than one large one (each has its own 2,000 cap); "Condense or prune before the store fills up" with `memories.delete` or a dreaming session; attach a fresh store and demote the old one to `read_only` when a store outgrows its scope; limit write access. When a store hits 2,000 memories, "writes to new memories fail: both direct `memories.create` calls and the agent's file writes to unmapped paths. Existing memories remain readable and editable."

**What it gives you that files do not** (documented): immutable per-mutation versioning with actor attribution; a redact operation that scrubs content while preserving the audit trail; SHA-256 optimistic concurrency preconditions; filesystem-enforced read-only mounts; workspace-scoped sharing across sessions; and a management API for out-of-band review, seeding, import, and export.

> **[Synthesis]** The lock-in cost is total: the store lives in an Anthropic workspace, addressed by `memstore_`/`mem_` IDs, gated by a beta header, and mounted only into Anthropic-hosted sandboxes. There is no self-hosted mode. For an open-source self-hosted product on Codex CLI it is a non-starter — the ticket's expectation was right. But three of its five distinctive features are cheap to reimplement on a filesystem, and worth noting for the downstream spec: **git gives us versioning with actor attribution and point-in-time recovery for free** (and `git filter-repo` is the redact story, ugly as it is), and **content hashing gives us the precondition** if we ever have concurrent writers. Read-only mounts we can approximate with file permissions or just convention. The one thing we genuinely cannot get cheaply is a hosted management API — but a self-hoster with a vault on disk doesn't want one; they have Obsidian and a text editor.

### 2.3 Managed Agents "dreams" — consolidation as a separate pass

[Dreams](https://platform.claude.com/docs/en/managed-agents/dreams). Research preview, `dreaming-2026-04-21` beta header. This is the only primary source found that treats memory curation as a first-class, named operation, and its framing of the problem is the best statement of it I found anywhere:

> "Agents write to their memory stores as they work, but these writes are local and incremental: over many sessions a memory store accumulates duplicates, contradictions, and stale entries."

What a dream does: "A dream reads an existing memory store alongside past session transcripts, then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced."

Mechanics:

- Inputs: one pre-existing memory store, plus **1 to 100 sessions** of past transcripts.
- Output: a **separate** memory store. "The input store is never modified, so you can review the output and discard it if you don't like the result." You then either attach the output store to future sessions in place of the input, or delete/archive it.
- Asynchronous, "typically take minutes to a few hours, driven by the number of input transcripts." Statuses: `pending` / `running` / `completed` / `failed` / `canceled`.
- Optional `instructions` (max 4,096 chars) steers synthesis — "what to read closely, what to merge or drop, and how to structure the output store." Explicitly *not* an editor: "The pipeline is a synthesis pass over the inputs, not an editor applied to the text of the store, so imperative directives that target specific lines ('change sentence X to Y') generally produce no change."
- Billed at standard token rates; "Cost scales roughly linearly with the number and length of input sessions. Start with a small batch of sessions and scale up once you're satisfied with the curation quality."

> **[Synthesis]** Strip the API and the pattern is portable and cheap: *periodically, out of band, run a separate agent session whose only job is to read the memory corpus plus recent transcripts and write a reorganised copy; put the copy somewhere the human can diff before it becomes live.* In a git-backed vault that is a branch and a PR. The write-to-a-copy discipline is the load-bearing part — it makes curation reviewable and reversible, which is the difference between "the agent tidied its memory" and "the agent quietly deleted something true."

---

## 3. Recall — how the right memory reaches the model at the right moment

This is the crux, per the ticket. Four mechanisms, each with documented failure modes.

### 3.1 Always-loaded index files

**How it works.** A bounded slice of text enters context at session start unconditionally. Claude Code: CLAUDE.md files and the first 200 lines / 25 KB of `MEMORY.md`. Codex: the merged `AGENTS.md` set up to `project_doc_max_bytes`. Managed Agents: the mount note describing each memory store, plus the store's `description` and per-session `instructions`. Letta: memory blocks "prepended to the agent's prompt," always visible.

**Failure modes:**

- **Silent truncation.** Codex truncates the merged doc at 32 KiB by default; Claude Code drops content past its index limit ("everything past the limit is dropped on the next load"). The memory exists on disk and never reaches the model.
- **Adherence decay before truncation.** "Longer files consume more context and reduce adherence" (Claude Code). "As the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases" ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Contradictions resolved arbitrarily.** "If two rules contradict each other, Claude may pick one arbitrarily" (Claude Code). Concatenation means nothing detects the conflict.
- **Loaded ≠ obeyed.** "Claude treats them as context, not enforced configuration" — the recommended remedy for anything that *must* happen is a hook, not a memory.
- **Position matters and is fragile.** Claude Code's ordering rule is that later-loaded files are read last and therefore "win"; Codex says the same. That is a positional heuristic, not a merge, so a memory's authority depends on where its file sits in a tree.
- **Compaction gap.** Claude Code: project-root CLAUDE.md "survives compaction: after `/compact`, Claude re-reads it from disk and re-injects it. Nested CLAUDE.md files in subdirectories are not re-injected automatically." A long AFK job that compacts mid-run silently loses part of its memory.

> **[Synthesis]** For a Slack coworker running long AFK jobs, that last point deserves the most attention and got the least coverage in the sources. Compaction is *guaranteed* on a multi-hour job. Whatever is in the always-loaded slice must be re-injectable after compaction, and whatever the agent learned mid-job needs to be on disk before compaction eats the transcript — which is exactly what the memory tool's injected protocol says ("ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory").

### 3.2 Retrieval at question time (full-text vs embeddings)

I found **markedly less primary-source material here than for the other three mechanisms**, and that itself is a finding: the harnesses surveyed overwhelmingly do not do question-time retrieval over their memory. They do agent-initiated search instead (§3.3).

What is documented:

- **Anthropic argues against front-loading retrieval.** The memory tool docs: "Memory supports just-in-time context retrieval. Rather than loading all relevant information up front, an agent records what it learns in memory files and reads them back on demand." The context-engineering essay makes the case at length: agents should "maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools," mirroring how humans use "external organization and indexing systems like file systems, inboxes, and bookmarks."
- **Keyword triggers as cheap retrieval.** OpenHands keyword-triggered skills "activate only when their keywords appear in the conversation." Claude Code's path-scoped rules fire "when Claude reads files matching the pattern, not on every tool use." Agent Skills match the user's request against each skill's `description`. All three are retrieval — just with a very cheap matcher and a human-authored trigger.
- **Letta** maintains archival memory outside context, with semantic search over it, alongside always-visible core blocks — the clearest documented example of an embeddings tier in an agent memory system. The specific archival/search API surface was not covered in the memory-blocks page I fetched; I did not establish its details from primary sources.
- **Anthropic's tool-search tools** (`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`) are the closest first-party example of both retrieval families side by side — regex and BM25 — but they retrieve *tool schemas*, not memories.

**Failure modes** (mostly [Synthesis], flagged as such, because the sources do not enumerate them):

> **[Synthesis]** Full-text and embeddings fail differently and both fail on the same thing. Full-text (grep, ripgrep, BM25) misses paraphrase: a memory recorded as "she prefers squash-merge" never surfaces for "how should I land this PR?" Embeddings catch the paraphrase but introduce an index that must be rebuilt whenever a human edits a note in Obsidian — and in a vault the human edits freely, a stale index is a memory that exists and silently never surfaces. Both are also blind to *recency and supersession*: a top-k retriever will happily return a superseded belief with a high score, because relevance is not truth. And embeddings add a real self-hosting cost — an embedding model, a vector store, and a reindex daemon — against a corpus that for one human's projects is plausibly hundreds of notes, a size where ripgrep is instant.

### 3.3 Agent-initiated search (grep/glob over a vault)

**How it works.** The corpus is a directory. The agent has file tools and shell. It looks when it decides to look. This is what Claude Code does for topic files ("Claude reads them on demand using its standard file tools when it needs the information"), what Agent Skills does for Level 3 resources, what Managed Agents does for mounted stores ("The agent reads and writes it with the same file tools it uses for the rest of the filesystem"), and what Codex CLI can do since it can inspect files and run local commands.

The context-engineering essay describes the upside as progressive disclosure: "agents can assemble understanding layer by layer, maintaining only what's necessary in working memory. Each interaction yields context informing the next decision."

**Failure modes:**

- **It only fires if the agent decides to look.** This is the "memories that exist but never surface" case in its purest form. Every source that relies on on-demand loading pairs it with an always-loaded pointer: Claude Code's `MEMORY.md` "acts as an index of the memory directory... using `MEMORY.md` to keep track of what's stored where"; Agent Skills' Level 1 metadata; Managed Agents' auto-injected mount note. **The index is not an optimisation, it is the trigger.**
- **Description quality determines hit rate.** Agent Skills: the `description` "must say both what the Skill does and when to use it." Letta: "it's crucial to provide a good `description` field." A well-written memory with a vague pointer is unreachable.
- **Search cost is real.** Each look is tool calls and tokens. Anthropic notes the tradeoff directly: on-demand loading "help[s] keep the system prompt smaller because the agent sees a summary first and reads the full content only when needed" (OpenHands) — but the flip side is latency and turns.
- **No staleness signal by default.** A grep hit gives no indication of age. Claude Code's `modified` frontmatter timestamp exists precisely to fix this: "The timestamp shows how current the fact is, both to you and to Claude when it reads the memory back."

### 3.4 Progressive disclosure

Not a fourth alternative so much as the discipline that makes §3.1 and §3.3 work together. The Agent Skills table (§1.3) is the canonical statement: metadata always, body on trigger, resources on read, script *output* only. "Progressive disclosure ensures only relevant content occupies the context window at any given time."

**Failure modes:**

- **The ladder breaks at the top rung.** If Level 1 metadata is wrong, incomplete, or missing, Levels 2 and 3 are unreachable. Every failure of progressive disclosure is a failure of the index.
- **Index maintenance is itself work.** Claude Code has to actively police this: it measures `MEMORY.md` after every write and, if near the limit, "reminds Claude to shorten it: keep one line per entry, move detail into topic files, and merge or drop stale entries." Without that pressure the index becomes the corpus.
- **Depth costs turns.** Three levels of disclosure is three or more tool round trips before the model has what it needs.

### 3.5 The three named failure modes, mapped

| Failure | Where it comes from | What the sources do about it |
| --- | --- | --- |
| **Stale memories** | Nothing in a file says when it was written or whether it is still true. | Claude Code writes a `modified` ISO 8601 timestamp into frontmatter on every agent write. Managed Agents keeps immutable versions with actors and timestamps. The memory tool docs recommend: "Periodically delete memory files that haven't been accessed in a long time." Dreams replaces "stale or contradicted entries... with the latest value." |
| **Contradictory memories** | Concatenation and append-only accumulation. Claude Code: "Claude may pick one arbitrarily." Dreams: stores "accumulate duplicates, contradictions, and stale entries." | Claude Code tells you to review periodically and remove conflicts; provides `claudeMdExcludes` and `/doctor` trim suggestions. Dreams merges duplicates and resolves contradictions in a separate pass. Neither *detects* contradictions at write time. |
| **Memories that never surface** | The corpus is bigger than the always-loaded slice, and nothing points at the rest. | The index pattern, universally: `MEMORY.md`, Skill descriptions, mount notes, OpenHands trigger keywords, Letta block descriptions. Plus explicit prompting — the memory tool's injected protocol opens with "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE." |

---

## 4. Curation and decay

### 4.1 Update vs append

- **Append-only is not what any of these systems actually do.** The memory tool's command set includes `str_replace`, `insert`, `delete`, and `rename`, not just `create` — and Anthropic's suggested reinforcement prompt is explicit: "when editing your memory folder, always try to keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary."
- **Managed Agents separates create from update at the API level.** `memories.create` is path-addressed and refuses to overwrite (409 on collision); `memories.update` is ID-addressed and can change content, path (a rename), or both. So supersession-by-rename is a first-class operation: the docs' own example renames a memory to `/archive/2026_q1_formatting.md`.
- **Claude Code's index is rewritten, not appended.** The overflow error "tell[s] Claude to rewrite the index," and the guidance is "keep one line per entry, move detail into topic files, and merge or drop stale entries."

### 4.2 Supersession

The only primary source with an explicit supersession *mechanism* is Managed Agents: every mutation produces an immutable version, the live memory always returns the head, and rollback is "retrieve the version you want and write its `content` back." Archiving-by-rename into an `/archive/` path prefix is shown as the documented idiom.

Claude Code's `modified` frontmatter timestamp is a weaker but cheaper form: it does not supersede anything, but it lets both the human and the model reason about which of two claims is newer.

> **[Synthesis]** I found **no primary source that detects contradictions at write time.** Every system either resolves them later (dreams), leaves them to the human (Claude Code's "review periodically," Cline's "update memory bank"), or lets the model pick arbitrarily. This is a genuine open problem, not something we're failing to find prior art for.

### 4.3 Pruning, and who does it

Four documented owners:

1. **The model, inline.** Claude Code auto memory: "Claude doesn't save something every session. It decides what's worth remembering." The memory tool's prompting guidance tells Claude to rename and delete stale files.
2. **The harness, mechanically.** Claude Code measures `MEMORY.md` after writes and errors on overflow. Managed Agents hard-fails writes at 2,000 memories. Codex skips short-lived and still-active sessions and waits for idle before generating.
3. **A separate model pass, asynchronously.** Dreams. Letta's sleep-time agents "perform ongoing consolidation during idle periods."
4. **The human.** Cline's "update memory bank" phrase. Claude Code's `/memory` browser and "plain markdown you can edit or delete at any time." Managed Agents' management API "for building review workflows, correcting bad memories."

Time-based expiry appears exactly once, as advice rather than a feature: the memory tool docs' "Memory expiration: Periodically delete memory files that haven't been accessed in a long time."

> **[Synthesis]** The strongest curation designs put the model's *write* and the model's *curation* in different sessions. Dreams does it (separate job, separate output store). Letta does it (sleep-time agent). Codex does it (background generation after idle, not at end of turn). The reason is plausibly that an agent in the middle of a task is the worst possible judge of what was durable about it — it is still holding the local context that makes the ephemeral look important. That argues against "write memories at the end of the Slack job" and for "a second pass, later, over the transcript."

---

## 5. Overlap with notes — where memory and a vault note are the same thing

The ticket asks me to flag this explicitly and argue both sides, because a downstream ticket depends on it. Here is the case each way, then what the sources actually force.

### 5.1 The case that they are the same mechanism

Every hosted memory system surveyed **converges on a directory of Markdown files** and then hands the agent ordinary file tools:

- Managed Agents: "it is mounted as a directory inside the session's sandbox. The agent reads and writes it with the same file tools it uses for the rest of the filesystem." There are no dedicated memory tools — bash, read, write, edit, glob, grep.
- Anthropic memory tool: `/memories` "is a prefix that your handler maps onto real storage" — and Anthropic ships `BetaLocalFilesystemMemoryTool`, whose whole implementation is a directory.
- Claude Code auto memory: a directory of `.md` files with an index, "plain markdown you can edit or delete at any time."
- Codex memories: files under `~/.codex/memories/`.

Both a memory and a note are: Markdown on disk, human-readable, human-editable, agent-readable, agent-writable, findable by grep, linkable. The retrieval story is identical — index plus on-demand read. The curation story is identical — supersede, rename, delete. And the *audit* story is identical and is the strongest argument: the reason Anthropic built version history and redaction into Managed Agents is that a human needs to see and fix what the agent believes. A vault the human already opens in Obsidian gives that for free, with a better UI than any API.

**Two mechanisms means two of everything.** Two retrieval paths the agent must choose between, two curation policies, two places a fact about a project can live, and an inevitable class of bug where the note says one thing and the memory says another. Given that this project's entire premise is a vault the human also opens, a separate memory store is a second source of truth about the same subject matter.

### 5.2 The case that they must differ

The sources draw a distinction that survives the "it's all Markdown" observation. Claude Code draws it as a table (§1.2) and the two axes are **who writes it** and **what it's for**:

| | CLAUDE.md (≈ a note) | Auto memory (≈ a memory) |
| --- | --- | --- |
| Who writes it | You | Claude |
| What it contains | Instructions and rules | Learnings and patterns |
| Loaded into | Every session (in full) | Every session (index only, capped) |

Four differences that are load-bearing:

1. **Load discipline.** A memory index is *always* in context and therefore *must* be budgeted — 200 lines, 25 KB, a `limit` field. A note is read when relevant and can be any length. If memories live in the vault with no distinguished index, either the whole vault is always loaded (impossible) or nothing is (memories never surface). **The index is the thing that cannot be "just a note."**
2. **Write authority and trust.** A note may be human-authored and authoritative. A memory is machine-inferred and provisional. Managed Agents' injection warning is exactly about this: untrusted input can cause "a successful prompt injection [to] write malicious content into the store. Later sessions then read that content as trusted memory." Anything the agent writes and later reads back as fact is a distinct trust class from anything the human wrote, regardless of the file extension.
3. **Provenance and freshness expectations.** Claude Code stamps `modified` on agent-written memory files and explicitly "never adds frontmatter to a file that has none" — i.e. it declines to touch human files. Managed Agents records `created_by` with an actor type distinguishing `session_actor` from `user_actor`. Both systems consider "who wrote this and when" mandatory metadata for a memory and optional for a document.
4. **Curation eligibility.** Dreams rewrites a whole memory store. Claude Code's index-overflow error tells Claude to "merge or drop stale entries." Neither would be acceptable applied to a human's meeting notes. **An automated curation pass needs a bounded set of files it is allowed to rewrite.**

### 5.3 What I'd take from this

> **[Synthesis]** The mechanism is the same; the *policy* is not. Same substrate (Markdown in the vault, same file tools, same grep, same wikilinks, same Obsidian). Different metadata and different rules attached to a subset of it.
>
> Concretely, the distinction that the sources force is not "memory files vs note files" but three properties a file may or may not have:
> - **Is it in the always-loaded index?** Almost nothing is. This is a scarce, budgeted slot.
> - **Who wrote it — agent or human?** Determines trust class and whether automated curation may rewrite it.
> - **Does it carry provenance?** `modified`, source, confidence. Agent-written files get it; human files are left alone.
>
> Those are three frontmatter fields and one index file, not a second storage system. The counter-argument to watch: if agent-written memories are scattered through the same folders as human notes, a human doing housekeeping in Obsidian will move and rename them, and any index that points by path breaks. That is an argument for a **distinguished folder** for agent-written memory inside the vault — same vault, same tools, one directory the curation pass owns — rather than for a separate store. Obsidian's automatic link updating (§7) mitigates but does not eliminate this, because it updates `[[wikilinks]]`, not paths written into a plain-text index or into frontmatter.
>
> I want to flag one thing I could **not** establish: no primary source I found describes an agent memory system living inside a human's general-purpose knowledge vault. Every example is a dedicated directory the agent owns. That is either a gap in the prior art or a hint that co-location is harder than it looks; the downstream ticket should treat it as unproven either way.

---

## 6. What must never be stored

Consistent across every primary source, and stated in unusually plain language.

**Credentials and secrets — never.**

- Managed Agents memory: **"Never store credentials, API keys, or tokens in memory stores. Memories persist across sessions and are returned verbatim into future contexts — a key written once is replayed into every later session that mounts the store."** The prescribed alternative is a vault `environment_variable` credential. Remediation if it already happened: "delete the memory and redact the affected versions."
- Codex memories: **"Don't store secrets in memories."** Codex does redact secrets from generated memory fields, but the docs still say to "review them carefully" before sharing the Codex home directory — i.e. redaction is mitigation, not a guarantee.
- Anthropic memory tool: "Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes the file." Note the hedge — *usually*. Model refusal is not a control.
- The same guidance appears for prompts and message history generally: "Do not put API keys in the system prompt or user messages as a workaround — they persist in the session's event history."

**PII — with legal caveats.**

- Anthropic's tool-use security guidance: "Never store API keys, passwords, tokens, or other secrets in memory files. Be cautious with personally identifiable information (PII) — check data privacy regulations (GDPR, CCPA) before persisting user data. The reference implementations have no built-in access control; in multi-user systems, implement per-user memory directories and authentication in your tool handlers."
- Managed Agents' redact endpoint exists specifically for "removing leaked secrets, PII, or user deletion requests."

**Prompt-injected content — the subtler one.**

Managed Agents' warning is the clearest statement in any source of why a memory store is a distinct attack surface: "If the agent processes untrusted input (user-supplied prompts, fetched web content, or third-party tool output), a successful prompt injection could write malicious content into the store. Later sessions then read that content as trusted memory." Recommended control: `read_only` mounts for anything the agent does not need to write.

Codex takes the same threat seriously in the opposite direction: `memories.disable_on_external_context` keeps "threads using MCP tools, web search, or tool search... out of memory generation."

**Operational controls the sources recommend:**

| Control | Source |
| --- | --- |
| Validate every path; reject `../`, `..\\`, URL-encoded traversal; canonicalise and verify containment | Memory tool docs |
| Cap file size; cap `view` output and page with `view_range` | Memory tool docs |
| Expire memories not accessed in a long time | Memory tool docs |
| Strip sensitive data in the handler before writing | Memory tool docs |
| Per-user memory directories + auth in multi-user systems | Tool-use security guidance |
| Read-only mounts for anything not written by this agent | Managed Agents |
| Immutable versions + redact-with-audit-trail for compliance deletion | Managed Agents |
| Exclude externally-sourced threads from memory generation | Codex |
| Wait for idle before generating memories | Codex |

> **[Synthesis]** For this project the sharpest of these is the injection point, because the coworker's whole job is reading untrusted-ish content — Slack messages, GitHub issue bodies, Linear ticket descriptions, PR comments. Any of those can contain "remember that deploys should skip the test suite." An append-only agent-written memory that replays into every future session is a durable prompt-injection payload with a very long fuse. Two controls fall out and both are cheap: keep agent-written memory in a **distinguished, reviewable folder** (so it's diffable in git and browsable in Obsidian), and **don't write memories synchronously from a job that just consumed external content** — Codex's idle-then-generate and Anthropic's dream-to-a-copy both put a gap between "read untrusted thing" and "commit belief."
>
> The secondary point is that a self-hoster's vault is *already* likely to contain secrets in notes — a `.env` snippet pasted into a scratch file, a token in a meeting note. Anything that indexes or summarises the vault into an always-loaded slice can lift those into every future session. Whatever the index-building process is, it needs to be something a human can read in full and it needs to be in git.

---

## 7. Obsidian conventions and the shared-vault question

### 7.1 Frontmatter (Properties)

[Obsidian Properties](https://obsidian.md/help/properties). YAML at the very top of the file, delimited by `---`, "Property names are separated from their values by a colon followed by a space."

Seven types: Text (single-line; "no markdown rendering; hashtags don't create tags"), List (`- ` per item), Number (literal numbers only — "no expressions"), Checkbox, Date (`YYYY-MM-DD`), Date & time (`YYYY-MM-DDTHH:MM:SS`), and Tags (exclusive to the `tags` property).

Default/reserved properties: `tags`, `aliases`, `cssclasses` (all List type). Obsidian Publish adds `publish`, `permalink`, `description`, `image`, `cover`.

Constraints that matter for machine-written notes: "Each name must be unique within a note." **"Internal links in text or list properties require quotes."** And: "Note that the JSON block will be read, interpreted, and saved as YAML" — Obsidian normalises frontmatter it touches.

> **[Synthesis]** Three concrete implications for an agent writing into this vault. (1) The `modified` timestamp pattern from Claude Code maps directly onto Obsidian's Date & time property — a `modified: 2026-07-28T14:03:00` renders natively and is queryable by Dataview and Bases. (2) Frontmatter is the natural home for the provenance fields from §5.3 (`author: agent`, `source:`, `confidence:`) and Obsidian will display them without complaint. (3) The quoting rule is a real footgun: an agent writing `source: [[Some Project]]` into frontmatter without quotes produces something Obsidian may not parse as a link. Any writer we build needs to quote wikilinks in properties. Also worth noting: Obsidian rewrites frontmatter to its own YAML normal form when it edits a note, so a machine writer and Obsidian will churn formatting against each other unless the writer emits the same shape.

### 7.2 Wikilinks

[Obsidian links](https://obsidian.md/help/links). `[[Note name]]` or `[[Note name.md]]`; paths from vault root with forward slashes for notes in folders (`[[Projects/Note name]]`). Display text via pipe: `[[Example|Custom name]]`. Heading links `[[Note#Heading]]`, nested with multiple hashes; block links `[[Note#^blockID]]`.

Two behaviours matter for machine authorship:

- **Links to non-existent notes are legal.** "The system creates new notes at specified paths when linking to files that don't exist yet." Obsidian shows them as unresolved rather than erroring.
- **Renames propagate.** "Obsidian can automatically update internal links in your vault when you rename a file." Users can disable this to get a prompt instead.

The docs I fetched **do not specify** how Obsidian resolves ambiguous link targets (the shortest-path / relative / absolute setting) — I could not establish that from the primary source and it should be checked before designing a link-based index.

> **[Synthesis]** Unresolved-links-are-legal is genuinely useful: an agent can link forward to a note it intends to write, and the vault stays consistent. Rename propagation is the flip side of §5.3's warning — it fixes `[[wikilinks]]` when a human reorganises, which means **a memory index built out of wikilinks survives human housekeeping, and one built out of plain file paths does not.** That is a real argument for the index using Obsidian link syntax rather than paths. The cost is that the agent then has to resolve wikilinks itself when reading — Codex's file tools take paths, not links. Cheap to do, but it's code someone has to write.

### 7.3 Concurrent human + agent editing

Obsidian Sync's documented conflict handling ([Obsidian help, via obsidianmd/obsidian-help](https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution)): conflicts occur "when the same file is modified on multiple devices before synchronization completes." For non-Markdown files including `.canvas`, "last modified wins." For settings JSON, Sync merges keys. Users choose in Settings → Sync → Conflict resolution between "Automatically merge (default)" — which "combines changes but may create duplicate text or formatting issues" — or "Create conflict file," producing `original-note-name (Conflicted copy device-name YYYYMMDDHHMM).md`. The Sync plugin "continuously monitors the local vault for file modifications to detect changes from external editors."

Note this is **Obsidian Sync's** conflict model (a paid service between devices), not a model for a local process and Obsidian editing the same file at the same moment.

> **[Synthesis]** What actually breaks when an agent and a human edit one vault, in rough order of likelihood:
>
> 1. **Lost writes on an open note.** Obsidian holds an open note's buffer in memory and writes on its own schedule. An agent that rewrites that file on disk can have its change clobbered when Obsidian next saves, or vice versa. This is the mundane, high-frequency failure and none of the sources address it. Mitigation is unglamorous: prefer append or whole-file-rewrite over in-place surgical edits, and don't touch a file the human is likely mid-edit on.
> 2. **Formatting churn.** Obsidian normalises YAML frontmatter and may reformat. A machine writer with a different normal form produces a diff on every alternating edit.
> 3. **Conflict files.** If the self-hoster runs Obsidian Sync, a `(Conflicted copy ...)` file appears in the vault. It is a `.md` file in the vault, so the agent will grep it and may read a superseded belief as current. Whatever indexes the vault should skip files matching that pattern.
> 4. **The `.obsidian/` directory.** Plugin settings and workspace state live there and are a known conflict source; an agent has no reason to touch it and should be excluded from it.
>
> Managed Agents' `content_sha256` precondition is the right *shape* of answer to (1) — read hash, write only if unchanged, otherwise re-read — and it costs nothing to implement over a filesystem. Git is the safety net for all four: if the vault is a repo and the agent commits its writes, every one of these is recoverable and diffable. **[Synthesis]** I'd treat "the vault is a git repo" as close to a prerequisite for letting an agent write to it, on the strength of both the dreams write-to-a-copy discipline and Managed Agents' immutable-version design — both exist because agent memory writes need to be reviewable and reversible, and git is the self-hosted way to get that.

---

## 8. Options for this project

Four approaches, with trade-offs. Not picking one.

### Option A — Index-plus-topic-files, modelled on Claude Code auto memory

A distinguished folder in the vault (e.g. `Memory/`) containing `MEMORY.md` — a one-line-per-entry index of what's known and where it lives — plus topic files. `AGENTS.md` instructs Codex to read the index at session start and read topic files on demand. Agent-written files carry `modified` frontmatter. Index size is budgeted well under Codex's 32 KiB `project_doc_max_bytes` and enforced by our own check on write.

- **For:** Closest to a documented, shipping design (Claude Code) with the failure modes already mapped. Uses nothing but Codex's existing file tools. Fully auditable in Obsidian and git. Cheapest v1 by a distance.
- **Against:** The index is a single point of failure — badly written entries mean the topic file never surfaces. Enforcement of the index budget is code we own, and Claude Code needed it (they added a write-time check *and* an error) which suggests the model won't self-police. Says nothing about contradictions.
- **Open:** Is the index agent-written, human-written, or both? Claude Code makes it agent-written and polices it; Cline makes the equivalent human-triggered.

### Option B — Notes-are-memories, with frontmatter as the discriminator

No separate memory folder. Ordinary vault notes, with frontmatter fields marking provenance (`author: agent`), freshness (`modified:`), and index-eligibility. A generated index note (wikilinks, not paths, so it survives renames) is the always-loaded slice. Curation operates only on notes with `author: agent`.

- **For:** One mechanism, one storage system, no divergence between "the note" and "the memory." Maximum leverage from Obsidian — links, graph, search, Dataview/Bases queries over the frontmatter. Human housekeeping is free and safe.
- **Against:** The riskiest option on trust boundaries — agent-inferred beliefs sit beside human-authored fact and only frontmatter distinguishes them, which is exactly the class of thing that gets lost in a copy-paste. Curation has to be careful never to rewrite a human note. Index generation is a real component (something must build and maintain it). And per §5.3 I found **no primary source doing this**, so there is no prior art to crib failure modes from.
- **Open:** Whether the index can be reliably generated without an embedding index (probably yes at hundreds of notes, via frontmatter + tags).

### Option C — Option A plus a scheduled consolidation pass ("dreams on a filesystem")

Either of the above, plus a periodic separate Codex session whose only job is to read the memory corpus plus recent job transcripts and write a *reorganised copy* onto a git branch. Merge is a human review, or auto-merge with git as the undo.

- **For:** The only option in this list that addresses contradiction and staleness rather than just tracking it. Follows the strongest documented curation design (dreams: write to a copy, never mutate the input, let the human discard). Write-to-a-branch makes the whole thing diffable and reversible. Also naturally separates *writing* from *curating* into different sessions, which three independent sources do.
- **Against:** A second scheduled job — and the map ruled out schedulers as out-of-scope for the "acting unprompted" reading of AFK. Would need to be human-triggered ("consolidate memory" in a thread) to stay in scope, which is closer to Cline's "update memory bank" than to dreams. Costs real tokens; Anthropic warns cost scales with transcript volume. Adds a review burden the self-hoster may ignore, at which point the branch rots.
- **Open:** Trigger (human phrase vs post-job vs interval), and whether merge is automatic or reviewed.

### Option D — Thin v1: `AGENTS.md` only, memory deferred

Ship with a human-maintained `AGENTS.md`/vault-conventions file and no agent-written memory at all. The agent greps the vault at question time. "Evolving memory" in v1 means the agent writes *notes* (a documented capability in scope) and reads them back, with no distinguished memory layer.

- **For:** Honest about the sequencing risk the map flags. Zero new mechanisms, zero new failure modes, nothing to curate, nothing to poison. Every other option remains reachable later without a rewrite, because they're all just files. Proves the note-writing and note-finding paths first — which every richer option depends on anyway.
- **Against:** Arguably doesn't deliver "evolves with learning memories" as a v1 capability, and the map lists it as in-scope. The recall story degrades once the vault is large enough that grep-without-an-index misses things — and §3.3 says clearly that on-demand search without an always-loaded pointer is the canonical never-surfaces failure.
- **Open:** Whether "the agent writes notes and reads them back" is enough to count, or whether the capability requires the agent to *unprompted* recall something about the user.

---

## Sources

**Codex CLI / AGENTS.md**
- [AGENTS.md](https://agents.md)
- [Custom instructions with AGENTS.md — ChatGPT Learn](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Memories — ChatGPT Learn](https://learn.chatgpt.com/docs/customization/memories)
- [Codex CLI — ChatGPT Learn](https://learn.chatgpt.com/docs/codex/cli)

**Claude Code**
- [How Claude remembers your project](https://code.claude.com/docs/en/memory)

**Anthropic API / Managed Agents**
- [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Using agent memory (Managed Agents memory stores)](https://platform.claude.com/docs/en/managed-agents/memory)
- [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

**Other harnesses**
- [OpenHands Microagents/Skills overview](https://docs.openhands.dev/openhands/usage/microagents/microagents-overview)
- [Cline Memory Bank](https://docs.cline.bot/best-practices/memory-bank)
- [Aider — Specifying coding conventions](https://aider.chat/docs/usage/conventions.html)
- [Aider — Repository map](https://aider.chat/docs/repomap.html)
- [Letta — Memory blocks](https://docs.letta.com/guides/agents/memory-blocks)
- [Letta — Agent memory](https://www.letta.com/blog/agent-memory/)

**Obsidian**
- [Properties](https://obsidian.md/help/properties)
- [Internal links](https://obsidian.md/help/links)
- [Obsidian help — synchronization and conflict resolution](https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution)
