---
status: accepted
---

# Prompt-shaped Notes are structurally constrained, not merely watched

The Root note is injected into every Job in every Thread ([ADR-0003](0003-vault-is-the-memory.md)), and the Librarian may update it — so prose written there by one poisoned Job would reach every future Job the coworker ever runs. It is *prompt* rather than data. Its grammar is therefore **constrained to wikilinks with short labels, enforced by the wrapper at injection time**: anything that is not a link line is dropped, and the drop is surfaced rather than silent. A compromised Job can add a link to a malicious Note; it cannot write instructions into the prompt.

**Do not relax this to allow explanatory prose.** It will read as an arbitrary limitation. It is the only structural barrier between one poisoned Job and every subsequent one.

## Amended — Skill Notes are the second prompt-shaped file, and are human-authored only

The original decision called the Root note "the only file in the system that is prompt rather than data." That stopped being true once **Skills** were introduced: procedural Notes that tell the coworker how to do something — how to reach a read-only database, which command to run, how to interpret the result. A Skill directs behaviour, so it is prompt by the same definition.

The threat is worse than for the Root note, because the payload is executable rather than merely persuasive. The coworker is its own Librarian, so it writes Notes; and [ADR-0003](0003-vault-is-the-memory.md) makes the Vault the *only* channel between otherwise-isolated Sessions. Left unconstrained, the chain is: a Job reads a poisoned issue → edits a Skill → **a later Job, in a different Thread, with a different audience, runs the command**. The property ADR-0003 treats as the safety guarantee becomes a cross-Thread execution channel.

Grammar constraint does not work here — the whole content of a Skill is instructions, so there is nothing to strip. The constraint is therefore on **authorship**: Skills are **human-authored only, and the wrapper refuses agent writes to the Skills location**. Rejected alternative: escalating Skill diffs into the Thread. It preserves self-improvement, but it is detection after execution has already become possible, and [ticket 10](../../.scratch/slack-coworker/issues/10-memory-poisoning.md) already rejected review-by-the-same-agent reasoning for the same reason.

This is a deliberate exception to that ticket's general "visibility over gating" stance for Notes. Visibility is right for beliefs; it is not sufficient for instructions.

## Consequences

- The Root stays an ordinary Note a human can open and shape — the constraint is on grammar, not on authorship.
- A poisoned Job can still add a *link* to a malicious Note. That Note is one hop away rather than in-context, and traversing to it is a choice the coworker makes rather than context it is handed.
- The coworker cannot record *why* a hub matters in the Root; that belongs in the hub Note itself.
- Enforcement lives in the wrapper at injection, not in the writer — a compromised writer cannot bypass it, and a human editing the vault by hand cannot accidentally break the guarantee.
- **The coworker cannot improve its own Skills.** It may discover during a Job that a documented procedure is wrong or has drifted; it can say so in the Thread and write an ordinary Note about it, but the fix is a human edit. Accepted: the alternative is an agent-writable execution channel, and a Skill that is subtly wrong fails visibly where one that is maliciously right does not.
- **Two enforcement points, not one**, and they differ in kind: grammar for the Root note, authorship for Skills. Both live in the wrapper. A single "sanitise Notes" mechanism will not cover both, and implementing only one leaves the other open.
- **Skills carry no secrets.** A Skill names an environment variable; the value lives in the sandbox environment. The Vault is human-readable by design, opens in Obsidian, and will plausibly be committed to git — it is the wrong place for a credential even though it is the right place for the procedure that uses one.
- **Reaching a resource by Skill rather than by MCP server moves it outside layer 2.** The deny-list and pinned inventory hash operate on the MCP tool path; a Skill drives the shell. For anything accessed this way the credential is the *whole* boundary, so it must be genuinely scoped — a read-only database role, not a read-write one that nobody intends to write with. See [ADR-0002](0002-unattended-action-boundary.md) and [ADR-0005](0005-connectors-are-mcp-config.md).

Decided in [ticket 10](../../.scratch/slack-coworker/issues/10-memory-poisoning.md). Complements [ADR-0002](0002-unattended-action-boundary.md) (the credential bounds what a poisoned coworker can *do*) and [ADR-0003](0003-vault-is-the-memory.md) (the vault is fully human-readable, so recovery is deleting a file).
