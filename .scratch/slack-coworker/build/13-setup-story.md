# 13 — Setup story: manifest, configuration, and the documented traps

**What to build:** Someone who has never seen this project can go from nothing to a running coworker in their own Slack workspace, against their own tokens, without you in the room. Every trap the project has already discovered is written down where they will hit it, with the fix in hand.

**Two manifests now, not one.** [ADR-0006](../../../docs/adr/0006-github-is-a-skill-over-gh.md) replaced the GitHub PAT with a GitHub App, so the project ships a **GitHub App manifest** beside the Slack one, and the setup path grows a registration and an installation. This is a materially longer road than pasting a token, and the thing it buys — the self-hoster picking which repositories the coworker can reach — is the reason to walk it.

**Blocked by:** 08 — Preflight; 09 — GitHub as a Skill over `gh`; 10 — Branch-protection verification; 11 — Linear connector

**Status:** ready-for-agent

- [ ] A Slack app manifest is provided, validated against Slack's manifest reference before release — the drafted one was assembled from the field reference, not copied from a Slack example
- [ ] The guide instructs self-hosters to **create their own app** from the manifest, and explains why: non-Marketplace distributed apps are throttled to one `conversations.replies` call per minute, while internal customer-built apps are exempt
- [ ] Every bot scope is listed with what it is for, and the guide distinguishes scopes Slack required from scopes it merely offered
- [ ] Socket Mode setup is covered, including why it was chosen over a public endpoint
- [ ] Protecting the default branch of every connected repository is presented as a **prerequisite**, not a recommendation, with the specific settings required — and the guide says why it matters more than it used to: with GitHub outside the MCP tool path there is no deny-list behind it
- [ ] A **GitHub App manifest** is provided and the guide walks registration, the private key, and installation — including choosing **"Only select repositories"**, which is the whole point of the App and the one screen a self-hoster must not rush
- [ ] The App permission list is documented with what each is for, and the guide states which permissions are deliberately **not** requested (`administration`, `members`, `workflows`) and why a writable CI definition in particular is an execution path around every other control
- [ ] The guide states plainly, in its own section rather than a footnote, that **the coworker can technically merge its own pull requests** unless the default branch is protected — because the Skill's "do not merge" is an instruction and not a boundary, and free-plan private repositories cannot be protected at all
- [ ] The guide states that GitHub is **connect and forget**: installed once, never revisited, nothing to rotate on a schedule — and that this is *better* than the PAT it replaces, since GitHub pushes PATs toward a 30/60/90-day expiry and a lapsed one silently stops the coworker. The one-hour installation token is internal and deliberately **not** presented as something the reader must manage
- [ ] The three places "forget" genuinely ends are listed, and only these: adding a repository later, changing the App's declared permissions, and one org-owner approval for org-owned repositories
- [ ] Storing the **App private key** is covered — it has no expiry and needs no rotation schedule, but it is the one long-lived secret the instance holds and losing it means re-registering
- [ ] `gh` is documented as a **required dependency at a pinned version**, alongside Codex — GitHub capability is now a CLI dependency rather than a config block
- [ ] The documented traps are written down: ~~the org-approval trap~~ **organisation approval of the App installation** (which fails visibly, unlike the PAT that silently read only public data), any plan-gating on branch protection for private repositories, the Codex authentication mode required for an always-on bot, and why both the Codex and `gh` versions are pinned
- [ ] The configuration schema is documented in full — everything a self-hoster must supply, and how
- [ ] It is stated plainly that the stack is effectively OpenAI-only, since any alternative backend must serve an OpenAI Responses API
- [ ] Someone unfamiliar with the project follows the guide end to end and reaches a working @-mention
