# 14 — File ingress: raw data from the Thread into the workspace

**What to build:** A person drags a CSV, a log dump, or a JSON export into a Slack Thread, @-mentions the coworker, and asks it to analyse the thing. The file lands inside the Job's sandbox workspace and the coworker is told it is there. Without this, the only way to get data into a Job is pasting it as message text, which caps the useful size at a few kilobytes and mangles anything tabular.

This is the ingress half of the analysis use case. It writes and runs a script against the file rather than reasoning over it in-context, which is the whole reason a coding agent is a reasonable engine for non-code work.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent, *after the verification block below*

## Verify first — none of this was researched

The Slack surface research covers `app_mention`, status, rate limits, and Socket Mode. It says **nothing about files**, so the following are assumptions, not findings, and the first task on this ticket is to confirm them against a live workspace:

- The exact shape of an `app_mention` event when the message carries attachments — whether files arrive on the event, and under which key.
- Whether **`files:read`** is sufficient, or a conversation-history scope is also required to see attachments in channels the bot has not joined.
- Whether Codex CLI can read **images** at all when driven through `codex exec`. Assume not until measured; this decides whether screenshots are a supported input or an honest "I can't read that".
- Whether Socket Mode delivery changes any of the above.

**This ticket changes the Slack app manifest.** Adding a scope means a re-install, which lands on [ticket 05](../issues/05-provision-accounts-and-tokens.md) and on [build/13 — setup story](13-setup-story.md). Record the new scope in both.

## Acceptance criteria

- [ ] The Slack app requests the scope(s) established above, and the manifest change is reflected in the setup story rather than only in a running instance
- [ ] A mention carrying one or more files produces a Job in which those files are present in the sandbox workspace before the engine starts
- [ ] Download uses the **authenticated** private-download URL with the bot token as a bearer header
- [ ] **The silent-failure trap is tested explicitly:** an unauthenticated fetch of a Slack private file URL returns a login page, not an error. A naive implementation writes HTML to `data.csv` and the Job then "analyses" a login page. Assert on returned content type and magic bytes, not on HTTP status
- [ ] Files land **inside the Job's workspace root** — the sandbox is `workspace-write`, so anything written elsewhere is invisible to the engine
- [ ] The prompt names each ingested file, its path, and its declared type. A file the coworker is not told about will not be found; the Vault's traversal habit does not extend to scanning its own workspace
- [ ] A configurable **size ceiling** is enforced *before* download, from the file metadata, not after the bytes have landed
- [ ] Unsupported or unreadable types fail **honestly in the Thread** — "I can't read a .sketch" — rather than being dropped silently or hallucinated over
- [ ] Filenames are sanitised before hitting the filesystem; a Slack filename is attacker-controlled and path traversal is the obvious attack
- [ ] Ingested files are **untrusted external content** under [ADR-0004](../../../docs/adr/0004-root-note-is-links-only.md): if anything derived from one becomes a Note, provenance records the Thread, the Job, and the source file. A CSV with a prompt-injection payload in a cell is the expected case, not a hypothetical
- [ ] A stated **retention policy** for workspace files — they accumulate per Job and nothing else in the design cleans them up
- [ ] Tests drive a synthetic mention carrying a files array against a fake Slack that serves a fixture, and assert on both the bytes on disk and the prompt the fake engine received
- [ ] One test asserts the login-page case is caught rather than written to disk

## Notes

**Egress is deliberately not in scope.** Posting a generated file *back* into the Thread is a separate concern with its own scope (`files:write`) and its own audit question — a written file is arguably a [Write](../../../CONTEXT.md#write) and would need appending to the Thread record. If the analysis use case needs it, ticket it separately rather than widening this one.

**Ingress is not memory.** A file in the workspace is input to one Job. If it is worth keeping, the Librarian writes a Note *about* it; the raw file is not itself a Note and does not belong in the Vault.
