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
}) => AsyncIterable<EngineEvent> | Iterable<EngineEvent> | Promise<Iterable<EngineEvent>>;

export class FakeEngine implements Engine {
  /** The prompt of every Turn run, in order. */
  readonly turns: string[] = [];
  readonly startedSessions: SessionOptions[] = [];
  versionToReport = RECORDED_CODEX_VERSION;

  /** Replaced per test to script what the engine does. */
  script: EngineScript = () => [{ type: "message", text: "Done." } as const];

  async version(): Promise<string> {
    return this.versionToReport;
  }

  startSession(options: SessionOptions): EngineSession {
    this.startedSessions.push(options);
    const engine = this;
    let id: string | null = null;
    return {
      get id() {
        return id;
      },
      run(prompt: string): AsyncIterable<EngineEvent> {
        engine.turns.push(prompt);
        id ??= `session-${engine.startedSessions.length}`;
        return (async function* () {
          yield { type: "session-started", sessionId: id as string } as const;
          yield { type: "turn-started" } as const;
          for await (const event of await engine.script({ prompt })) {
            yield event;
          }
        })();
      },
    };
  }

  /** The prompt the engine received for a given Turn, for assertions. */
  promptFor(turn: number): string {
    const prompt = this.turns[turn];
    if (prompt === undefined) throw new Error(`The fake engine never ran turn ${turn}`);
    return prompt;
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
