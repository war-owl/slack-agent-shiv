# 13 — Setup story: manifest, configuration, and the documented traps

**What to build:** Someone who has never seen this project can go from nothing to a running coworker in their own Slack workspace, against their own tokens, without you in the room. Every trap the project has already discovered is written down where they will hit it, with the fix in hand.

**Blocked by:** 08 — Preflight; 09 — GitHub connector; 10 — Branch-protection verification; 11 — Linear connector

**Status:** ready-for-agent

- [ ] A Slack app manifest is provided, validated against Slack's manifest reference before release — the drafted one was assembled from the field reference, not copied from a Slack example
- [ ] The guide instructs self-hosters to **create their own app** from the manifest, and explains why: non-Marketplace distributed apps are throttled to one `conversations.replies` call per minute, while internal customer-built apps are exempt
- [ ] Every bot scope is listed with what it is for, and the guide distinguishes scopes Slack required from scopes it merely offered
- [ ] Socket Mode setup is covered, including why it was chosen over a public endpoint
- [ ] Protecting the default branch of every connected repository is presented as a **prerequisite**, not a recommendation, with the specific settings required
- [ ] The GitHub token section specifies a classic PAT with `repo`, withholding `delete_repo`, `admin:org`, and `workflow`, and explains the trade that was made
- [ ] The documented traps are written down: the org-approval trap, any plan-gating on branch protection for private repositories, the Codex authentication mode required for an always-on bot, and why the Codex version is pinned
- [ ] The configuration schema is documented in full — everything a self-hoster must supply, and how
- [ ] It is stated plainly that the stack is effectively OpenAI-only, since any alternative backend must serve an OpenAI Responses API
- [ ] Someone unfamiliar with the project follows the guide end to end and reaches a working @-mention
