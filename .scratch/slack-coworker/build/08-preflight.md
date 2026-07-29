# 08 — Preflight: credentials, version pins, and the inventory hash

**What to build:** A self-hoster starts the instance and either it runs or it tells them exactly what is wrong. A missing token, a Codex version that drifted from the pin, an MCP server that quietly grew a new tool since it was last reviewed, or a GitHub App that is not installed where they think it is — each stops startup with a message that names the problem. This is the gate that makes it safe to turn connectors on at all.

**Preflight now runs two different kinds of check rather than one uniform one.** [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) took GitHub out of the MCP tool path, so it has no inventory to pin; what it has instead is an installation whose repository list must be resolved and shown. Linear keeps the inventory pin unchanged. Do not try to unify these — the asymmetry is the decision, and a single abstraction over both would have to pretend GitHub has a tool surface.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

## Everything

- [ ] A single configuration file names the credentials, the Vault directory, the Skills location, the connectors, and the bounds
- [ ] A missing or invalid credential fails at startup with a clear message, rather than on the first mention
- [ ] The installed Codex version is checked against the pin
- [ ] The installed **`gh` version is checked against a pin** — GitHub capability is now a CLI dependency, so it drifts the way Codex does
- [ ] The sandbox is configured `workspace-write` with network enabled, and `execpolicy` unrestricted

## MCP connectors — Linear, and anything a self-hoster adds

- [ ] Each configured MCP server's tool inventory is probed at startup and compared against a recorded hash
- [ ] An inventory mismatch is a loud startup failure that names the specific tools that appeared or disappeared, so re-pinning is an informed decision rather than a rubber stamp
- [ ] The deny-list is generated as per-server disabled tools covering `merge_diff`, `submit_diff_review`, and Linear's `delete_*` family — **`merge_pull_request` and `delete_file` drop off this list**, not because they became safe but because GitHub's MCP server is no longer configured and there is nothing left to disable them on
- [ ] The deny-list is hand-curated per server and explicitly **not** derived from MCP annotations — measured, Linear flags 18 of 57 tools destructive while GitHub flagged exactly one
- [ ] Adding an MCP connector routes it through the same inventory pin and deny-list, so extension cannot quietly widen the blast radius

## GitHub — an installation, not an inventory

- [ ] The App ID and private key are present and valid, and a **test installation token is actually minted at startup** — the credential that matters is the one derived at runtime, so validating the private key alone proves too little
- [ ] The installation resolves, and startup **reports the resolved repository list** so the self-hoster sees the coworker's actual reach rather than the reach they intended
- [ ] A repository named in configuration but absent from the installation is a loud failure naming both — the likeliest setup mistake on this path is picking repositories in GitHub's UI that do not match the config
- [ ] An App that is not installed, or an organisation that has not approved the installation, fails visibly rather than degrading to public-only reads
- [ ] The declared App permissions are reported at startup, and a permission the manifest should not carry — `administration`, `members`, `workflows` — is a loud failure rather than a note
- [ ] Startup states plainly that **GitHub has no layer-2 deny-list**, alongside build/10's branch-protection warning, so the two halves of the weakened boundary are visible in the same place at the same moment

## Skills

- [ ] The Skills location exists and is **readable but not writable** by the sandboxed engine, checked at startup rather than discovered on first use — [build/15](15-skills.md) makes this a structural guarantee, and a guarantee worth having is worth verifying before a Job depends on it
