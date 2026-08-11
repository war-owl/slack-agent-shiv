# HubSpot integration research

Research date: 2026-08-11. Sources are first-party HubSpot documentation, the MCP specification, and this repository.

## Conclusion

There are three technically viable shapes, but only two fit open-agent well:

1. **A HubSpot REST Skill using a static/private-app access token** is the smallest, most reliable single-account solution. It is immediately compatible with unattended jobs, needs no refresh flow, and can expose exactly the operations and scopes the workspace wants. It does not use HubSpot's remote MCP server.
2. **A local stdio MCP bridge that owns HubSpot's MCP OAuth session and proxies `https://mcp.hubspot.com`** is the best way to retain HubSpot's official, evolving tool inventory. It requires an interactive one-time authorization and durable secure token storage, but thereafter can refresh tokens unattended. Both open-agent clients can share the bridge's one authorization.
3. **Directly connecting both existing clients to HubSpot's remote MCP server** is a poor fit today. The current project configuration can pass only a bearer token or headers, while HubSpot requires an MCP Auth App client ID, client secret, redirect URI, authorization-code flow with PKCE, and refresh handling. Even after adding OAuth to preflight, the preflight SDK client and each `codex exec` process are distinct OAuth clients/token stores unless open-agent adds a shared credential service.

For one HubSpot account and a controlled set of CRM tasks, start with the REST Skill. Choose the local MCP bridge only if HubSpot's broad official tool inventory and automatic additions are worth owning an OAuth broker/proxy component.

## What HubSpot's remote MCP server requires

The CRM-data MCP endpoint is `https://mcp.hubspot.com`. It is separate from HubSpot's developer MCP server, which is for building HubSpot apps and CMS assets. A client must use a dedicated **MCP Auth App**, and HubSpot explicitly requires OAuth with PKCE. Configuration requires the app's client ID, client secret, and an exactly matching redirect URL ([HubSpot remote MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)).

The first authorization is inherently interactive: a user selects a HubSpot account, grants permissions, and authorizes the connection. A Super Admin is required to install an OAuth app ([HubSpot OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)). PKCE requires a 43–128-character verifier and an S256 challenge; the verifier is sent during the code exchange ([HubSpot remote MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)).

Access tokens expire. The client must retain the returned refresh token and use it to obtain a new access token; if the refresh token expires or is invalidated, the user must authorize again ([HubSpot remote MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)). HubSpot also supports client-secret rotation for MCP Auth Apps ([HubSpot authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)). Therefore a production integration must durably and securely store at least the client secret, refresh token, access token, expiry, and enough account/installation identity to choose the right token. It should serialize refreshes so concurrent jobs do not race.

HubSpot's ordinary OAuth exchange also demonstrates that authorization-code and refresh requests include both `client_id` and `client_secret`, and returns `expires_in` with the token set ([HubSpot OAuth guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth)). The MCP-specific guide adds mandatory PKCE on top.

### Remote MCP data and actions

HubSpot currently documents these MCP capabilities ([HubSpot remote MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)):

- Read CRM records including contacts, companies, deals, tickets, users, commerce objects, line items, products, quotes, subscriptions, and lists/segments.
- Read activities (calls, emails, meetings, notes, tasks), content/marketing data, conversations, and marketing-email drafts/analytics/health/engagement.
- Write contacts, companies, deals, tickets, line items, products, activities, and marketing-email drafts.

The remote server respects the authorizing user's HubSpot record permissions. MCP Auth Apps do not declare a fixed scope list: available scopes derive from the MCP server's current tools and the permissions the installing user grants. When HubSpot adds tools/scopes, an existing installation must be reinstalled to grant them. The server uses CRM Search and does not provide vector search. If Sensitive Data is enabled, the MCP server blocks activity and conversation data even though equivalent REST APIs may remain available ([HubSpot remote MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server)).

This dynamic inventory is an advantage of official MCP, but also means open-agent must continue live tool inventory checks and maintain its exact-name deny-list as HubSpot adds write tools.

## Why direct remote MCP does not fit the current two-client design

Open-agent has two independent MCP consumers:

- Startup preflight constructs an `@modelcontextprotocol/client` `StreamableHTTPClientTransport` and calls `listTools` ([`src/mcp/prober.ts`](../../src/mcp/prober.ts)). Its only auth provider returns a static bearer value from an environment variable.
- Jobs generate Codex `mcp_servers` configuration and Codex connects directly; the generated HTTP configuration contains only URL, bearer-token environment variable, fixed/environment headers, policy, and timeouts ([`src/engine/codex.ts`](../../src/engine/codex.ts)).

The MCP authorization specification applies OAuth authorization to HTTP transports and treats authorization code as the user-delegated case ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)). Adding an OAuth provider only to the preflight SDK transport would authorize preflight but not the separate Codex process. Conversely, pre-authorizing Codex would not make the refresh token available to preflight. Passing a current access token through `bearerTokenEnvVar` is not a complete solution because it expires and neither path refreshes it.

