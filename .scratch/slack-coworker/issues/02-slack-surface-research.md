# How does Slack model a bot that thinks for an hour?

Type: research
Status: resolved
Blocked by: —

## Question

Delegate-and-walk-away is at odds with how chat platforms usually work. Establish the facts before any design depends on them.

Investigate against Slack's primary documentation and report with citations:

- **Entry point.** What surfaces exist for a bot invoked by mention — the `app_mention` event, the newer Assistant/agent surfaces, slash commands, and Assistant threads. Which is the right primitive for "mention me in any channel and I'll go work", and what does each require of the app manifest and scopes?
- **The acknowledgement window.** Slack's event delivery expects a fast ack. What exactly is required, what happens if you miss it, and what is the sanctioned pattern for work that takes minutes or hours?
- **Progress in a thread.** What are the mechanics and rate limits for posting and editing messages in a thread over a long period? Is editing one status message the intended pattern, or appending? What are the current rate limits that would bite a chatty agent?
- **Socket Mode vs Events API.** For something self-hosted behind a home firewall or on a laptop, Socket Mode avoids a public HTTPS endpoint. What are the trade-offs, limits, and production caveats?
- **Bolt for TypeScript.** What does the framework give you, and what does it leave to you for long-running work?
- **App setup.** What must a self-hoster do by hand to create the app, set scopes, and install it into their own workspace? This is the setup story others have to follow.

Deliverable: a cited Markdown file in the repo. Feeds *How does a delegated job actually run?* and the setup-story fog.

## Answer

Findings: [`research/slack-surface.md`](../research/slack-surface.md) — cited against Slack's own documentation and verified against Bolt's source. Seven gaps are flagged explicitly in its §7 rather than guessed, notably the undocumented Socket Mode ack timeout.

**Entry point: `app_mention`, and it is the only candidate.** It is the sole primitive that fires on an @-mention in an arbitrary channel *and* inside a thread. Slash commands are explicitly barred from threads. Slack's Agent/Assistant surface (`agent_view`, which replaced `assistant_view` on 2026-06-30) is DM and Messages-tab only — not channels. Minimum bot scopes: `app_mentions.read`, `chat:write`, `chat:write.public`, `channels:history` and siblings.

**The ack window is 3 seconds, and the answer to long work is a queue.** Three retries (immediate, +1 min, +5 min); auto-disable only above 95% failure at >1000 events/hour. Slack's entire sanctioned pattern for long-running work is "ack immediately, put it on a queue" — there is no platform continuation, no callback, and **no expiring token**: the bot token in `.env` can write to the thread indefinitely, which is exactly what delegate-and-walk-away needs. The real hazard is duplicate runs from retries, so **dedupe on `event_id`**.

**Progress reporting — a hard constraint the job model must respect.** As of 2026-03-05 `assistant.threads.setStatus` works **in channels** with just `chat:write`, which is the natural "still working…" affordance. But it has a **two-minute timeout**, so any job longer than that needs a sub-two-minute heartbeat or the thread goes visually dead. Slack's own agent-design guidance says update status in place and batch notifications, and the rate limits agree: `chat.update` is Tier 3 (50+/min) against `chat.postMessage`'s roughly 1/sec/channel. `plan` and `task_card` blocks (shipped 2026-02-11) exist for exactly this. This lines up neatly with the Codex finding that the todo-list item is the only thing emitting `item.updated`.

**Socket Mode is right here despite Slack recommending HTTP.** Slack's stated reasons — scaling, Marketplace, stateful connections, a 10-connection cap — are all about distributed apps and none apply to a single self-hoster. It removes the public HTTPS endpoint entirely, which matters a great deal for someone running this on a laptop or behind a home firewall.

**Bolt: two things actively fight a long-running handler.** Verified in `App.ts` — Bolt **auto-acks Events API requests before the listener runs**, which is what makes long work possible at all, and v5 injects `setStatus()` / `sayStream()` into `app_mention` listeners. But `processBeforeResponse: true` — and therefore `AwsLambdaReceiver` and any FaaS deployment — would turn one mention into **four duplicate runs**. And the `HTTPResponseAck` 3001 ms watchdog 404s unacked interactive payloads. There are no lazy listeners in the JavaScript SDK; that is Python-only.

**Setup story is close to one click.** A URL-encoded manifest link (`api.slack.com/apps?new_app=1&manifest_yaml=…`) collapses most of it. Irreducibly manual: generate the `xapp-` token with `connections:write`, install and copy the `xoxb-` token, and `/invite` the bot.

**The finding that reinforces the audience decision.** The May 2025 non-Marketplace rate-limit clampdown drops `conversations.replies` to **1 request/minute and 15 messages** — but internal, customer-built apps are explicitly exempt. That is a hard technical reason never to ship this as a single distributed Slack app. "Create your own app from this manifest" is not merely the open-source convention here; it is the only configuration that performs.
