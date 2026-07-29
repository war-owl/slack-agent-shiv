# 08 — Preflight: credentials, dependencies, and connector connectivity

**What to build:** A self-hoster starts the instance and either it runs or it tells them exactly what is wrong. A missing token, an unreachable MCP server, or a GitHub App that is not installed where they think it is stops startup with a message that names the problem. Tool-list evolution does not stop startup.

**Amended 2026-07-29:** MCP inventories are no longer pinned. Preflight connects with
the official TypeScript SDK and reports the current tool count. Additions and removals are
accepted automatically. GitHub remains a different check because it is an installation
whose repository list must be resolved and shown, not an MCP server.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

## Everything

- [x] The instance configuration names credentials, the Vault, Skills, bounds, and the one
  `mcp.json` registry containing every connector *(amended 2026-07-29: MCP configuration
  moved into its own extensible file when stdio support and the official SDK were added)*
- [x] A missing or invalid credential fails at startup with a clear message, rather than on the first mention
- [x] The installed Codex version is checked against the pin — *there is no pin; see the comment below*
- [x] The installed **`gh` version is checked against a pin** — GitHub capability is now a CLI dependency, so it drifts the way Codex does *(recorded, not pinned — same comment)*
- [x] The sandbox is configured `workspace-write` with network enabled, and `execpolicy` unrestricted

## MCP connectors — Linear, and anything a self-hoster adds

- [x] Each configured MCP server is connected at startup and its current tool count is reported
- [x] Tool additions and removals are accepted without an operator approval step
- [x] The deny-list is generated as per-server disabled tools covering `merge_diff`, `submit_diff_review`, and Linear's `delete_*` family — **`merge_pull_request` and `delete_file` drop off this list**, not because they became safe but because GitHub's MCP server is no longer configured and there is nothing left to disable them on
- [x] The deny-list is hand-curated per server and explicitly **not** derived from MCP annotations — measured, Linear flags 18 of 57 tools destructive while GitHub flagged exactly one
- [x] Adding an MCP connector requires only another `mcp.json` entry; the fixed deny floor
  and its explicit `disabledTools` apply without freezing the rest of the tool surface

## GitHub — an installation, not an inventory

- [x] The App ID and private key are present and valid, and a **test installation token is actually minted at startup** — the credential that matters is the one derived at runtime, so validating the private key alone proves too little
- [x] The installation resolves, and startup **reports the resolved repository list** so the self-hoster sees the coworker's actual reach rather than the reach they intended
- [x] A repository named in configuration but absent from the installation is a loud failure naming both — the likeliest setup mistake on this path is picking repositories in GitHub's UI that do not match the config
- [x] An App that is not installed, or an organisation that has not approved the installation, fails visibly rather than degrading to public-only reads
- [x] The declared App permissions are reported at startup, and a permission the manifest should not carry — `administration`, `members`, `workflows` — is a loud failure rather than a note
- [x] Startup states plainly that **GitHub has no layer-2 deny-list**, alongside build/10's branch-protection warning, so the two halves of the weakened boundary are visible in the same place at the same moment

## Skills

- [x] The Skills location exists and is **readable but not writable** by the sandboxed engine, checked at startup rather than discovered on first use — [build/15](15-skills.md) makes this a structural guarantee, and a guarantee worth having is worth verifying before a Job depends on it

## Comments

### Inventory changes are intentionally forgiving

The original implementation froze every server's full tool list and refused startup on
any difference. That turned harmless upstream additions, removals, and renames into
operator work and made extensibility brittle. The pin and its hash were removed on
2026-07-29. Preflight still proves that the transport, credential, MCP handshake, and
`tools/list` call work, but inventory contents are informational.

### Three refusals the ticket did not ask for

Each follows from a criterion rather than extending it, and each is recorded here because a refusal nobody asked for is the kind of thing that should be argued for out loud.

- **An App installed in more than one place, with no `owner` configured, does not start.** Which account the coworker acts on is the difference between two audiences, and picking the first would be picking one for reasons that are alphabetical.
- **A Skills directory that exists and cannot be read does not start.** The criterion says the location is "readable but not writable, checked at startup" — and `readSkills` deliberately treats an unreadable directory as an empty one, so without this the instance would start, report "no Skills yet", and silently ignore every procedure in there. An *absent* directory stays a warning, because that is the ordinary starting state; the warning names the path, since the other thing absence looks like is a typo.

### The deny-list is generated, not configured

The ticket says the deny-list is "hand-curated per server and explicitly not derived from MCP annotations". Both halves are true here, but the fixed floor lives in **code** (`src/mcp/denylist.ts`) and each self-hoster can extend it in configuration.

The fixed floor names known irreversible tools exactly. Configuration adds to the floor
(`disabledTools`) and cannot lower it. Preflight warns when an explicitly configured name
is not in the live inventory, since that often indicates a typo, but it does not refuse
startup.

Two consequences worth writing down:

