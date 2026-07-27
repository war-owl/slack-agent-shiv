---
status: accepted
---

# The credential is the action boundary, not the tool policy

The coworker acts unattended ([ADR-0001](0001-codex-cli-via-exec-and-sdk.md)) while reading untrusted input from Slack, GitHub, and Linear, so there is no human between a crafted issue comment and an action. We bound this in three layers: the coworker may do **anything a human can undo after the fact** but not the irreversible actions (`merge_pull_request`, `merge_diff`, `submit_diff_review`, `delete_file`, and Linear's `delete_*` family); that list is enforced as a **deny-list with a pinned hash of each MCP server's `tools/list`**, so a hosted server adding a tool causes a loud startup failure instead of a silent capability gain; and because the agent has shell access and the PAT doubles as the git password, **the credential itself is scoped so the blocked actions are impossible** — the tool policy is defence-in-depth, not the boundary.

## Consequences

- **Conditional on an unverified fact.** This assumes GitHub's fine-grained PAT can grant pull-request write *without* merge. If it cannot, the third layer collapses and the decision reopens — the alternatives are sandbox egress allow-listing, withholding the credential from the shell, or accepting the bypass explicitly.
- **MCP annotations are not a portable safety primitive.** Measured: Linear flags 18 of 57 tools destructive; GitHub flags exactly one (`delete_file`) and leaves `merge_pull_request` and `push_files` unflagged. Any deny-list must be hand-curated per server, which is why the inventory pin exists.
- **Linear's `save_*` tools are upserts.** "May create but not modify" is not expressible at tool granularity — only at argument granularity — so that line is deliberately not drawn. GitHub splits create/update; Linear does not. Do not assume symmetry between connectors.
- **Sandbox is `workspace-write` with network enabled**; `execpolicy` is unrestricted in v1. Once the credential is the boundary, per-command rules cost more tuning than they buy.
- **Pinning detects change, not danger.** A human still reads the diff and re-pins.
- **Residual risk is accepted, not eliminated.** Anything within the token's power is reachable by prompt injection. Non-destructive but embarrassing actions are fully available and recovery is manual.

Decided in [ticket 12](../../.scratch/slack-coworker/issues/12-blast-radius.md); inventories measured in [ticket 05](../../.scratch/slack-coworker/issues/05-provision-accounts-and-tokens.md).
