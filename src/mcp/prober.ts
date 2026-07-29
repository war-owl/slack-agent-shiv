import type { McpInventory, McpInventoryProber, McpServerConfig } from "../ports/mcp.ts";

/**
 * The one thing the wrapper does with a connector: ask what tools it has.
 *
 * ADR-0005 keeps the wrapper out of the tool path — Codex holds the MCP connections and
 * calls them directly — so this is a *second*, throwaway client that exists only for the
 * inventory pin. That duplication is deliberate. The alternative is asking Codex what it
 * sees, and Codex is configured with `disabled_tools` already applied, which would make the
 * pin blind to exactly the tools it exists to notice: a newly-appeared `merge_*` would be
 * hidden by the deny-list generated from the pin that was supposed to catch it.
 *
 * Streamable HTTP only (`url` in configuration), which is what both surveyed servers offer
 * and all ADR-0005 promises. A stdio connector would need a subprocess and has no
 * self-hoster asking for it.
 */

/** MCP's protocol revision, as measured against Linear's server. */
const PROTOCOL_VERSION = "2025-06-18";

/** Long enough for a cold hosted server, short enough that startup is not hostage to one. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Enough pages to hold any real inventory, and a stop for a server that paginates forever.
 *
 * Linear's 57 tools arrive in one page today. The cursor loop exists because `tools/list` is
 * specified as paginated and a server that starts using it must not silently truncate the
 * pin — a *shorter* inventory reads as tools having disappeared, which fails loudly, but a
 * truncated one that happened to match would be worse.
 */
const MAX_PAGES = 20;

/**
 * The credential store is a parameter with no default, deliberately: preflight resolves the
 * same variable out of the same object, and an adapter that quietly fell back to
 * `process.env` could be probing with a credential the check above it never saw.
 */
export function createMcpInventoryProber(env: NodeJS.ProcessEnv): McpInventoryProber {
  return {
    async probe(server: McpServerConfig): Promise<McpInventory> {
      const token = env[server.bearerTokenEnvVar]?.trim();
      if (token === undefined || token === "") {
        throw new Error(
          `${server.bearerTokenEnvVar} is not set, so there is no credential to probe ` +
            `${server.name} with`,
        );
      }

      const session = new McpProbeSession(server, token);
      try {
        return { tools: await session.listTools() };
      } catch (error) {
        // Wrapped with the server's name and URL because a bare `fetch failed` in a startup
        // log is indistinguishable between "wrong URL", "no network", and "their outage".
        throw new Error(
          `Could not read ${server.name}'s tool inventory from ${server.url}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await session.close();
      }
    },
  };
}

/**
 * One probe: initialize, list, and close.
 *
 * Kept as a class only because the session id from `initialize` has to reach both later
 * requests. There is no connection to hold — each request is a POST.
 */
class McpProbeSession {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly server: McpServerConfig;
  private readonly token: string;

  constructor(server: McpServerConfig, token: string) {
    this.server = server;
    this.token = token;
  }

  async listTools(): Promise<string[]> {
    // The handshake is not optional politeness: a server may reject `tools/list` outright
    // before `initialize`, and the session id it hands back is what the later POSTs are
    // recognised by.
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "open-agent-preflight", version: "0.1.0" },
    });
    await this.notify("notifications/initialized");

    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor });
      const listed = Array.isArray(result.tools) ? result.tools : [];
      for (const tool of listed) {
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && name !== "") tools.push(name);
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || next === "") return tools;
      cursor = next;
    }
    throw new Error(
      `it is still paginating its tool list after ${MAX_PAGES} pages, which is not a real ` +
        "inventory",
    );
  }

  /**
   * The spec has a client end a session with `DELETE`, and a server may not implement it.
   * Failing to close a probe is not worth failing a startup over.
   */
  async close(): Promise<void> {
    if (this.sessionId === undefined) return;
    try {
      await fetch(this.server.url, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      // Deliberately silent: the session expires on its own.
    }
  }

  private async request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });

    // Captured from `initialize`'s response and echoed on everything after it.
    const issued = response.headers.get("mcp-session-id");
    if (issued !== null && issued !== "") this.sessionId = issued;

    if (!response.ok) {
      throw new Error(await httpReason(response, this.server.bearerTokenEnvVar));
    }

    const message = await readMessage(response);
    if (message.error !== undefined) {
      const error = message.error as { code?: unknown; message?: unknown };
      throw new Error(`it answered ${method} with an error: ${String(error.message)}`);
    }
    return (message.result ?? {}) as Record<string, unknown>;
  }

  /** A notification has no id and no reply — the server answers `202 Accepted`. */
  private async notify(method: string): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method, params: {} });
    // Drained rather than ignored, so the socket is released for the next request.
    await response.text().catch(() => "");
  }

  private post(body: unknown): Promise<Response> {
    return fetch(this.server.url, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      // Both, because a streamable-HTTP server chooses which to answer with per request and
      // one that only speaks SSE will refuse a client that will not read it.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.sessionId === undefined ? {} : { "mcp-session-id": this.sessionId }),
    };
  }
}

/**
 * One JSON-RPC message out of a response that may be either JSON or a single SSE event.
 *
 * Streamable HTTP lets a server answer one request with a `text/event-stream`, and both
 * shapes carry the same message. The stream is read whole rather than incrementally: a
 * `tools/list` reply is kilobytes, and this code path runs once per connector per startup.
 */
async function readMessage(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("text/event-stream") ? lastDataEvent(body) : body;
  if (payload === undefined || payload.trim() === "") {
    throw new Error("it answered with an empty body");
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error(`it answered with something that is not JSON-RPC: ${clip(body)}`);
  }
}

/**
 * The last `data:` payload in an SSE body.
 *
 * The last rather than the first: a server may send comments or a `ping` before the reply,
 * and the response to a single request carries a single message either way.
 */
function lastDataEvent(body: string): string | undefined {
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "");
  return data.at(-1);
}

/**
 * Why an HTTP error is what it is, in the terms the reader can act on.
 *
 * 401 and 403 get named specially because they are the overwhelmingly likely ones and the
 * remedy is a different thing in each case — a wrong token against a token that is right and
 * not entitled.
 */
async function httpReason(response: Response, tokenEnvVar: string): Promise<string> {
  const body = clip(await response.text().catch(() => ""));
  if (response.status === 401) {
    return `it rejected the credential in ${tokenEnvVar} (401). ${body}`;
  }
  if (response.status === 403) {
    return (
      `the credential in ${tokenEnvVar} is not entitled to this server (403) — it is a valid ` +
      `token without the access this needs. ${body}`
    );
  }
  return `it answered HTTP ${response.status}. ${body}`;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
