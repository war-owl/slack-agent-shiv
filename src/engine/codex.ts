import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  Codex,
  type CommandExecutionItem,
  type FileChangeItem,
  type McpToolCallItem,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type {
  ActivityStatus,
  Engine,
  EngineEvent,
  EngineSession,
  RunOptions,
  SessionOptions,
} from "../ports/engine.ts";

/**
 * The Codex adapter — the **only** module in this codebase that imports
 * `@openai/codex-sdk` or knows the shape of a Codex event (ADR-0001).
 *
 * Everything it does is translation: process lifecycle, Session identity, and
 * turning `codex exec`'s JSONL event stream into the wrapper's own vocabulary. If
 * this project ever moves to `app-server`, this file is the rewrite.
 *
 * Two properties of `exec` that the rest of the system is built around, and which
 * live here because they are the engine's:
 *
 * - **It cannot ask permission.** `codex exec` hard-codes `approval_policy: Never`.
 *   There is no approval channel to surface, which is why the Thread's audit record
 *   is the accountability story instead.
 * - **Progress is item-level.** `exec` deliberately drops every delta notification,
 *   so there is nothing finer to translate than whole items. Only the todo list
 *   updates mid-item.
 */

export interface CodexEngineOptions {
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** An explicit `codex` binary, when the one on `PATH` is not the one to run. */
  codexPath?: string | undefined;
}

/**
 * Asynchronous because the binary is resolved once, up front: v1 runs against
 * whatever Codex is installed, so which binary that is and what version it reports
 * are answers the instance has to go and get rather than assume.
 */
export async function createCodexEngine(options: CodexEngineOptions): Promise<Engine> {
  const binary = await resolveCodexBinary(options.codexPath);
  const codex = new Codex(binary.path ? { codexPathOverride: binary.path } : {});

  const threadOptions = (session: SessionOptions): ThreadOptions => ({
    model: options.model,
    modelReasoningEffort: options.reasoningEffort,
    // ADR-0002 layer 2: the agent writes in its workspace and the Vault, and
    // nowhere else. Network is on because the work is GitHub, Linear, and the
    // web; `execpolicy` is unrestricted in v1.
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
    workingDirectory: session.workingDirectory,
    additionalDirectories: [...(session.writableDirectories ?? [])],
    // A Job's workspace is a plain directory, not a checkout.
    skipGitRepoCheck: true,
  });

  return {
    version: async () => binary.version,

    startSession(session: SessionOptions): EngineSession {
      return codexSession(codex.startThread(threadOptions(session)));
    },

    /**
     * Codex persists each Session as an append-only rollout under its own home, so
     * resuming needs nothing but the identifier — the conversation is already there.
     * The options are passed again because they describe *this* Job's sandbox, which
     * is the same shape but a fresh subprocess.
     */
    resumeSession(sessionId: string, session: SessionOptions): EngineSession {
      return codexSession(codex.resumeThread(sessionId, threadOptions(session)));
    },
  };
}

function codexSession(thread: Thread): EngineSession {
  return {
    get id() {
      return thread.id;
    },
    run(prompt: string, options?: RunOptions): AsyncIterable<EngineEvent> {
      return (async function* () {
        // The SDK spawns `codex exec` with this signal, so aborting it sends the
        // process a signal rather than just abandoning its output. Closing this
        // generator early — a `break` in the Job runner — kills it too, because the
        // SDK kills the child when its own stream is closed. Both routes matter: one
        // is the bound firing, the other is the Job deciding it has heard enough.
        const signal = options?.signal;
        const { events } = await thread.runStreamed(prompt, signal ? { signal } : {});
        for await (const event of events) {
          yield* translate(event);
        }
      })();
    },
  };
}

/**
 * One Codex event in, zero or more wrapper events out.
 *
 * Zero is a real case: `item.started` for an agent message carries no text worth
 * reporting, and reasoning summaries are noise until something asks for them.
 */
function translate(event: ThreadEvent): EngineEvent[] {
  switch (event.type) {
    case "thread.started":
      return [{ type: "session-started", sessionId: event.thread_id }];
    case "turn.started":
      return [{ type: "turn-started" }];
    case "turn.completed":
      return [
        {
          type: "turn-completed",
          usage: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          },
        },
      ];
    case "turn.failed":
      return [{ type: "turn-failed", message: event.error.message }];
    case "error":
      return [{ type: "engine-error", message: event.message }];
    case "item.started":
    case "item.updated":
      return translateItem(event.item, "in-progress");
    case "item.completed":
      return translateItem(event.item, "completed");
    default:
      // An unrecognised event from a newer Codex. Dropping it is right — the
      // alternative is crashing a Job over an event nothing reads.
      return [];
  }
}

