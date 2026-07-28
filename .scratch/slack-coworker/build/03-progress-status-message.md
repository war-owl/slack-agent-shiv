# 03 — Progress: the status message

**What to build:** A person delegates a long task and walks away. When they glance back at the Thread, one message tells them what the coworker is doing and how far through it is — updated in place, not buried under a wall of narration. A ten-minute silent test run still looks alive rather than hung.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [ ] One status message is posted when a Job starts and edited in place thereafter; a Job never produces a second progress message
- [ ] Its content is driven by the engine's todo list, showing the coworker's own plan and which step it is on
- [ ] It is refreshed on a time-driven cadence inside Slack's two-minute status timeout, even when the engine has emitted nothing — long-running commands are silent until they complete, and silence must not read as a crash
- [ ] The status message is visually distinct from the coworker's final answer, so the Thread stays skimmable afterwards
- [ ] Individual tool calls are not narrated into the channel
- [ ] The status message stops updating and settles into a final state when the Job ends
- [ ] Editing in place is used rather than posting, in line with Slack's rate limits
