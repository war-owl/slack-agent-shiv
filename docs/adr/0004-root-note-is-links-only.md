---
status: accepted
---

# The Root note is links-only, enforced on injection

The Root note is injected into every Job in every Thread ([ADR-0003](0003-vault-is-the-memory.md)), and the Librarian may update it — so prose written there by one poisoned Job would reach every future Job the coworker ever runs. It is the only file in the system that is *prompt* rather than data. Its grammar is therefore **constrained to wikilinks with short labels, enforced by the wrapper at injection time**: anything that is not a link line is dropped, and the drop is surfaced rather than silent. A compromised Job can add a link to a malicious Note; it cannot write instructions into the prompt.

**Do not relax this to allow explanatory prose.** It will read as an arbitrary limitation. It is the only structural barrier between one poisoned Job and every subsequent one.

## Consequences

- The Root stays an ordinary Note a human can open and shape — the constraint is on grammar, not on authorship.
- A poisoned Job can still add a *link* to a malicious Note. That Note is one hop away rather than in-context, and traversing to it is a choice the coworker makes rather than context it is handed.
- The coworker cannot record *why* a hub matters in the Root; that belongs in the hub Note itself.
- Enforcement lives in the wrapper at injection, not in the writer — a compromised writer cannot bypass it, and a human editing the vault by hand cannot accidentally break the guarantee.

Decided in [ticket 10](../../.scratch/slack-coworker/issues/10-memory-poisoning.md). Complements [ADR-0002](0002-unattended-action-boundary.md) (the credential bounds what a poisoned coworker can *do*) and [ADR-0003](0003-vault-is-the-memory.md) (the vault is fully human-readable, so recovery is deleting a file).
