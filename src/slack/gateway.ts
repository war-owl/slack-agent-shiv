import { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { Logger } from "../coworker.ts";
import type { PostMessage, PostedMessage, SlackClient } from "../ports/slack.ts";
import type { MentionGateway } from "./mentions.ts";

/**
 * Bolt, Socket Mode, and the `app_mention` subscription.
 *
 * Socket Mode is deliberate despite Slack's production guidance: a self-hoster has
 * no public HTTPS endpoint, and the long-Job design means the three-second ack race
 * is already won either way.
 */
export function createSlackApp(config: Config): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,

    // MUST stay false (it is also the default).
    //
    // Setting `processBeforeResponse: true` makes Bolt ack *after* the listener
    // returns, and a listener that takes longer than three seconds gets the event
    // redelivered — measured at **four duplicate runs** for one mention. It is also
    // the reason a FaaS deployment is not viable for this project: there, acking
    // after the handler is the only option.
    processBeforeResponse: false,
  });
}

/** The narrow Slack surface the coworker actually uses, backed by Bolt's client. */
export function slackClientFor(app: App): SlackClient {
  return {
    async postMessage(message: PostMessage): Promise<PostedMessage> {
      const result = await app.client.chat.postMessage({
        channel: message.thread.channel,
        thread_ts: message.thread.ts,
        text: message.text,
      });
      if (!result.ts) {
        throw new Error("Slack accepted the message but returned no ts");
      }
      return { ts: result.ts };
    },
  };
}

export function subscribeToMentions(app: App, mentions: MentionGateway, log: Logger): void {
  app.event("app_mention", async ({ event, body }) => {
    // Bolt has already ack'd the socket event by the time this runs.
    const delivery = await mentions.deliver(event, body);
    if (delivery.accepted) {
      // Deliberately not awaited: a Job runs for minutes or hours, and this
      // listener must return so the next event can be delivered.
      delivery.completed.catch((error: unknown) => {
        log.warn(`Job ${delivery.jobId} failed outside its own error handling: ${String(error)}`);
      });
    }
  });
}