A shared local bridge resolves the split cleanly:

```text
one-time browser authorization
            |
            v
local OAuth/token broker + stdio MCP proxy ---> https://mcp.hubspot.com
          ^                         ^
          |                         |
 open-agent preflight          codex exec jobs
```

The bridge can be configured as one ordinary stdio entry. MCP says stdio implementations should obtain credentials from their environment rather than apply the HTTP OAuth flow themselves ([MCP authorization specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)). Each process instance would read the same protected token store; the bridge would refresh before forwarding upstream requests. This retains HubSpot's official MCP tools without teaching both open-agent and Codex HubSpot-specific OAuth.

Operational requirements for such a bridge are: an explicit onboarding/login command, localhost callback or copy/paste code handling, restrictive token-file permissions or OS keychain storage, atomic writes, a cross-process refresh lock, refresh-on-expiry plus one refresh-and-retry after 401, redacted logs, account identity checks, logout/revoke behavior, and a clear reauthorization failure at preflight.

## REST Skill/API client option

HubSpot supports two relevant REST authentication choices:

### Static/private app token — recommended for one account

HubSpot says static authentication is for a single authorized account. The token is sent as `Authorization: Bearer ...`; scopes are configured on the app, and changing them requires reinstalling the static-token app. Static apps can be installed in one standard HubSpot account at a time (plus developer test accounts), and HubSpot recommends rotating the token every six months ([HubSpot authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview), [HubSpot app management](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot)). Legacy private apps remain supported, and HubSpot notes they are suitable when only a token for a few APIs is needed ([HubSpot developer-platform overview](https://developers.hubspot.com/docs/apps/developer-platform/overview)).

This works naturally as a Skill: an environment variable contains the token, a small reviewed executable calls only selected `api.hubapi.com` endpoints, and `SKILL.md` documents safe workflows and output shapes. There is no refresh state and no initial browser step during normal open-agent startup. Scope the app to the minimum object read/write permissions needed.

Tradeoffs: the project owns endpoint mapping, pagination, associations, validation, retry/backoff, and stable CLI output. A Skill runs through the shell, so it does not receive MCP's exact `disabled_tools` enforcement or MCP tool-call audit events; dangerous operations should simply not exist in the executable, or should require a separate explicit command/credential. It also will not automatically gain new HubSpot features.

### Ordinary public/private-distribution OAuth app — for multiple accounts

For multiple HubSpot accounts, HubSpot requires OAuth and says the integrator must host a backend service to initiate authorization and manage token data ([HubSpot authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)). The authorization-code exchange yields access and refresh tokens; refresh calls require the refresh token plus client ID, client secret, and redirect URI ([HubSpot OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)).

This could back a REST Skill, but at that point open-agent still needs the same durable multi-installation token broker as the MCP bridge. It is justified only if multiple accounts or REST capabilities absent from remote MCP are required.

### Client credentials are not a shortcut

Although MCP defines a client-credentials extension for machine-to-machine use ([MCP OAuth client credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)), HubSpot does not document that grant for its remote MCP server. HubSpot's own client-credentials tokens currently act on behalf of an app rather than an installing user and are limited to the webhooks journal API ([HubSpot authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)). They cannot replace the MCP Auth App authorization-code/PKCE flow or provide general CRM API access.

## Limits and unattended operation

After initial OAuth consent, both a correctly implemented OAuth bridge and an OAuth REST broker can operate headlessly until refresh authorization is invalidated. A static-token Skill is fully headless after provisioning and fails only when the token is rotated/revoked or scopes change.

For direct REST integrations, HubSpot's current privately distributed limits are 100 requests per 10 seconds and 250,000/day for Free/Starter, 190 per 10 seconds and 625,000/day for Professional, and 190 per 10 seconds and 1,000,000/day for Enterprise. HubSpot returns `429` on excess and exposes interval limit headers; CRM Search and some other APIs have separate limits ([HubSpot API usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)). A Skill/API client should honor `429`, apply bounded backoff, paginate deliberately, and avoid unbounded agent-driven scans. HubSpot does not document a separate remote-MCP quota on the MCP integration page, so REST limits should not be asserted as the exact MCP-server limit.

## Recommended staged decision

1. List the exact HubSpot jobs open-agent must perform and classify each as read/write.
2. If one account and a narrow operation set suffice, build a static-token REST Skill with minimum scopes and no destructive commands. This is the quickest production-grade route.
3. If broad conversational coverage and HubSpot-managed tool evolution matter, build a local stdio OAuth bridge, not two independent direct OAuth integrations.
4. Use ordinary OAuth plus a REST broker only when multi-account support or REST-only data (including Sensitive Data cases blocked by MCP) is a firm requirement.
5. Do not treat a manually copied MCP access token or HubSpot client-credentials token as a production authentication strategy.
