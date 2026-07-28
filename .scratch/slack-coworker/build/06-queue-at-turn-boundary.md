# 06 — Queue at the Turn boundary

**What to build:** A person adds "also check the staging config" while the coworker is already twenty minutes into a Job. The message is acknowledged straight away so it clearly landed, then delivered into the same Session once the current Turn finishes — no second Job racing the first, no lost message. Meanwhile a colleague in another channel delegates something entirely separate and it starts immediately.

**Blocked by:** 02 — One Session per Thread

**Status:** ready-for-agent

- [ ] A mention arriving while a Job is running is acknowledged immediately, so silence never reads as the message being dropped
- [ ] The queued mention is delivered into the same Session at the next Turn boundary
- [ ] Two Jobs never run concurrently within one Thread
- [ ] Jobs in different Threads run concurrently and do not block each other
- [ ] Multiple mentions queued during one Job are delivered in the order they arrived
- [ ] The accepted cost is documented in the Thread's behaviour: a correction like "stop, wrong repo" queues rather than interrupting, and hard-stop is the way to interrupt