function translateItem(item: ThreadItem, status: ActivityStatus): EngineEvent[] {
  // Whole items only — `exec` has no delta stream, so an item that has merely
  // started carries nothing worth reporting for the text-shaped kinds.
  const terminal = status === "completed";

  switch (item.type) {
    case "agent_message":
      return terminal ? [{ type: "message", text: item.text }] : [];
    case "reasoning":
      return terminal ? [{ type: "reasoning", text: item.text }] : [];
    case "todo_list":
      return [
        {
          type: "plan",
          steps: item.items.map((step) => ({ text: step.text, completed: step.completed })),
        },
      ];
    case "command_execution":
      return [
        {
          type: "command",
          command: item.command,
          status: statusOf(item.status),
          output: item.aggregated_output,
          exitCode: item.exit_code,
        },
      ];
    case "file_change":
      return [
        {
          type: "file-change",
          changes: item.changes.map((change) => ({ path: change.path, kind: change.kind })),
          status: statusOf(item.status),
        },
      ];
    case "mcp_tool_call":
      return [
        {
          type: "tool-call",
          server: item.server,
          tool: item.tool,
          status: statusOf(item.status),
          error: item.error?.message,
          result: resultTextOf(item),
        },
      ];
    case "web_search":
      return terminal ? [{ type: "web-search", query: item.query }] : [];
    case "error":
      return [{ type: "engine-error", message: item.message }];
    default:
      return [];
  }
}

/**
 * A tool result as one block of text, or nothing.
 *
 * Only the text blocks are read. An MCP result may also carry images and structured
 * content, and neither is worth translating for the one thing the wrapper does with a
 * result: find the identifier or URL of what the tool just created, so the Write's
 * audit record can link to it.
 */
function resultTextOf(item: McpToolCallItem): string | undefined {
  const text = (item.result?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}

/**
 * Deliberately typed against the SDK's own status unions rather than `string`: if
 * upstream renames a status, this stops compiling instead of quietly reporting the
 * wrong one. Catching that at build time is most of what the adapter seam is for.
 */
function statusOf(
  itemStatus: CommandExecutionItem["status"] | FileChangeItem["status"] | McpToolCallItem["status"],
): ActivityStatus {
  switch (itemStatus) {
    case "in_progress":
      return "in-progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

interface ResolvedCodex {
  /** Passed to the SDK as `codexPathOverride`; undefined means use the vendored one. */
  path: string | undefined;
  version: string;
}

/**
 * Which Codex will actually run, and what version it is.
 *
 * v1 deliberately pins nothing: **the instance runs against whatever is installed.**
 * A self-hoster has to install Codex to log in at all, and that installation — the
 * one they upgrade, and the one whose alphas will surprise them — is the one to use.
 * So a `codex` on `PATH` wins, and the copy vendored into `node_modules` is the
 * fallback for a deployment that has nothing else.
 *
 * This is why the drift warning at startup is worth having: the two can differ, and
 * when they do it is the installed one that decides how the coworker behaves.
 */
async function resolveCodexBinary(explicitPath: string | undefined): Promise<ResolvedCodex> {
  if (explicitPath) {
    return { path: explicitPath, version: await codexVersionOf(explicitPath) };
  }

  try {
    // `spawn` resolves a bare command against PATH, so this asks the installed CLI.
    return { path: "codex", version: await codexVersionOf("codex") };
  } catch {
    return { path: undefined, version: await vendoredCodexVersion() };
  }
}

async function codexVersionOf(binary: string): Promise<string> {
  const { stdout } = await promisify(execFile)(binary, ["--version"]);
  // `codex --version` prints e.g. `codex-cli 0.145.0`.
  return stdout.trim().replace(/^codex-cli\s+/, "");
}

/** The SDK loads its binary out of `@openai/codex`, so that package's version is it. */
async function vendoredCodexVersion(): Promise<string> {
  const manifestPath = createRequire(import.meta.url).resolve("@openai/codex/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string };
  if (!manifest.version) {
    throw new Error(`Could not read a Codex version from ${manifestPath}`);
  }
  return manifest.version;
}
