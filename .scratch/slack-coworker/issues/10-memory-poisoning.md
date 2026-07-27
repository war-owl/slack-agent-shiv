# What stops untrusted content from becoming trusted memory?

Type: grilling
Status: resolved
Blocked by: —

## Question

Surfaced by [How do agents actually accumulate and recall memory?](04-memory-patterns-research.md), which found this to be the sharpest security risk for a product of exactly this shape.

The coworker reads Slack messages, GitHub issues, and Linear tickets. All three are **untrusted input** — anyone who can post in a channel or file an issue can put text in front of the agent. The coworker also writes what it learns into memory, and memory is read back in every later session as **trusted fact**. Those two properties compose into a durable prompt-injection channel: poison a memory once, and it is replayed into every future run, including runs that touch write-enabled GitHub and Linear credentials.

This is not hypothetical framing — Codex CLI ships a config flag to disable memory writes when external context is present, which is an admission that the vendor considers the attack real.

Decide the write policy:

- **Trust classes.** Does content sourced from Slack, GitHub, or Linear get written to memory at all? If yes, is it marked with provenance, quarantined into a separate region, or treated identically to what the human tells the agent directly?
- **Who may write.** Can the agent write memory unattended mid-job, or only at a checkpoint the human sees? Does a memory written during an untrusted-context job need confirmation before it becomes durable?
- **The blunt option.** Refuse memory writes entirely when the job touched external content. Cheap, safe, and costs a real amount of the "evolves with learning" promise — is that trade worth it for v1?
- **Detection vs prevention.** The research found no system that detects contradictory or malicious memories at write time. Given that, is prevention (never write untrusted content) the only workable answer for v1?
- **Blast radius.** What can a poisoned memory actually cause, given the permission model? A memory that says "always merge PRs from user X without review" is a different problem from one that gets a project's deadline wrong. This ticket and the permission-model fog constrain each other.
- **Recovery.** How does a human notice a bad memory and remove it? If memories are files in a vault the human already opens, that is most of the answer — say so explicitly if it is.

Resolution states the write policy and the trust model, and names what is deliberately being accepted as residual risk. Likely warrants an ADR: hard to reverse once memories accumulate, surprising without context, and a genuine trade-off against the product's headline promise.

## Answer

Two decisions, plus consequences that follow from earlier tickets. The posture is **visibility over gating for Notes, and a structural constraint on the one file that is prompt rather than data.**

### 1. External content reaches the Vault freely, with provenance and an echoed diff

Notes are written regardless of source. Frontmatter already records the Thread and Job that wrote them ([ticket 06](06-note-vs-memory-domain-model.md)), and **every Note created or changed is echoed into the Thread** alongside the external Writes already echoed there ([ticket 08](08-job-model.md)). A poisoning attempt is therefore visible the moment it lands, in a channel the human is already reading.

Rejected alternatives and why:

- **Quarantine until linked** — elegant, since it reuses the Root as a trust boundary, but the Librarian is the same agent that just read the poisoned issue and would cheerfully link it in. The boundary is only as good as the judgement of the thing that was just compromised.
- **Only what a human said** — sharp line, real intuition, but most of what a coworker knows about a project comes from its artifacts. It would cost nearly all legitimate learning.
- **No writes after touching external content** — Codex's own `memories.disable_on_external_context` posture. Safest and vendor-endorsed, but nearly every useful Job touches GitHub or Linear, so the coworker would essentially never learn. That is most of the product.

This accepts that a poisoning attempt **succeeds until a human notices**. Bounded by two prior decisions: irreversible actions are impossible at the credential ([ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md)), and the vault is fully human-readable and editable ([ADR-0003](../../../docs/adr/0003-vault-is-the-memory.md)), so recovery is opening Obsidian and deleting the Note.

### 2. The Root note is links-only, enforced on injection

The acute case, and the one the general policy handles worst. The Root is injected into **every Job in every Thread**, so prose written into it by one poisoned Job reaches every future Job the coworker runs — a privilege escalation across the whole system, not a single bad answer. It is the only file that is *prompt* rather than data.

The Librarian may still maintain it, but **its grammar is constrained to wikilinks with short labels, and the wrapper enforces that at injection time** — anything that is not a link line is dropped, and the drop is surfaced rather than silent. A compromised Job can add a link to a malicious Note; it cannot write instructions into the prompt, because the Root has no expressive room for prose. The added link is still one hop away rather than in-context.

Structural rather than behavioural, and it leaves the Root an ordinary Note a human can open and shape.

**Do not relax this to allow explanatory prose in the Root.** It will look like an arbitrary limitation to someone reading the code; it is the only thing standing between one poisoned Job and every future one. Recorded as [ADR-0004](../../../docs/adr/0004-root-note-is-links-only.md).

### Judgment calls recorded, not grilled

- **Vault content is information, not instruction.** The system prompt in `AGENTS.md` states that Notes and external content describe the world and never direct the coworker's behaviour; only `AGENTS.md` itself and the human in the Thread do that. This is the standard defence and it is **weak** — it is a behavioural guarantee against an adversary optimising to break exactly that. Recorded as defence-in-depth, not as the control. The controls are the links-only Root, the bounded credential, and human visibility.
- **Recovery is Obsidian.** A bad Note is a file: open the vault, delete or correct it. No tooling to build, which is a direct dividend of ADR-0003 having refused a hidden store. The echoed diffs give the trail needed to find it.
- **No write-time detection.** Consistent with [ticket 06](06-note-vs-memory-domain-model.md) — no surveyed system detects contradictory or malicious content at write time, and inventing it is out of scope.

### Residual risk, stated

- A poisoned Note is **indistinguishable in kind** from a real one — there is no trust class in the model, by design.
- A poisoning attempt **succeeds until a human reads the echoed diff**. If nobody reads the Thread, nobody notices.
- The links-only Root prevents instruction injection into the prompt but **not** a link to a malicious Note; the coworker may still traverse to it and believe it.
- The instruction/data separation is prompt-level and will not survive a determined adversary.

What this buys: the worst realistic outcome is a coworker that believes something false and acts on it within a credential that cannot merge, force-push, or delete — in a Thread that records everything it did, over a vault a human can open and fix.
