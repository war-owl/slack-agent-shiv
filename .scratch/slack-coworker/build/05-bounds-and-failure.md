# 05 — Bounds, hard-kill, and honest failure

**What to build:** Everything that happens when a Job does not simply succeed. A runaway Job stops on its own before it costs a weekend or a bill. A person can stop one deliberately. A Job that dies says what it got done, what it did not, and — plainly — that some of its side effects may already have landed. And when the coworker picks the Thread back up, it is told it was interrupted, so it checks before pushing a branch that already exists.

Codex supplies none of this: it reports usage after the fact and offers no ceiling, no max-Turns, and no kill switch. Every bound here is the wrapper's.

**Blocked by:** 02 — One Session per Thread

**Status:** ready-for-agent

- [ ] A per-Turn wall-clock timeout hard-kills the subprocess when it expires
- [ ] A maximum number of Turns per Job is enforced
- [ ] A cumulative token budget per Job is accumulated from turn-completion usage and enforced
- [ ] All three bounds are configurable, with defaults conservative enough that a runaway Job is an annoyance rather than a bill
- [ ] Hitting a bound posts a message that clearly says the Job was **stopped**, names which bound stopped it, and cannot be mistaken for a completed result
- [ ] A person can hard-stop a running Job from the Thread, and the subprocess actually dies
- [ ] A Job that dies for any reason posts what completed, what did not, and that side effects may have partially landed
- [ ] The Session survives a dead Job; the next mention resumes from the last completed Turn
- [ ] Resuming after an interrupted Turn injects a warning telling the coworker the previous Turn may have partially completed and that it should verify state before repeating actions
- [ ] An opt-in contract test confirms hard-kill terminates a real Codex process
