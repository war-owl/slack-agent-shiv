# Official MCP TypeScript SDK — client and `mcp.json` design

Research date: 2026-07-29. Sources are limited to the MCP project's own SDK,
specification, and maintainer records.

## Decision summary

Use the stable v2 client package, `@modelcontextprotocol/client@^2`, instead of
hand-writing the MCP handshake and Streamable HTTP/SSE parsing. Load an
application-owned `mcp.json`, validate it as a discriminated union, create one
SDK `Client` per enabled server, and select the SDK transport from that server's
entry.

`mcp.json` is **not currently an SDK or protocol standard**. MCP maintainers were
still designing a standard client configuration format in March 2026. Therefore
open-agent should describe its file as its own public configuration contract,
not imply that arbitrary MCP clients can consume it. The official discussion
also establishes the right security direction: server-local secret providers,
no plaintext credentials, no global headers, and no arbitrary environment
exfiltration ([maintainer meeting, §4](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2547#discussion-9100709)).

## Current SDK and migration status

- The SDK's `main` branch is v2, implements the 2026-07-28 MCP specification,
  and says v2 is now the stable release line. v1.x remains on the long-lived
  `v1.x` branch and receives bug and security fixes for at least six months
  after v2's release
  ([SDK README](https://github.com/modelcontextprotocol/typescript-sdk#readme)).
- The v2 release is split. A host/client installs
  `@modelcontextprotocol/client`; a server installs
  `@modelcontextprotocol/server`; public Zod schema constants live in
  `@modelcontextprotocol/core`; runtime/framework adapters are separate
  `node`, `express`, `fastify`, and `hono` packages. Do not import
  `@modelcontextprotocol/core-internal`, which is private and unpublished
  ([v2 packaging guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#packaging--runtime)).
- `@modelcontextprotocol/client` 2.0.0 is released, requires Node 20+, and
  exports both ESM and CommonJS builds
  ([release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0),
  [package manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/package.json)).
- v1's monolithic `@modelcontextprotocol/sdk` is not the package to add to new
  code. The official migration command is
  `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`; client imports move to
  `@modelcontextprotocol/client`, with stdio specifically imported from
  `@modelcontextprotocol/client/stdio`
  ([upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)).

## Transport mapping

The 2026-07-28 specification defines two standard bindings: stdio and
Streamable HTTP. Protocol semantics are transport-independent
([transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).

### stdio

Create `StdioClientTransport` from `@modelcontextprotocol/client/stdio` with:

- required `command`;
- optional `args`, `cwd`, `env`, `stderr`, and `maxBufferSize`.

The transport spawns with `shell: false`. When an explicit environment is not
given, the implementation inherits only a small safe platform-dependent set;
configured values are merged over it
([stdio source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/stdio.ts)).
`client.close()` shuts the child down in stages: stdin close, `SIGTERM`, then
`SIGKILL`
([client connection guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)).

Security implication: a stdio entry authorizes local binary execution. The MCP
maintainers explicitly class this as a higher-risk software-distribution
surface, recommend pinned package versions rather than `npx ... latest`, and
call for a distinct trust warning
([maintainer meeting, §3](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2547#discussion-9100709)).

### Streamable HTTP

Create `StreamableHTTPClientTransport` from
`@modelcontextprotocol/client` with the endpoint `URL`. Its options include
`requestInit` for ordinary per-server HTTP settings/headers, `authProvider` for
authentication, a custom `fetch`, reconnection settings, and persisted session
information
([transport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/streamableHttp.ts)).

For a fixed bearer credential managed outside the SDK, use an `AuthProvider`
whose `token()` resolves the credential at request time. The transport adds
`Authorization: Bearer ...` and calls `token()` before every request; an
optional `onUnauthorized()` can refresh after a 401. The SDK also provides
OAuth, client-credentials, and private-key-JWT flows
([client authentication guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md),
[machine authentication guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md)).

The protocol's OAuth flow applies to HTTP transports. For stdio, the
specification says clients should retrieve credentials from the environment
instead. HTTP bearer credentials belong in the `Authorization` header on every
request and must never be put in the URL query string
([authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).

### Legacy SSE

`SSEClientTransport` remains in the v2 client but is deprecated. Official
guidance is to use Streamable HTTP where possible and keep SSE only as a
migration fallback for servers that predate it
([SSE API reference](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/sse.html),
[connection guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)).

Therefore `mcp.json` should not silently try SSE for every HTTP failure.
Prefer an explicit legacy `type: "sse"` entry (or a narrowly named opt-in
fallback) so authentication failures and outages are not reinterpreted as
transport detection. Do not add WebSocket: v2 removed its client transport
because it is not a specification transport
([upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md#imports--transports)).

## Tools

After `await client.connect(transport)`:

```ts
const { tools } = await client.listTools();
const result = await client.callTool({
  name: "lookup-order",
  arguments: { id: "A-1041" },
});
```

In v2, `listTools()` aggregates all pages automatically. Passing an explicit
`cursor` fetches exactly one raw page. `ClientOptions.listMaxPages` defaults to
64 and bounds a misbehaving server. `callTool()` returns tool content; a tool
failure is normally a result with `isError`, whereas protocol failures such as
an unknown tool or timeout throw
([calling guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/calling.md)).

For 2026-07-28-era servers, opt into SDK version negotiation with
`new Client(info, { versionNegotiation: { mode: "auto" } })`. It probes the new
era and falls back to the 2025 initialize handshake. The SDK warns against
making `auto` the unconditional default for spawn-per-invocation stdio clients,
because probing a legacy server may spawn an extra child and wait for the probe
timeout
([protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)).

## Proposed open-agent `mcp.json` contract

This is a design synthesis, not an official schema:

```json
{
  "$schema": "./mcp.schema.json",
  "servers": {
    "linear": {
      "type": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "type": "bearer", "provider": "env", "key": "LINEAR_API_KEY" },
      "headers": {
        "X-Workspace": { "provider": "env", "key": "LINEAR_WORKSPACE" }
      },
      "writeTools": ["save_issue"],
      "disabledTools": ["merge_diff"]
    },
    "local-files": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@vendor/server@1.2.3"],
      "cwd": ".",
      "env": {
        "SERVER_TOKEN": { "provider": "env", "key": "LOCAL_SERVER_TOKEN" }
      },
      "writeTools": [],
      "disabledTools": []
    }
  }
}
```

Recommended rules:

1. Key servers by stable, unique name. Use a discriminated union for
   `streamable-http`, `stdio`, and an explicitly legacy `sse`.
2. Keep connector policy (`disabledTools`, `writeTools`) beside each connection
   because it is server-specific, but separate the connection parser from policy
   validation in code. Tool inventories are deliberately not pinned.
3. Store only secret references in the file. Resolve each reference from an
   allowlisted provider at runtime and scope the resulting value to that one
   server. Reject literal `Authorization` values and unknown provider/env
   shapes by default.
4. Permit non-secret literal headers only if there is a real use case; always
   keep them inside a server entry. Reserve SDK-owned headers such as
   `Authorization`, `Content-Type`, `Mcp-Session-Id`, and
   `Mcp-Protocol-Version`.
5. Resolve relative `cwd` paths against the directory containing `mcp.json`.
   Never run stdio through a shell, and surface a startup trust warning for each
   local command.
6. Let the official client own initialization, protocol negotiation,
   Streamable HTTP response parsing, sessions, pagination, authentication, and
   clean shutdown. Delete the parallel hand-rolled protocol implementation.
7. A config loader should return validated configuration, while a client
   manager owns `Map<serverName, { client, transport }>` and closes every entry
   on partial startup failure or shutdown.

## Implications for the current codebase

- `src/mcp/prober.ts` currently hand-rolls a fixed 2025-06-18 initialization,
  HTTP session headers, SSE parsing, and pagination. Replacing that with the v2
  SDK removes protocol code that has already changed in the 2026-07-28 era.
- `McpServerConfig` currently supports only Streamable HTTP plus one bearer
  environment variable. The new file needs a transport union, generic
  per-server secret/header resolution, and stdio process parameters.
- `open-agent.config.json` currently embeds `connectors`. Moving the complete
  server definitions to one `mcp.json` creates the requested extension point.
  The main config should hold only the file path (defaulting to repo-root
  `mcp.json`), avoiding two competing connector sources.
- The SDK is a client library, not a config loader. open-agent must still parse
  and validate `mcp.json`, translate the same validated entries into whatever
  server configuration Codex receives, and use the SDK client separately for
  startup inventory checks.
