# 08 — Preflight: credentials, version pins, and the inventory hash

**What to build:** A self-hoster starts the instance and either it runs or it tells them exactly what is wrong. A missing token, a Codex version that drifted from the pin, an MCP server that quietly grew a new tool since it was last reviewed, or a GitHub App that is not installed where they think it is — each stops startup with a message that names the problem. This is the gate that makes it safe to turn connectors on at all.

**Preflight now runs two different kinds of check rather than one uniform one.** [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) took GitHub out of the MCP tool path, so it has no inventory to pin; what it has instead is an installation whose repository list must be resolved and shown. Linear keeps the inventory pin unchanged. Do not try to unify these — the asymmetry is the decision, and a single abstraction over both would have to pretend GitHub has a tool surface.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

## Everything

- [x] A single configuration file names the credentials, the Vault directory, the Skills location, the connectors, and the bounds
- [x] A missing or invalid credential fails at startup with a clear message, rather than on the first mention
- [x] The installed Codex version is checked against the pin — *there is no pin; see the comment below*
- [x] The installed **`gh` version is checked against a pin** — GitHub capability is now a CLI dependency, so it drifts the way Codex does *(recorded, not pinned — same comment)*
- [x] The sandbox is configured `workspace-write` with network enabled, and `execpolicy` unrestricted

## MCP connectors — Linear, and anything a self-hoster adds

- [x] Each configured MCP server's tool inventory is probed at startup and compared against a recorded hash
- [x] An inventory mismatch is a loud startup failure that names the specific tools that appeared or disappeared, so re-pinning is an informed decision rather than a rubber stamp
- [x] The deny-list is generated as per-server disabled tools covering `merge_diff`, `submit_diff_review`, and Linear's `delete_*` family — **`merge_pull_request` and `delete_file` drop off this list**, not because they became safe but because GitHub's MCP server is no longer configured and there is nothing left to disable them on
- [x] The deny-list is hand-curated per server and explicitly **not** derived from MCP annotations — measured, Linear flags 18 of 57 tools destructive while GitHub flagged exactly one
- [x] Adding an MCP connector routes it through the same inventory pin and deny-list, so extension cannot quietly widen the blast radius

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

### The pin that is not a hash, because a hash cannot be re-pinned

[ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md) says "pin a hash of each server's `tools/list`", and this criterion says an inventory mismatch must name the tools that appeared or disappeared. **Those two cannot both be satisfied by a hash**, and it took building it to see why: one changed digit is not something a human can review, and "review the diff, then re-pin" is the documented step that gives the mechanism its value.

So the pin is the **tool list**, and the hash is derived from it and reported beside it. Configuration carries `pinnedTools` — all 57 of Linear's, in `open-agent.config.example.json` — which is bulkier than a digest and exactly what ADR-0005 already asked for when it noted that the pin "doubles as this project's only record of what Linear offers". Startup prints the fingerprint so re-pinning can be confirmed at a glance, and the failure message prints the new fingerprint *and* the new list, so acting on it costs a paste rather than a script.

**Sorted before hashing**, so a server reordering its own response is not an alarm. That is not laxness: the remedy for an alarm is to re-pin, and an operator who has learned that re-pinning is routine will re-pin the day it matters.

### Three refusals the ticket did not ask for

Each follows from a criterion rather than extending it, and each is recorded here because a refusal nobody asked for is the kind of thing that should be argued for out loud.

- **An unpinned connector does not start.** Below.
- **An App installed in more than one place, with no `owner` configured, does not start.** Which account the coworker acts on is the difference between two audiences, and picking the first would be picking one for reasons that are alphabetical.
- **A Skills directory that exists and cannot be read does not start.** The criterion says the location is "readable but not writable, checked at startup" — and `readSkills` deliberately treats an unreadable directory as an empty one, so without this the instance would start, report "no Skills yet", and silently ignore every procedure in there. An *absent* directory stays a warning, because that is the ordinary starting state; the warning names the path, since the other thing absence looks like is a typo.

### An unpinned connector does not start

Not in the ticket, and it follows from it. The obvious alternative — adopt whatever the server advertises on first run — makes the whole mechanism worthless: the one moment somebody is certainly watching is the moment they add a connector, and an inventory adopted without being read is a review that never happened. So the first startup *is* the review. It refuses, prints the inventory, and asks for a decision.

### The deny-list is generated, not configured

The ticket says the deny-list is "hand-curated per server and explicitly not derived from MCP annotations". Both halves are true here, but the curation lives in **code** (`src/mcp/denylist.ts`) rather than in each self-hoster's configuration file, and it is computed per server from that server's pin.

The reason is the failure mode a configured list has: an entry naming a tool that does not exist is a boundary that silently is not there. `disabled_tools: ["merge_dif"]` is indistinguishable from a working configuration at startup and does nothing at all. Generating from the pinned inventory means it cannot be forgotten and cannot be mistyped. Configuration adds to the floor (`disabledTools`) and cannot lower it.

Two consequences worth writing down:

- **`delete_` is a prefix rule, not four names.** A server that adds a fifth `delete_*` tool should not be able to hand it over by being renamed in configuration. `merge_` is deliberately *not* generalised — per the criterion above, GitHub is out of the tool path, and a rule written for a connector nobody has is a rule nobody has tested.
- **A novel irreversible verb is not covered**, and cannot be. `purge_workspace` on some future connector passes the name rules. What catches it is the inventory pin — its *arrival* is a loud failure — which is the honest division of labour: the pin detects change, the name rules block the change we have already seen, and a human decides.

### It is derived from the pin rather than from the live probe, and that is what makes the ordering work

The deny-list has to reach Codex as generated configuration, which happens when the engine is constructed — before preflight has probed anything. Computing it from the *pin* rather than the live inventory dissolves the ordering problem entirely, and is sound precisely because preflight refuses to start when the two disagree. A deny-list built from a stale pin cannot survive to a first Job.

### One configuration file, and `.env` demoted to a keyring

The criterion asked for a single configuration file; what it did not say is what happens to the twelve environment variables that were configuration before this ticket. They are gone. `open-agent.config.json` is the only source for paths, bounds, model, connectors, and the GitHub App, and it **names** credentials — the variable each one lives in — rather than containing them, which is the same rule CONTEXT.md already states for a Skill and gives the same property: the file is safe to commit, diff, and paste into an issue.

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
