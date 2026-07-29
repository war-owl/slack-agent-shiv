# 11 — Linear connector over MCP

**What to build:** The coworker can work with real Linear data — reading issues and projects, filing and updating tickets, commenting — through the same audit path and the same deny-list as GitHub. A person can ask it to pick up a ticket and it knows what the ticket says.

**Blocked by:** 04 — Audit: every Write appended; 08 — Preflight

**Status:** ready-for-agent

- [ ] Linear is configured as an MCP server authenticated with a plain API key as a bearer token — no OAuth, no callback, no refresh
- [ ] The coworker can read issues, projects, and teams, and filter through the list tools (there is no issue-search tool)
- [ ] Writes through the `save_*` upserts and comment tools each appear in the Thread's audit channel
- [ ] Reads appear in the same audit channel by design; no Linear tool classification list
  is required or maintained
- [ ] The `delete_*` family is denied and unavailable
- [ ] Preflight verifies the connector and reports its current tool count without pinning
  the full inventory; known deletion tools remain explicitly disabled
- [ ] It is documented that `save_*` tools are upserts, so "may create but not modify" is not expressible and the coworker can overwrite an existing issue while nominally creating one
- [ ] The GitHub identity join via a Linear user's linked GitHub id is used opportunistically where present, and the coworker behaves sensibly for the majority of users who have not linked their accounts
