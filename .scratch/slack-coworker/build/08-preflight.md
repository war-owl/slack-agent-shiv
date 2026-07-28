# 08 — Preflight: credentials, version pin, and the inventory hash

**What to build:** A self-hoster starts the instance and either it runs or it tells them exactly what is wrong. A missing token, a Codex version that drifted from the pin, or a connector that quietly grew a new tool since it was last reviewed all stop startup with a message that names the problem. This is the gate that makes it safe to turn connectors on at all.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [ ] A single configuration file names the tokens, the Vault directory, the connectors, and the bounds
- [ ] A missing or invalid credential fails at startup with a clear message, rather than on the first mention
- [ ] The installed Codex version is checked against the pin
- [ ] Each configured MCP server's tool inventory is probed at startup and compared against a recorded hash
- [ ] An inventory mismatch is a loud startup failure that names the specific tools that appeared or disappeared, so re-pinning is an informed decision rather than a rubber stamp
- [ ] The deny-list is generated as per-server disabled tools covering `merge_pull_request`, `merge_diff`, `submit_diff_review`, `delete_file`, and Linear's `delete_*` family
- [ ] The deny-list is hand-curated per server and explicitly **not** derived from MCP annotations — measured, Linear flags 18 of 57 tools destructive while GitHub flags exactly one, leaving `merge_pull_request` and `push_files` unflagged
- [ ] The sandbox is configured `workspace-write` with network enabled, and `execpolicy` unrestricted
- [ ] Adding a connector routes it through the same inventory pin and deny-list, so extension cannot quietly widen the blast radius
