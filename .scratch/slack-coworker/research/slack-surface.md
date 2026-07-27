# How does Slack model a bot that thinks for an hour?

Research for issue `02-slack-surface-research`. All claims below are sourced from Slack's own
developer documentation (`docs.slack.dev` / `api.slack.com`), Slack's official changelog, or the
`slackapi/bolt-js` and `slackapi/node-slack-sdk` source on GitHub. Where I could not establish
something from a primary source, it is called out explicitly under **Gap** rather than guessed.

Researched 2026-07-28. Slack's AI/agent surface is moving fast — several of the load-bearing facts
here changed in the last six months (see [§3](#3-progress-in-a-thread) and
[§1.2](#12-the-agent--assistant-surface)), so re-verify before implementation if much time passes.

---

## 1. Entry point

### 1.1 `app_mention`

The `app_mention` event fires when someone directly mentions your bot user in a conversation.

- Required scope: **`app_mentions.read`**. The app "requires a bot user configured and installed"
  to use it. ([app_mention event reference](https://docs.slack.dev/reference/events/app_mention))
- You receive it in two situations: when your app is **already a member** of the channel and gets
  mentioned, and when someone mentions your app in a channel it is **not** in — the mention that
  invites the app also delivers the event.
  ([app_mention](https://docs.slack.dev/reference/events/app_mention))
- **DMs are excluded.** Messages in direct-message conversations are "not dispatched via
  `app_mention`"; you must subscribe to `message.im` for DM handling.
  ([app_mention](https://docs.slack.dev/reference/events/app_mention))
- Payload carries `user`, `text`, `ts`, `channel`, `event_ts` — enough to reply in-thread
  (`thread_ts = event.thread_ts ?? event.ts`).
  ([app_mention](https://docs.slack.dev/reference/events/app_mention))

To *read* the surrounding thread you need `conversations.replies`, which for a bot token requires
`channels:history`, `groups:history`, `im:history`, `mpim:history`
([conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)).

To *post* into a public channel your app has not joined, you additionally need
**`chat:write.public`** — "Send messages to channels your Slack app isn't a member of", and "To use
this scope, your app must also request `chat:write`"
([chat:write.public](https://docs.slack.dev/reference/scopes/chat.write.public/)). `chat.postMessage`
itself notes "New Slack apps do *not* begin life with the ability to post in all public channels."
([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/))

### 1.2 The Agent / Assistant surface

Slack's dedicated AI surface is a **DM-side experience**, not a channel one. Slack describes
"dedicated surfaces for agents, including a split-view container, top navigation entry point, app
threads, text streaming, and suggested prompts" ([AI in Slack](https://docs.slack.dev/ai/)), and
agent conversations "happen in the app's Messages tab"
([Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps/)).

There are now **two** variants, and the naming changed very recently:

| | `agent_view` (current) | `assistant_view` (legacy) |
|---|---|---|
| Where conversations live | Standard Messages tab, agent replies in-thread — "conversations look & feel the same as a regular direct message" | Separate Chat and History tabs |
| Detect user opening the DM | `app_home_opened` | `assistant_thread_started` |
| Status | Only option for new apps | Existing apps may continue "for now", "will eventually be deprecated" |

Sources: [Introducing the Agent messaging experience, 2026-06-30](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/);
[App manifest reference — `features.assistant_view`](https://docs.slack.dev/reference/app-manifest/)
("New apps can only use `agent_view`").

Event subscriptions differ per variant
([Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps/)):

- `agent_view`: `app_home_opened`, `app_context_changed`, `message.im`
- `assistant_view` (legacy): `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`

`app_context_changed` is new as of [2026-07-02](https://docs.slack.dev/changelog/2026/07/02/app-context/):
Slack passes the app the entity the user is currently viewing (channel, DM, thread, canvas, list),
and once subscribed, `app_context` is also attached to `message.im` and `app_home_opened`.

Scopes: enabling the Agents feature auto-adds **`assistant:write`**, which grants the ability to
"act as an AI Assistant app" and is required by `assistant.threads.setStatus`,
`assistant.threads.setSuggestedPrompts` and `assistant.threads.setTitle`
([assistant:write](https://docs.slack.dev/reference/scopes/assistant.write/);
[Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps/)). Plus `chat:write`, and the
history scopes for whichever conversations you read.

Manifest: set `features.agent_view` with a required `agent_description` (max 300 chars) and optional
`actions` / `suggested_prompts`
([App manifest reference](https://docs.slack.dev/reference/app-manifest/)).

One constraint worth knowing: **workspace guests cannot access agent-enabled apps**
([Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps/)).

### 1.3 Slash commands

- Hard 3-second budget with a user-visible failure: "This confirmation *must be* received by Slack
  within 3000 milliseconds of the original request being sent, otherwise an `operation_timeout`
  error will be displayed to the user."
  ([Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/))
- Two immediate response visibilities: ephemeral (default) or `in_channel`. For later work you use
  the `response_url`. (same page)
- **Disqualifying for this project:** "Built-in slash commands and Giphy commands are the only slash
  commands callable in message threads" — developer-created slash commands **cannot be invoked in
  threads**. (same page)
- **Gap:** the current docs page I fetched does not state the `response_url` validity window or
  usage count (the commonly-repeated "30 minutes / 5 uses" figures). I could not confirm those from
  a primary source and am not asserting them.

### 1.4 Verdict: which primitive

**`app_mention` is the right primitive for "mention me in any channel and I'll go work."**

Reasoning, all from the above:

- It is the *only* one of the three that fires on an @-mention in an arbitrary channel **and inside
  a thread**. Slash commands are explicitly barred from threads; the Agent surface is DM/Messages-tab
  only.
- Nothing about `app_mention` prevents also using the agent affordances — as of March 2026
  `assistant.threads.setStatus` works in channels with plain `chat:write`
  ([see §3.3](#33-status-the-is-thinking-affordance)), and Bolt's own AI-apps guide lists
  `app_mention` as one of the three ways an agent gets invoked
  ([Bolt JS: AI apps](https://docs.slack.dev/tools/bolt-js/concepts/ai-apps/)).

Minimum bot scopes for the mention-driven design:

```
app_mentions.read     # receive the mention
chat:write            # post and edit in the thread
chat:write.public     # post in public channels the bot hasn't joined (optional but likely wanted)
channels:history      # read the thread in public channels (add groups:/im:/mpim: as needed)
reactions:write       # optional: eyes-emoji as the instant "I heard you"
```

`assistant:write` is **not** required if you only use `setStatus` — see §3.3. Adding `agent_view` to
the manifest is optional and orthogonal; it buys you a DM entry point, not a channel one.

---

## 2. The acknowledgement window

### 2.1 The requirement

> "Your app should respond to the event request with an HTTP 2xx *within three seconds*."
> — [Events API](https://docs.slack.dev/apis/events-api/)

### 2.2 What happens on a miss

Slack retries **three times**, on an expanding schedule
([Events API](https://docs.slack.dev/apis/events-api/)):

1. "The first retry will be sent nearly immediately."
2. "The second retry will be attempted after 1 minute."
3. "The third and final retry will be sent after 5 minutes."

Retries carry `x-slack-retry-num` (1, 2 or 3) and `x-slack-retry-reason` (`http_timeout`,
`too_many_redirects`, `connection_failed`, `ssl_error`, `http_error`, `unknown_error`). (same page)

Sustained failure disables you:

> "When your application enters any combination of these failure conditions for more than *95% of
> delivery attempts* within 60 minutes, your application's event subscriptions will be temporarily
> disabled." Slack also emails the app's creator/owner.
> — [Events API](https://docs.slack.dev/apis/events-api/)

Apps receiving fewer than 1,000 events per hour are exempt from automatic disabling (same page) — so
a single-workspace self-hosted coworker is realistically never going to be auto-disabled, but it
*will* get duplicate deliveries.

**Duplicate work is the real hazard, not disabling.** A retry after a slow ack means your handler
runs again on the same mention. Slack provides `event_id` — "A unique identifier for this specific
event, globally unique across all workspaces" — plus `event_time`
([Events API](https://docs.slack.dev/apis/events-api/)), which is the natural idempotency key.

**Gap:** Slack's docs describe retries but I did not find an explicit primary-source statement of
at-least-once semantics *absent* an ack failure. Treat delivery as at-least-once anyway; the retry
mechanism alone makes deduplication necessary.

### 2.3 Sanctioned pattern for long work

Slack states it plainly:

> "Respond to events with an HTTP 200 OK as soon as you can" … "Avoid actually processing and
> reacting to events within the same process. Implement a queue to handle inbound events after they
> are received."
> — [Events API](https://docs.slack.dev/apis/events-api/)

That is the whole of Slack's guidance. **There is no Slack-side job, callback, or continuation
primitive for work that takes minutes or hours.** The event delivery is fire-and-forget; everything
after the 200 is your problem, and the *only* channel back to the user is the Web API
(`chat.postMessage` / `chat.update` / the streaming methods), authenticated with a bot token you
already hold. There is no expiring `response_url` in the `app_mention` path — which is actually an
advantage over slash commands.

Slack's own AI guidance corroborates the "show something immediately" half:

> "Show a status indicator immediately after the user sends a message. This can range from a
> lightweight emoji reaction to a 'Working on it...' status."
> — [Agent design](https://docs.slack.dev/concepts/agent-design/)

---

## 3. Progress in a thread

### 3.1 Posting and editing

`chat.postMessage`
([reference](https://docs.slack.dev/reference/methods/chat.postMessage/)):

- Scope `chat:write` (bot or user token).
- Rate limit: **Special tier**. "Special rate limits apply" — the method "will generally allow an app
  to post 1 message per second to a specific channel", with "limits governing your app's relationship
  with the entire workspace" allowing "several hundred messages per minute" plus "generous burst
  behavior."
- `thread_ts`: "Provide another message's `ts` value to make this message a reply."
- `reply_broadcast`: makes a thread reply visible in the channel; defaults to `false`.

`chat.update`
([reference](https://docs.slack.dev/reference/methods/chat.update/)):

- Scope `chat:write`.
- Rate limit: **"Tier 3: 50+ per minute"**.
- "Only messages posted by the authenticated user are able to be updated using this method."
- Cannot update `chat.postEphemeral` messages.
- Passing `text` without `blocks` **removes** the previous blocks; omitting `attachments` retains
  them (pass `[]` to clear). This is a live footgun for an in-place status message.
- "If `blocks` are used and a message is being updated, the `edited` flag will not be displayed" —
  i.e. block-based status messages update silently, without an "(edited)" marker.
- "Can't broadcast an old reply and update the content at the same time."

Tier table, for reference
([Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)):

| Tier | Limit |
|---|---|
| Tier 1 | 1+ per minute |
| Tier 2 | 20+ per minute |
| Tier 3 | 50+ per minute |
| Tier 4 | 100+ per minute |
| Special | "Rate limiting conditions are unique for methods with this tier" |

Limits are applied "per API method per workspace/team per app". Over-limit returns
`HTTP 429 Too Many Requests` with a `Retry-After` header giving "the number of seconds until you can
retry." (same page)

Also on that page: Events API deliveries "max out at 30,000 per workspace/team per app per 60
minutes", after which Slack sends an `app_rate_limited` event carrying `minute_rate_limited`
([Rate limits](https://docs.slack.dev/apis/web-api/rate-limits/);
[Events API](https://docs.slack.dev/apis/events-api/)).

**The 2025 non-Marketplace clampdown, and why it probably does not apply here.** As of 2025-05-29,
`conversations.history` and `conversations.replies` are limited to **1 request per minute** with
`limit` capped at **15 objects** for new apps and installations "commercially distributed outside of
the Marketplace"
([conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/);
[Rate limit changes for non-Marketplace apps, 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
Slack's follow-up clarification says: **"Any internal customer-built apps will maintain their
existing rate limits and will not be subject to the new posted limits."**
([Clarifying rate limit changes, 2025-06-03](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)).
A self-hoster who creates their own app in their own workspace and never enables public distribution
is an internal custom-built app and should keep Tier 3 on thread reads. This is a real constraint on
the *distribution* choice, not the code: if the project ever ships a single distributed Slack app
that others install, thread reads drop to 1/min and 15 messages.

**Gap:** "internal customer-built app" is not formally defined in the changelog beyond that sentence.
I could not find a definition tying it precisely to "not enabling distribution" in the app config.
Reasonable but unverified inference.

### 3.2 Update-in-place vs append

Slack does not issue a blanket rule, but its agent-design guidance leans toward **updating a status
in place while working, and posting a message when done**
([Agent design](https://docs.slack.dev/concepts/agent-design/)):

- "Show a status indicator immediately after the user sends a message."
- "Update the status as the agent progresses. 'Searching your workspace...' → 'Found 3 matching
  issues...' → 'Formatting results...'"
- Multi-step work should use **plan blocks**: "Multi-step tasks use plan blocks to show a list of
  steps where the agent is making decisions, not just fetching data", keeping "each step to one
  short phrase" — e.g. "Reading thread context", "Identifying action items".
- Against chattiness: "organize related notifications into batches. Five issue updates should be one
  message, not five."
- Thread hygiene: responses "should be made in threads. This prevents flooding the main
  conversation."
- Channel awareness: "In channels, be audience-aware. The agent may have context from a DM or
  another channel that isn't appropriate to surface publicly."

The rate limits agree with this reading: `chat.update` at Tier 3 (50+/min) is far more headroom than
`chat.postMessage`'s ~1/sec/channel, and updating one message avoids `reply_broadcast`-style noise.

### 3.3 Status — the "is thinking…" affordance

`assistant.threads.setStatus`
([reference](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)):

- Args: `channel_id`, `thread_ts`, `status` (e.g. `'is thinking...'`), optional `loading_messages`
  ("The list of messages to rotate through as a loading indicator. Maximum of 10 messages"), plus
  `icon_emoji` / `icon_url` / `username`.
- **A two-minute timeout applies**: "A two minute timeout applies, which will cause the status to be
  removed if no message has been sent."
- Cleared automatically when the app sends a reply, or by sending an empty `status` string.
- Rate limit: **Special** — "The default limit is 600 requests per minute (per app per team)."
- Under `agent_view`, "calling the `assistant.threads.setStatus` API method on that thread will
  automatically open the thread for the user."

**Critically for a channel-mention agent**, the scope requirement changed on 2026-03-05:

> The method now accepts `assistant:write` **or** `chat:write`. "This allows channel-based apps to
> use AI loading states in channels, without having to request `assistant:write` or use the AI
> assistant split view." Developers should migrate soon, as the method "will eventually support only
> the `chat:write` scope."
> — [Set status method scope update, 2026-03-05](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)

So an `app_mention`-driven bot in a channel can show a native Slack loading indicator with nothing
beyond `chat:write`. The two-minute expiry means a long job must **re-call `setStatus` at least every
~2 minutes** to keep the indicator alive — a natural heartbeat for the job model.

### 3.4 Streaming and thinking-step blocks

Since 2025-10-07 Slack has three streaming methods
([New features for Slack apps sending AI responses](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)):

| Method | Scope | Rate limit |
|---|---|---|
| [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/) | `chat:write` | Tier 2: 20+ per minute |
| [`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream/) | `chat:write` | Tier 4: 100+ per minute |
| [`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/) | `chat:write` | Tier 2: 20+ per minute |

`chat.startStream` takes `channel` and `thread_ts`, and **when streaming to channels you must also
provide `recipient_user_id` and `recipient_team_id`** ("Required when streaming to channels")
([chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream/)). "Streamed messages
should always be replies to a user request." `chat.appendStream` takes `markdown_text` — "Limit this
field to 12,000 characters" — or a `chunks` array; task/plan update chunks are capped at 256
characters and blocks at 50 per message
([chat.appendStream](https://docs.slack.dev/reference/methods/chat.appendStream/)).

The same shipment added Block Kit `feedback_buttons`, `icon_button` and `context_actions`, and both
the Node and Python SDKs got a `streamer` helper utility
([changelog](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)).

On 2026-02-11 Slack shipped **task cards and plan blocks** — "Apps can now display thinking steps to
users!" — a `task_card` block ("displays a single task"), a URL source element, and a `plan` block
("displays multiple of those tasks together in a unified view"), driven through the same streaming
methods via the `chunks` parameter and a `task_display_mode` setting
([Apps can now display thinking steps, 2026-02-11](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/)).

This is the closest thing Slack offers to a purpose-built long-job progress surface.

**Gap:** I could not find any documented maximum lifetime for an open stream —
`chat.stopStream`'s reference does not state whether a stream auto-expires. For an hours-long job,
whether you can hold one stream open the whole time is **unverified**. Assume you cannot and design
around `chat.update` + `setStatus` heartbeats, treating streaming as the final-answer rendering.

**Gap:** I found no primary-source statement of `chat.postMessage` text-length limits (the
oft-cited 4,000 / 40,000 character figures). The only hard character limit I could confirm is the
12,000-char `markdown_text` cap on `chat.appendStream`.

---

## 4. Socket Mode vs Events API

### 4.1 What Socket Mode is

Socket Mode delivers events and interactive payloads over a WebSocket instead of a public HTTPS
endpoint, so apps behind corporate firewalls can run without exposing a static HTTP endpoint. The
WebSocket URL is obtained at runtime by calling `apps.connections.open` with an app-level token
(`xapp-`), and "the URL is created at runtime … and it refreshes regularly."
([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/))

`apps.connections.open` requires an app-level token, "No scopes required" on the method itself, and
is **Tier 3: 50+ per minute**
([apps.connections.open](https://docs.slack.dev/reference/methods/apps.connections.open/)). The
app-level token itself must carry **`connections:write`**
([connections:write](https://docs.slack.dev/reference/scopes/connections.write/)).

Enabling it: "Navigate to the **Socket Mode** section. Toggle the **Enable Socket Mode** button to
turn on receiving payloads via WebSockets." Once on, "you'll only receive events and interactive
payloads over your WebSocket connections — not over HTTP."
([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/))

### 4.2 Connections and reconnection

- "Socket Mode allows your app to maintain *up to 10* open WebSocket connections at the same time."
  With several open, payloads route to any of them with no predictable pattern.
- Expect regular disconnects. Slack sends a `type: "disconnect"` message with a `reason`: "You may
  receive a warning about 10 seconds before the disconnect"; you'll also see `refresh_requested`
  messages even without a warning; and toggling Socket Mode off yields `reason: "link_disabled"`.
- "Be ready to receive and connect to new WebSocket URLs as quickly as possible to maintain service."
- Acknowledgement is by `envelope_id`: "Use the `envelope_id` field in the object you receive from
  your WebSocket to send a response back to Slack acknowledging that you've received the event."
  There is "no need to verify or validate inbound events" — no signing-secret check, since the
  socket is pre-authenticated.

All from [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

**Gap:** the Socket Mode docs do **not** state an ack timeout or a retry schedule for
unacknowledged envelopes, and I could not find one. The HTTP three-second / three-retry rules are
documented for the Events API request-URL path only. Whether the same timings apply over Socket Mode
is **unverified**. Do not rely on Socket Mode having a laxer ack budget.

Client-side defaults, from the reference implementation
([`node-slack-sdk` `SocketModeClient.ts`](https://github.com/slackapi/node-slack-sdk/blob/main/packages/socket-mode/src/SocketModeClient.ts)):
`autoReconnectEnabled = true`, `clientPingTimeout = 5000` ms, `serverPingTimeout = 30000` ms, and the
underlying WebClient defaults to `retryConfig = { retries: 100, factor: 1.3 }`. Reconnect backoff is
`clientPingTimeoutMS * numOfConsecutiveReconnectionFailures`.

### 4.3 Slack's own guidance

Slack is unambiguous, and it does **not** favour Socket Mode for production
([Exploring HTTP vs Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)):

> "We recommend using Socket Mode when developing your app and using it locally. Once deployed and
> published for use in a team setting, we recommend using HTTP request URLs."

> "To have the highest possible reliability for application connectivity, we recommend using HTTP
> for production applications."

Its stated drawbacks:

- "WebSocket is stateful, making it more difficult to scale."
- Long-lived connections "could be subject to a network partition or other transient events causing
  disconnects."
- "The socket server backend recycles containers serving connections every now and then, leading to
  occasional reliability issues."
- "Slack limits the number of concurrent WebSocket connections to 10 per app."
- "Apps using Socket Mode are not currently allowed in the public Slack Marketplace."
  ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/))
- Socket Mode only works with granular permissions (post-December 2019 apps). (same page)

Its stated advantages: convenience, ease of setup, working behind a firewall, and serving
organizations whose security policy forbids exposing an HTTP endpoint
([Exploring HTTP vs Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)).

### 4.4 Reading for this project

Slack's "use HTTP in production" advice is written for multi-tenant vendors: the concerns it cites
are scaling, Marketplace listing, and horizontal deployment — none of which apply to a
single-workspace, single-process self-hosted coworker. The genuinely applicable caveats are
connection recycling and transient disconnects, both of which are handled by the SDK's
`autoReconnectEnabled` default.

The decisive asymmetry for this project is elsewhere: Socket Mode requires **no public HTTPS
endpoint, no domain, no TLS certificate, and no URL verification handshake**, which removes the
single largest obstacle in a self-hoster's setup story. The cost is one extra manual step (generating
an `xapp-` app-level token) and a delivery path Slack calls less reliable.

**Note the interaction with §2**: because a long job is queued and the ack is immediate either way,
the ack path is not what distinguishes them. The distinguishing risk is that a dropped socket during
a multi-hour job means *missed inbound events* (a follow-up "stop" or a new mention), not lost job
state. That risk is bounded by auto-reconnect.

---

## 5. Bolt for TypeScript

Current: `@slack/bolt` **v5.0.0** (npm dist-tags at time of writing; v4.7.3 is the prior line).

### 5.1 What it handles for you

- **Automatic ack for Events API requests.** This is the single most important fact for a
  long-running handler. In `App.processEvent`, Bolt acks events *before* running your listener:

  ```ts
  // Set ack() utility
  if (type !== IncomingEventType.Event) {
    listenerArgs.ack = ack;
  } else {
    // ... function_executed is the exception
    // Events API requests are acknowledged right away, since there's no data expected
    await ack();
  }
  ```
  — [`bolt-js/src/App.ts`](https://github.com/slackapi/bolt-js/blob/main/src/App.ts)

  So an `app_mention` listener does not receive an `ack` argument and does not need one; with the
  default `processBeforeResponse: false`, the HTTP 200 is written before your listener body executes.
  Consistent with the docs: "Actions, commands, and options requests must **always** be acknowledged
  using the `ack()` function"
  ([Acknowledging requests](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/)) — events are
  conspicuously absent from that list.

- **Routing** by event type / pattern, **middleware** chains (global and listener-level), a global
  error handler (`extendedErrorHandler: true` passes extra request context), and receivers:
  `HTTPReceiver`, `SocketModeReceiver`, `AwsLambdaReceiver`
  ([Bolt JS reference](https://docs.slack.dev/tools/bolt-js/reference/)).

- **Signature verification** on the HTTP path; not needed on the Socket Mode path.

- **Socket Mode** as a one-liner: `socketMode: true` + `appToken`, requires `@slack/bolt@3.0.0`+
  ([Bolt JS: Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)).

- **Agent affordances on ordinary events.** Bolt v5 injects `setStatus()` and `sayStream()` into any
  event listener that has a channel and a resolvable thread — which includes `app_mention`:

  ```ts
  const resolvedThreadTs = threadTs ?? eventTs;
  if (resolvedThreadTs !== undefined) {
    listenerArgs.sayStream = createSayStream(client, context, eventChannelId, resolvedThreadTs);
    listenerArgs.setStatus = createSetStatus(client, eventChannelId, resolvedThreadTs);
  }
  ```
  — [`bolt-js/src/App.ts`](https://github.com/slackapi/bolt-js/blob/main/src/App.ts)

  `createSetStatus` wraps `client.assistant.threads.setStatus`; `createSayStream` wraps
  `client.chatStream` and auto-fills `recipient_team_id` / `recipient_user_id`
  ([`src/context/create-set-status.ts`](https://github.com/slackapi/bolt-js/blob/main/src/context/create-set-status.ts),
  [`src/context/create-say-stream.ts`](https://github.com/slackapi/bolt-js/blob/main/src/context/create-say-stream.ts)).
  Bolt's AI-apps guide confirms `app_mention` as one of the three agent invocation paths, alongside
  `message` and `app_home_opened`, and documents an `Assistant` class for the split-view surface
  ([Bolt JS: AI apps](https://docs.slack.dev/tools/bolt-js/concepts/ai-apps/)).

- **WebClient retries.** The underlying `@slack/web-api` client handles 429s with `Retry-After`.

### 5.2 What it leaves entirely to you

- **The job.** Bolt has no queue, no durable job store, no resumption, no cancellation. Once the ack
  is sent, an in-flight listener is just a floating promise in your Node process. Process restart
  loses it. Slack's own guidance ("implement a queue") is the boundary — Bolt does not cross it.
- **Deduplication.** Bolt does not dedupe by `event_id`. On a retry, your listener runs again.
- **Lazy listeners do not exist in Bolt JS.** The `lazy` listener pattern
  ([Bolt Python: Lazy listeners](https://docs.slack.dev/tools/bolt-python/concepts/lazy-listeners/))
  is Python-only, and the maintainers have said they are not planning to add it to the other Bolt
  frameworks ([bolt-js discussion threads](https://github.com/slackapi/bolt-js)). In JS you build
  the ack/work split yourself.
- **Keeping the status alive.** Nothing re-calls `setStatus` before the 2-minute expiry for you.

### 5.3 What actively fights a long-running handler

1. **`processBeforeResponse: true`** — "boolean that determines whether events should be immediately
   acknowledged … When set to `true` it will defer sending the acknowledgement until after your
   handlers run to prevent early termination." Default `false`
   ([Bolt JS reference](https://docs.slack.dev/tools/bolt-js/reference/)). It exists for FaaS, where
   the runtime freezes after the response. **If you set it — or use `AwsLambdaReceiver` — a
   long-running handler will blow the 3-second budget and Slack will retry three times, running your
   agent up to four times on one mention.** For a self-hosted long-job coworker, keep it `false` and
   do not deploy to Lambda.

2. **The no-ack watchdog.** `HTTPResponseAck` arms a timer at construction:

   ```ts
   this.unhandledRequestTimeoutMillis = args.unhandledRequestTimeoutMillis ?? 3001;
   this.noAckTimeoutId = setTimeout(() => {
     if (!this.isAcknowledged) { this.unhandledRequestHandler({ ... }); }
   }, requestTimeout);
   ```
   and the default handler logs an error and **closes the connection with a 404**:

   ```ts
   logger.error('An incoming event was not acknowledged within 3 seconds. ' +
     'Ensure that the ack() argument is called in a listener.');
   if (!response.headersSent) { response.writeHead(404); response.end(); }
   ```
   — [`HTTPResponseAck.ts`](https://github.com/slackapi/bolt-js/blob/main/src/receivers/HTTPResponseAck.ts),
   [`HTTPModuleFunctions.ts`](https://github.com/slackapi/bolt-js/blob/main/src/receivers/HTTPModuleFunctions.ts)

   Harmless for `app_mention` (auto-acked), but it will bite any interactive component — a
   "Cancel job" button, a confirmation action — whose handler does real work before `ack()`.
   `function_executed` events get a longer 5001 ms budget
   ([`HTTPResponseAck.ts`](https://github.com/slackapi/bolt-js/blob/main/src/receivers/HTTPResponseAck.ts)).
   `SocketModeReceiver` has no equivalent no-ack watchdog
   ([`SocketModeReceiver.ts`](https://github.com/slackapi/bolt-js/blob/main/src/receivers/SocketModeReceiver.ts)).

3. **Awaiting the listener.** Bolt `await`s your listener inside its middleware chain. A listener that
   runs for an hour holds a live async frame; unhandled rejections inside it route to the global error
   handler rather than crashing, but nothing about that frame is durable. Doing real work inside the
   listener is the anti-pattern regardless of ack behaviour.

---

## 6. Setup story

### 6.1 What a manifest can do

An app manifest is "a configuration file that defines your Slack app's settings and capabilities",
authored in YAML, JSON, or TypeScript
([App manifest reference](https://docs.slack.dev/reference/app-manifest/)). It covers
`oauth_config.scopes.bot` (max 255 scopes), `settings.event_subscriptions` (`request_url`,
`bot_events` — max 100), `settings.socket_mode_enabled`, `settings.interactivity`,
`features.bot_user` (`display_name`, `always_online`), `features.agent_view` /
`features.assistant_view`, slash commands, App Home, shortcuts, unfurl domains, incoming webhooks and
token rotation. (same page)

Creation paths:

- **UI:** at [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → "from a manifest"
  → pick workspace → paste YAML/JSON → review → Create
  ([Configuring apps with app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/);
  [Quickstart](https://docs.slack.dev/quickstart/)).
- **Shareable prefilled URL:** `https://api.slack.com/apps?new_app=1&manifest_yaml=<manifest_here>`
  or `...&manifest_json=<manifest_here>` — "Ensure you URL encoded the YAML or JSON before sharing
  the URL." This "will direct users right into the app creation flow."
  ([Configuring apps with app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/))
  **This is the single best lever for the setup story: ship one link in the README.**
- **API:** [`apps.manifest.create`](https://docs.slack.dev/reference/methods/apps.manifest.create/)
  requires "An app configuration access token", "No scopes required", **Tier 1: 1+ per minute**, and
  returns `app_id`, a `credentials` object (`client_id`, `client_secret`, `verification_token`,
  `signing_secret`) and an `oauth_authorize_url`. Requires the self-hoster to first mint a
  configuration token by hand, so it does not remove manual steps for a one-off install.
- **Export** an existing app's manifest at **Features → App Manifest** in the app config.
  ([App manifests](https://docs.slack.dev/app-manifests/))

### 6.2 The by-hand steps (Socket Mode variant)

From [Quickstart](https://docs.slack.dev/quickstart/):

1. Go to `https://api.slack.com/apps/new`, choose **from a manifest**, select the workspace, paste
   the manifest, review, **Create**.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**; name it; add the
   **`connections:write`** scope; **Generate**; copy the `xapp-…` token → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions → Install to workspace**; approve the consent screen; copy the **Bot User
   OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. (HTTP variant only) Copy the **Signing Secret** from Basic Information, expose a public HTTPS
   endpoint, paste the request URL into Event Subscriptions and pass Slack's `url_verification`
   challenge ([Events API](https://docs.slack.dev/apis/events-api/);
   [App manifest reference](https://docs.slack.dev/reference/app-manifest/) — `request_url` "requires
   manual verification").
5. Invite the bot to the channels you want it in (`/invite @yourbot`), or grant `chat:write.public`.

**What the manifest cannot automate** — each of these is an irreducible manual step:

- **Generating the app-level `xapp-` token.** Not a manifest field; the manifest can only set
  `socket_mode_enabled: true`. Confirmed by the token being generated in the UI in the Quickstart
  flow and absent from the manifest field reference.
- **Installing the app / obtaining the `xoxb-` token.** Requires a human with workspace install
  permission clicking through OAuth.
- **Inviting the bot to channels.**
- **Verifying an HTTP request URL** (HTTP variant).

**Gap:** the manifest docs do not contain an explicit "these things the manifest cannot do" list. The
four above are inferred from their absence in the manifest field reference combined with their
presence as manual steps in the Quickstart. I am confident but it is an inference, not a quotation.

### 6.3 A manifest for this design

Assembled from the field reference; **not copied from a Slack example, so validate it against the
[manifest reference](https://docs.slack.dev/reference/app-manifest/) before shipping.**

```yaml
display_information:
  name: Coworker
features:
  bot_user:
    display_name: coworker
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions.read
      - chat:write
      - chat:write.public
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

Note `settings.interactivity.request_url` and `settings.event_subscriptions.request_url` are omitted
because Socket Mode supplies the transport.

---

## 7. Consolidated gaps

Things I could **not** establish from a primary source, listed so they are not mistaken for facts:

1. **Socket Mode ack timeout and retry schedule.** Undocumented. Do not assume the HTTP 3s/3-retry
   rules do or do not apply.
2. **Whether an open `chat.startStream` stream expires.** No documented maximum lifetime.
3. **`response_url` validity window and use count for slash commands.** Not on the current docs page.
   (Moot — slash commands are ruled out anyway.)
4. **Formal definition of "internal customer-built app"** for the non-Marketplace rate-limit
   exemption.
5. **`chat.postMessage` text-length limits.** Only the 12,000-char `chat.appendStream` `markdown_text`
   limit is confirmed.
6. **Explicit at-least-once delivery statement** for the Events API absent an ack failure.
7. **Whether `task_card` / `plan` blocks work outside streaming**, and whether they render in channels
   as well as DMs. The changelog does not say.

---

## 8. Implications for the design

**The job model is entirely ours to build; Slack contributes nothing but a mention and a bot token.**
Slack's only guidance for long work is "ack in 3 seconds and implement a queue"
([Events API](https://docs.slack.dev/apis/events-api/)). There is no platform continuation, no
callback, no expiring token to race. Once the 200 is out, the bot token in `.env` is a stable handle
that lets us write into that thread for as long as we like. The ticket's worry — "delegate-and-walk-
away is at odds with how chat platforms usually work" — turns out to be false for the *outbound*
direction and true only for the *inbound* one. The 3-second window governs the doorbell, not the job.

**Bolt already wins the ack race for us, and that shapes the seam.** Bolt auto-acks Events API
requests before the listener runs
([`App.ts`](https://github.com/slackapi/bolt-js/blob/main/src/App.ts)), so the naive "just await the
agent inside the `app_mention` handler" would technically not trigger Slack retries. That makes it
tempting and wrong: the handler is a floating promise with no durability. The right shape is the one
Slack names — the listener validates, enqueues a job keyed by `event_id`, and returns. Two hard
configuration rules fall out: **`processBeforeResponse` must stay `false`**, and **FaaS deployment
(`AwsLambdaReceiver`, Lambda, Vercel functions) is off the table** — either would convert every
long job into four duplicate runs. That constrains the *deployment shape* fog entry: this is a
long-lived process (bare Node or a container), not a serverless function.

**Deduplicate on `event_id`, and make it the job's identity.** Retries are guaranteed on any delivery
hiccup, and Slack gives `event_id` as a globally unique key
([Events API](https://docs.slack.dev/apis/events-api/)). Using it as the job's primary key makes
enqueueing idempotent for free and gives the persistence decision a natural first column.

**Progress has a native affordance and a 2-minute clock.** `assistant.threads.setStatus` works in
channels with only `chat:write` as of March 2026
([changelog](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)), so a
channel-mention coworker gets Slack's real loading indicator without adopting the DM agent surface.
But "a two minute timeout applies"
([setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)) means the job
model needs a **heartbeat under two minutes** for the whole life of the job. That is a genuine
architectural requirement, not a nicety — and conveniently it doubles as a liveness signal: if the
status lapses, the job died.

**The reporting shape: one status message, updated; one result message, posted.** The rate limits
point the same way as Slack's design guidance — `chat.update` at Tier 3 (50+/min) versus
`chat.postMessage` at ~1/sec/channel, and Slack's own "five issue updates should be one message, not
five" ([Agent design](https://docs.slack.dev/concepts/agent-design/)). Combined with `plan` /
`task_card` blocks ([changelog](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/)),
the natural v1 is: react instantly, set a status, edit a single plan-block message in place as steps
complete, then post the final answer as a new threaded message. Watch the `chat.update` footgun —
passing `text` without `blocks` silently wipes the blocks
([chat.update](https://docs.slack.dev/reference/methods/chat.update/)).

**Socket Mode is the right call for v1 despite Slack advising against it in production.** Slack's
warning is aimed at scale, Marketplace listing, and horizontal deployment
([HTTP vs Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)) — none of
which describe one person running one process against one workspace. What Socket Mode removes is
exactly the worst part of the setup story: a public HTTPS endpoint, a domain, a certificate, and a
URL-verification handshake. The residual risk (dropped sockets) costs *inbound* events during a job,
not the job itself, and `autoReconnectEnabled` defaults to true. Worth designing the receiver as a
swappable seam so an HTTP receiver is a config flag, not a rewrite — Bolt makes that nearly free.

**Do not distribute a single shared Slack app.** Enabling public distribution outside the Marketplace
would drop `conversations.history` / `conversations.replies` to 1 request per minute with a 15-message
cap ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)),
which would cripple thread-context reading. Internal customer-built apps are explicitly exempt
([clarification](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/)). This reinforces
the settled "each user self-hosts against their own app" decision with a hard technical reason — and
it means the setup story *must* be "create your own app", not "install ours".

**The setup story compresses to one link plus two copy-pastes.** A URL-encoded manifest at
`https://api.slack.com/apps?new_app=1&manifest_yaml=…`
([manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)) collapses
scopes, events, bot user and Socket Mode into a single click. What remains irreducibly manual:
generate the `xapp-` app-level token with `connections:write`, install and copy the `xoxb-` token,
and `/invite` the bot. That is three UI steps and two secrets in `.env` — a realistic README, and a
concrete answer to the *configuration schema and setup story* fog entry.

**The agent DM surface is a v2 question, not a v1 one.** `agent_view` is a genuinely different entry
point (Messages tab, `app_home_opened`, `app_context_changed`) and adds `assistant:write` plus a
manifest section ([changelog](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/);
[Developing AI apps](https://docs.slack.dev/ai/developing-ai-apps/)). It buys a nicer 1:1 experience
and nothing at all for "mention me in any channel". Because `setStatus` and `sayStream` now work on
plain `app_mention` events in Bolt v5, adopting it later is additive, not a rewrite. Defer it.
