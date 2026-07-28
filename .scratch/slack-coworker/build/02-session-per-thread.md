# 02 — One Session per Thread

**What to build:** A person mentions the coworker in a Thread, gets an answer, and comes back three days later with "now do the same for the other repo". The coworker remembers the whole conversation and resolves the reference without being told anything again. A mention in a different Thread starts fresh and can see nothing of the first.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [ ] A second mention in the same Thread resumes that Thread's Session rather than starting a new one
- [ ] The coworker answers a follow-up using context from earlier in the Thread, with nothing restated by the human
- [ ] The `thread_ts → codex thread_id` mapping is durable and survives a process restart
- [ ] A mention in a different Thread runs in a different Session, and nothing from the first Thread appears in its answers
- [ ] The coworker cannot reach Codex's own session storage — verified, not assumed, since that path would put a private channel's transcript one command from a public channel's answer
- [ ] The Session mapping is the only durable state the wrapper owns; Session content stays with Codex and Notes stay in the Vault
- [ ] An opt-in contract test confirms a real Session resumes in a fresh process