- **There is no wildcard `delete_*` rule.** Codex accepts exact disabled tool names, so the
  floor lists the known deletion tools. New tools are allowed unless named explicitly.
- **A novel irreversible verb is not covered.** `purge_workspace` on a future connector
  becomes available. This is the accepted cost of allowing connector capabilities to evolve
  without startup lock-outs.

### One instance file, one MCP registry, and `.env` demoted to a keyring

The original criterion asked for a single configuration file; what it did not say is what
happens to the twelve environment variables that were configuration before this ticket.
They are gone. `open-agent.config.json` is the only source for paths, bounds, model, the
GitHub App, and the MCP registry path. `mcp.json` is the only source for MCP servers. Both
**name** credentials — the variable each one lives in — rather than containing them, which
is the same rule CONTEXT.md already states for a Skill and gives the same property: either
file is safe to commit, diff, and paste into an issue.

The split was added on 2026-07-29 after checking the official TypeScript SDK. MCP defines
stdio and Streamable HTTP transports but no canonical client configuration file, so
`mcp.json` is explicitly ours. Preflight now uses `@modelcontextprotocol/client` v2 for
initialization, sessions, response parsing, pagination, and process lifecycle; Codex still
receives the same validated entries as generated configuration. See
[`research/mcp-typescript-sdk-client-config.md`](../research/mcp-typescript-sdk-client-config.md).

Two sources for one setting is how an instance ends up running with a bound nobody wrote down, so the environment configures nothing. The single exception is `CONFIG_PATH`, which cannot live inside the file it points at. Unknown keys are refused by name: a misspelled `turnTimeutMs` that parsed and did nothing would be an instance running with a bound its operator believes they set.

JSON rather than TOML or YAML, for the plain reason that Node parses it and neither of the others needs a dependency badly enough. The cost is that the file cannot carry comments, which is why `docs/configuration.md` exists and why the shipped example is exercised by a test — an example that does not validate is worse than none, since it is the first thing anybody copies.

### Two things the ticket asked for that this deliberately does not do

**There is still no version pin, for Codex or for `gh`** — and the two have different standing, which is worth separating rather than blurring.

For **Codex** the spec settles it: its runtime-configuration section says "no Codex version pin in v1" and that "build tickets referring to the project's pin mean the recorded version until a pin exists". This criterion is the build ticket that section is talking about. The version is reported and drift warns, which the spec calls the minimum that must survive that decision.

For **`gh`** there is no such line, and this is a genuine override rather than a conflict resolved: ADR-0006's own consequence says "`gh` is present at a pinned version". It is recorded instead, for a reason that does not apply to Codex — `gh` is stable where Codex ships alphas daily, so refusing to start over a minor version would be a lock-out with nothing behind it, while the drift warning delivers what the pin was for. A **missing** `gh` *is* fatal when GitHub is configured, because since ADR-0006 that is a missing dependency rather than a missing convenience. Recorded as an amendment on ADR-0006 rather than left in this ticket.

**Branch-protection verification is not here.** The spec's preflight paragraph lists it, but it is [build/10](10-branch-protection-verification.md)'s whole ticket and warns rather than refuses. What this ticket does own is making sure the *other* half of that story prints in the same startup: the plain statement that GitHub has no layer-2 deny-list.

### What is measured, and what is not

Verified against the real thing:

- Startup end to end against the live Slack workspace — `auth.test` really does validate the bot token, and the reported workspace and bot user are the real ones.
- The MCP prober against Linear's actual server. A wrong token comes back as `401 invalid_token`, reported as "it rejected the credential in `LINEAR_API_KEY`" rather than as a transport failure — which is the failure a self-hoster is most likely to hit and most likely to mistake for an outage.
- Every startup-failure message quoted in this ticket, by running the instance with the configuration that provokes it.

Also measured, and it settles a piece of stale research: **Codex 0.145.0 needs no `features.experimental_use_rmcp_client`.** `research/github-linear-surface.md` quotes Linear's own setup instructions requiring that flag for a streamable-HTTP MCP server, and the installed binary's feature list does not contain it at all — the rmcp client is compiled in (`rmcp-client/…` appears in the binary). Setting it would have been configuring a flag that no longer exists. Worth writing down because the omission looks like a bug against the research and is not.

**Not measured, and the honest gap:** `tools/list` has never been read from a live server, because no Linear credential exists in this environment. So pagination, the SSE-versus-JSON response shapes, and the session-id handshake are written from the specification and exercised only against fakes. `tests/contract/preflight-live.test.ts` covers all of it and **skips** when the credential is absent — a skipped test being the honest outcome and a passing one against a fake not being. The same file covers the GitHub App path, which is unmeasured for the same reason: no App has been registered yet, which is ticket 05's outstanding work.

That gap is worth stating plainly rather than burying: [build/11](11-linear-connector.md) is the first ticket that will run this code against a real credential, and if the prober is wrong, that is where it will be found.
