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

**This ticket changes our Slack app configuration.** Adding a scope means reinstalling
the app in our workspace; record the measured scope in
[ticket 05](../issues/05-provision-accounts-and-tokens.md).

## Acceptance criteria

- [ ] Our Slack app requests the scope(s) established above and the required configuration
  is recorded with this ticket
- [x] A mention carrying one or more files produces a Job in which those files are present in the sandbox workspace before the engine starts
- [x] Download uses the **authenticated** private-download URL with the bot token as a bearer header
- [x] **The silent-failure trap is tested explicitly:** an unauthenticated fetch of a Slack private file URL returns a login page, not an error. A naive implementation writes HTML to `data.csv` and the Job then "analyses" a login page. Assert on returned content type and magic bytes, not on HTTP status
- [x] Files land **inside the Job's workspace root** — the sandbox is `workspace-write`, so anything written elsewhere is invisible to the engine
- [x] The prompt names each ingested file, its path, and its declared type. A file the coworker is not told about will not be found; the Vault's traversal habit does not extend to scanning its own workspace
- [x] A configurable **size ceiling** is enforced *before* download, from the file metadata, not after the bytes have landed
- [x] Unsupported or unreadable types fail **honestly in the Thread** — "I can't read a .sketch" — rather than being dropped silently or hallucinated over
- [x] Filenames are sanitised before hitting the filesystem; a Slack filename is attacker-controlled and path traversal is the obvious attack
- [x] Ingested files are **untrusted external content** under [ADR-0004](../../../docs/adr/0004-root-note-is-links-only.md): if anything derived from one becomes a Note, provenance records the Thread, the Job, and the source file. A CSV with a prompt-injection payload in a cell is the expected case, not a hypothetical
- [x] A stated **retention policy** for workspace files — they accumulate per Job and nothing else in the design cleans them up
- [x] Tests drive a synthetic mention carrying a files array against a fake Slack that serves a fixture, and assert on both the bytes on disk and the prompt the fake engine received
- [x] One test asserts the login-page case is caught rather than written to disk

## Notes

**Egress remains a separate concern and is now
[build/16](16-file-egress-to-slack.md).** It uses `files:write` and gives every upload its
own permanent Write receipt.

**Ingress is not memory.** A file in the workspace is input to one Job. If it is worth keeping, the Librarian writes a Note *about* it; the raw file is not itself a Note and does not belong in the Vault.

## Comments

**Implemented 2026-07-30.** Attached files are written under
`.open-agent/inputs/<job-id>/` in the Thread workspace before the engine starts. The
metadata ceiling runs before any Slack call; returned bytes are checked again. Private
downloads use the bot token, and both `Content-Type: text/html` and HTML magic bytes catch
Slack's sign-in-page response.

The app-event shape, `files:read` requirement, and private download URL are confirmed by
Slack's current official docs and SDK types. A live workspace reinstall and Socket Mode
delivery check remain external verification, so the first acceptance item stays open.
Images remain unsupported until a real headless Codex run proves it can read them.

Inputs persist with the per-Thread workspace. There is no automatic deletion; removing
that workspace is the retention control.
