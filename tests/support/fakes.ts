import type { Clock } from "../../src/ports/clock.ts";
import type {
  Engine,
  EngineEvent,
  EngineSession,
  SessionOptions,
} from "../../src/ports/engine.ts";
import type { McpInventory, McpInventoryProber, McpServerConfig } from "../../src/ports/mcp.ts";
import type { PostMessage, PostedMessage, SlackClient } from "../../src/ports/slack.ts";
import { RECORDED_CODEX_VERSION } from "../../src/config.ts";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class FakeSlack implements SlackClient {
  /** Every message posted, in order. */
  readonly posts: PostMessage[] = [];
  /** Set to make the next `postMessage` fail, as a Slack outage would. */
  failNextPost: Error | undefined;

  private nextTs = 1;

  async postMessage(message: PostMessage): Promise<PostedMessage> {
    const failure = this.failNextPost;
    if (failure) {
      this.failNextPost = undefined;
      throw failure;
    }
    this.posts.push(message);
    return { ts: `post-${this.nextTs++}` };
  }

  /** The messages posted into one Thread, oldest first. */
  textsIn(threadTs: string): string[] {
    return this.posts.filter((post) => post.thread.ts === threadTs).map((post) => post.text);
  }
}

/** What the fake engine does for one Turn. */
export type EngineScript = (context: {
  prompt: string;
  /** Which Session the Turn is running in, so a script can answer per-Thread. */
  sessionId: string;
}) => AsyncIterable<EngineEvent> | Iterable<EngineEvent> | Promise<Iterable<EngineEvent>>;

/** One Turn the fake engine was asked to run. */
export interface FakeTurn {
  prompt: string;
  /** The Session it ran in — the same value a real Codex would report as its id. */
  sessionId: string;
}

export class FakeEngine implements Engine {
  /** Every Turn run, in order. */
  readonly ranTurns: FakeTurn[] = [];
  readonly startedSessions: SessionOptions[] = [];
  /** Every resume attempt, in order — a real Codex reads these off its own disk. */
  readonly resumedSessions: { sessionId: string; options: SessionOptions }[] = [];
  versionToReport = RECORDED_CODEX_VERSION;

  /** Replaced per test to script what the engine does. */
  script: EngineScript = () => [{ type: "message", text: "Done." } as const];

  private nextSession = 1;

  async version(): Promise<string> {
    return this.versionToReport;
  }

  startSession(options: SessionOptions): EngineSession {
    this.startedSessions.push(options);
    return this.session(`session-${this.nextSession++}`, false);
  }

  /**
   * A fresh instance of this class models a restarted process, so a Session started
   * before the restart still resumes here — which is what a real Codex does, because
   * the conversation is on its disk rather than in this process.
   */
  resumeSession(sessionId: string, options: SessionOptions): EngineSession {
    this.resumedSessions.push({ sessionId, options });
    return this.session(sessionId, true);
  }

  private session(sessionId: string, resumed: boolean): EngineSession {
    const engine = this;
    // A real Session has no id until a Turn starts; a resumed one knows it up front.
    let id: string | null = resumed ? sessionId : null;
    return {
      get id() {
        return id;
      },
      run(prompt: string): AsyncIterable<EngineEvent> {
        engine.ranTurns.push({ prompt, sessionId });
        id = sessionId;
        return (async function* () {
          yield { type: "session-started", sessionId } as const;
          yield { type: "turn-started" } as const;
          for await (const event of await engine.script({ prompt, sessionId })) {
            yield event;
          }
        })();
      },
    };
  }

  /** The prompts of every Turn run, in order. */
  get turns(): string[] {
    return this.ranTurns.map((turn) => turn.prompt);
  }

  /** The prompt the engine received for a given Turn, for assertions. */
  promptFor(turn: number): string {
    return this.turnAt(turn).prompt;
  }

  /** Which Session a given Turn ran in, for asserting Thread isolation. */
  sessionFor(turn: number): string {
    return this.turnAt(turn).sessionId;
  }

  private turnAt(turn: number): FakeTurn {
    const ran = this.ranTurns[turn];
    if (ran === undefined) throw new Error(`The fake engine never ran turn ${turn}`);
    return ran;
  }
}

export class FakeClock implements Clock {
  private current: number;

  constructor(startingAt = 1_700_000_000_000) {
    this.current = startingAt;
  }

  now(): number {
    return this.current;
  }
}

export class FakeInventoryProber implements McpInventoryProber {
  inventories = new Map<string, McpInventory>();

  async probe(server: McpServerConfig): Promise<McpInventory> {
    return this.inventories.get(server.name) ?? { tools: [] };
  }
}
