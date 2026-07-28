import { RECORDED_CODEX_VERSION } from "../../src/config.ts";
import type { Clock, Stoppable } from "../../src/ports/clock.ts";
import type {
  Engine,
  EngineEvent,
  EngineSession,
  SessionOptions,
} from "../../src/ports/engine.ts";
import type { McpInventory, McpInventoryProber, McpServerConfig } from "../../src/ports/mcp.ts";
import type {
  PostMessage,
  PostedMessage,
  SetStatus,
  SlackClient,
  UpdateMessage,
} from "../../src/ports/slack.ts";
import type { Thread } from "../../src/thread.ts";

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

/** One text Slack was asked to show, whether it arrived by posting or by editing. */
export interface SlackWrite {
  kind: "post" | "edit";
  ts: string;
  thread: Thread;
  text: string;
  /** When it landed, by the injected clock — so a test can assert on cadence. */
  at: number;
}

export interface StatusCall {
  thread: Thread;
  status: string;
  at: number;
}

export class FakeSlack implements SlackClient {
  /** Every text Slack was asked to show, posts and edits together, in order. */
  readonly writes: SlackWrite[] = [];
  /** Every edit *attempted*, including the ones that failed, stamped by the clock. */
  readonly editAttempts: (UpdateMessage & { at: number })[] = [];
  /** Every call to Slack's own status indicator. An empty status clears it. */
  readonly statuses: StatusCall[] = [];
  /** Set to make the next `postMessage` fail, as a Slack outage would. */
  failNextPost: Error | undefined;
  /** Set to make every edit fail, as a rate limit or a deleted message would. */
  failEdits: Error | undefined;
  /** Set to make the indicator fail, as an app predating the scope change would. */
  failStatuses: Error | undefined;

  private nextTs = 1;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async postMessage(message: PostMessage): Promise<PostedMessage> {
    const failure = this.failNextPost;
    if (failure) {
      this.failNextPost = undefined;
      throw failure;
    }
    const ts = `post-${this.nextTs++}`;
    this.record("post", ts, message.thread, message.text);
    return { ts };
  }

  async updateMessage(message: UpdateMessage): Promise<void> {
    this.editAttempts.push({ ...message, at: this.clock.now() });
    if (this.failEdits) throw this.failEdits;
    if (!this.writes.some((write) => write.ts === message.ts)) {
      throw new Error(`Asked to edit ${message.ts}, which this Slack never posted`);
    }
    this.record("edit", message.ts, message.thread, message.text);
  }

  async setStatus(status: SetStatus): Promise<void> {
    if (this.failStatuses) throw this.failStatuses;
    this.statuses.push({ thread: status.thread, status: status.status, at: this.clock.now() });
  }

  /** Every message posted, in order, as it was posted. */
  get posts(): PostMessage[] {
    return this.writes
      .filter((write) => write.kind === "post")
      .map((write) => ({ thread: write.thread, text: write.text }));
  }

  /** The messages *posted* into one Thread, oldest first — not counting later edits. */
  textsIn(threadTs: string): string[] {
    return this.posts.filter((post) => post.thread.ts === threadTs).map((post) => post.text);
  }

  /** The `ts` Slack handed back for the nth posted message. */
  tsOf(post: number): string {
    const ts = this.writes.filter((write) => write.kind === "post")[post]?.ts;
    if (ts === undefined) throw new Error(`This Slack never posted a message ${post}`);
    return ts;
  }

  /** Every version one message has had, oldest first — the post, then each edit. */
  versionsOf(ts: string): string[] {
    return this.writes.filter((write) => write.ts === ts).map((write) => write.text);
  }

  /** What one message says now, after every edit that has landed. */
  currentTextOf(ts: string): string {
    return this.versionsOf(ts).at(-1) ?? "";
  }

  /** When each of those versions landed, so a test can assert on refresh cadence. */
  timesOf(ts: string): number[] {
    return this.writes.filter((write) => write.ts === ts).map((write) => write.at);
  }

  get edits(): SlackWrite[] {
    return this.writes.filter((write) => write.kind === "edit");
  }

  private record(kind: SlackWrite["kind"], ts: string, thread: Thread, text: string): void {
    this.writes.push({ kind, ts, thread, text, at: this.clock.now() });
  }
}

/** What the fake engine does for one Turn. */
export type EngineScript = (context: {
  prompt: string;
  /** Which Session the Turn is running in, so a script can answer per-Thread. */
  sessionId: string;
  /**
   * The Job's workspace, as the real engine is given it — so a script can write to
   * the coworker's own desk rather than only to somewhere outside it.
   */
  workingDirectory: string;
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
    return this.session(`session-${this.nextSession++}`, false, options);
  }

  /**
   * A fresh instance of this class models a restarted process, so a Session started
   * before the restart still resumes here — which is what a real Codex does, because
   * the conversation is on its disk rather than in this process.
   */
  resumeSession(sessionId: string, options: SessionOptions): EngineSession {
    this.resumedSessions.push({ sessionId, options });
    return this.session(sessionId, true, options);
  }

  private session(
    sessionId: string,
    resumed: boolean,
    options: SessionOptions,
  ): EngineSession {
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
          for await (const event of await engine.script({
            prompt,
            sessionId,
            workingDirectory: options.workingDirectory,
          })) {
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

interface FakeRepeat {
  intervalMs: number;
  tick: () => void | Promise<void>;
  dueAt: number;
  stopped: boolean;
}

export class FakeClock implements Clock {
  private current: number;
  private readonly repeats: FakeRepeat[] = [];

  constructor(startingAt = 1_700_000_000_000) {
    this.current = startingAt;
  }

  now(): number {
    return this.current;
  }

  every(intervalMs: number, tick: () => void | Promise<void>): Stoppable {
    const repeat: FakeRepeat = {
      intervalMs,
      tick,
      dueAt: this.current + intervalMs,
      stopped: false,
    };
    this.repeats.push(repeat);
    return {
      stop: () => {
        repeat.stopped = true;
      },
    };
  }

  /**
   * Move time forward, running everything that comes due on the way — and awaiting
   * it, so that "ten silent minutes passed" is a thing a test can assert after.
   */
  async advance(ms: number): Promise<void> {
    const until = this.current + ms;
    for (;;) {
      const due = this.repeats
        .filter((repeat) => !repeat.stopped && repeat.dueAt <= until)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (due === undefined) break;
      this.current = due.dueAt;
      due.dueAt += due.intervalMs;
      await due.tick();
    }
    this.current = until;
  }
}

export class FakeInventoryProber implements McpInventoryProber {
  inventories = new Map<string, McpInventory>();

  async probe(server: McpServerConfig): Promise<McpInventory> {
    return this.inventories.get(server.name) ?? { tools: [] };
  }
}
