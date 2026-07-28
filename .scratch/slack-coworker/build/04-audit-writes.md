# 04 — Audit: every Write appended

**What to build:** The coworker acts unattended, so the Thread is the only accountability record anyone ever sees. Every Write it makes against something outside itself lands in the Thread as its own permanent message that nothing later can overwrite. A person scrolling back a week later can reconstruct exactly what it did.

This is deliberately built before the connectors, so that no connector ever ships without a record of what it did. It is demoable now against local file and command Writes.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [ ] Every Write is appended as its own new message in the Thread
- [ ] A Write record is never edited after it is posted
- [ ] Each record names the thing that was written and links to it wherever a link exists
- [ ] Progress updates never touch a Write record — the two channels have opposite semantics and must not share a message
- [ ] Records appear in the order the Writes happened
- [ ] Verified end to end with local file and command Writes, before any MCP connector exists
- [ ] The reporting path is shaped so that connector Writes flow through it unchanged when they arrive
