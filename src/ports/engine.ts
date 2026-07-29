/**
 * The engine seam mandated by ADR-0001.
 *
 * Everything below is the *wrapper's* vocabulary. No Codex type appears here, and
 * no module outside `src/engine/` may import `@openai/codex-sdk` — so a later move
 * from `codex exec` to `app-server` is a bounded rewrite of the adapter rather than
 * a change that spreads through the Job runner and the Reporter.
 */

export type ActivityStatus = "in-progress" | "completed" | "failed";

export interface PlanStep {
  text: string;
  completed: boolean;
}

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/**
 * What the engine did, in terms the rest of the system understands.
 *
 * Progress is item-level, not token-level: `codex exec` deliberately drops every
 * delta notification, so there is nothing finer to translate. The one exception is
 * `plan`, which the engine revises as it works.
 */
export type EngineEvent =
  | { type: "session-started"; sessionId: string }
  | { type: "turn-started" }
  | { type: "message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "plan"; steps: PlanStep[] }
  | {
      type: "command";
      command: string;
      status: ActivityStatus;
      output: string;
      exitCode: number | undefined;
    }
  | { type: "file-change"; changes: FileChange[]; status: ActivityStatus }
  | {
      type: "tool-call";
      server: string;
      tool: string;
      status: ActivityStatus;
      error: string | undefined;
      /**
       * What the server sent back, as text.
       *
       * Carried because a Write's audit record has to name the thing that was written
       * and link to it, and the identifier of a freshly-created ticket or pull request
       * exists nowhere else — the arguments say what was asked for, and only the result
       * says what came into being.
       */
      result: string | undefined;
    }
  | { type: "web-search"; query: string }
  | { type: "turn-completed"; usage: TokenUsage | undefined }
  | { type: "turn-failed"; message: string }
  | { type: "engine-error"; message: string };

export interface SessionOptions {
  /**
   * The Job's workspace: the sandbox's writable root, and where the engine looks
   * for its operating manual.
   */
  workingDirectory: string;
  /** Additional directories the engine may write to — the Vault, once it exists. */
  writableDirectories?: readonly string[];
}

export interface RunOptions {
  /**
   * Stop the Turn, killing the engine's process.
   *
   * The engine offers no ceiling of its own — no timeout, no max-Turns, no budget,
   * no kill switch — so every bound in this system is the wrapper's, and this is the
   * one primitive all of them are built on. Aborting must actually terminate the
   * subprocess rather than merely stopping the wrapper reading from it: a Job that
   * has been stopped and is still spending money has not been stopped.
   *
   * The iteration throws when this fires. Whoever aborted knows why, and that reason
   * is better than the one the abort carries.
   */
  signal?: AbortSignal | undefined;
}

/** One Session — the coworker's accumulated understanding of one Thread. */
export interface EngineSession {
  /** The engine's own identifier for this Session. Populated once a Turn starts. */
  readonly id: string | null;
  /** Run one Turn, streaming what happens as it happens. */
  run(prompt: string, options?: RunOptions): AsyncIterable<EngineEvent>;
}

export interface Engine {
  /** The installed engine version, reported at startup. */
  version(): Promise<string>;
  startSession(options: SessionOptions): EngineSession;
  /**
   * Pick a Session back up where it left off.
   *
   * `sessionId` is what a previous Session reported as its own `id`. The engine holds
   * the conversation, so nothing about the Thread's history is passed back in — which
   * is the whole reason the wrapper's only durable state is the identifier.
   *
   * Durability is turn-granular: a Session resumes from its last *completed* Turn.
   */
  resumeSession(sessionId: string, options: SessionOptions): EngineSession;
}
