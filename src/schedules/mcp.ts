import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import type { McpHttpServerConfig } from "../ports/mcp.ts";
import type { Logger } from "../ports/log.ts";
import { timingRuleSchema } from "./types.ts";
import { scheduleSummary, type ScheduleControl } from "./control.ts";

export const SCHEDULE_MCP_TOKEN_ENV = "OPEN_AGENT_SCHEDULE_MCP_TOKEN";

export interface ScheduleMcpServer {
  config: McpHttpServerConfig;
  close(): Promise<void>;
}

export async function startScheduleMcpServer(deps: {
  control: ScheduleControl;
  env: NodeJS.ProcessEnv;
  log: Logger;
}): Promise<ScheduleMcpServer> {
  const token = randomBytes(32).toString("base64url");
  deps.env[SCHEDULE_MCP_TOKEN_ENV] = token;

  const handler = createMcpHandler(() => tools(deps.control), { legacy: "stateless" });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("Unauthorized");
      return;
    }
    void nodeHandler(request as Parameters<typeof nodeHandler>[0], response).catch((error) => {
      deps.log.warn(`Schedule MCP request failed: ${String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Schedule MCP server has no TCP address");
  return {
    config: {
      name: "schedules",
      enabled: true,
      transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`,
      bearerTokenEnvVar: SCHEDULE_MCP_TOKEN_ENV,
      httpHeaders: {},
      envHttpHeaders: {},
      disabledTools: [],
      // This loopback server is owned by open-agent and exposes only the reversible
      // Schedule control surface. Slack Jobs cannot answer interactive MCP approvals.
      defaultToolsApprovalMode: "approve",
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function tools(control: ScheduleControl): McpServer {
  const server = new McpServer({ name: "open-agent-schedules", version: "1.0.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
  server.registerTool("create_schedule", {
    description: "Create a time-based Schedule only when the user explicitly named its destination channel. Preserve Slack picker references such as <#C123|engineering> as the channel value. The conversation's Channel metadata is context, not a destination choice. If the user's message omitted a destination, ask where to post and do not call this tool. Omit timezone to use their Slack profile timezone.",
    inputSchema: z.object({ actorUserId: z.string(), task: z.string().min(1), channel: z.string().min(1), timezone: z.string().optional(), rule: timingRuleSchema }),
  }, async (input) => result(scheduleSummary(await control.create({
    actorUserId: input.actorUserId,
    task: input.task,
    channel: input.channel,
    rule: input.rule,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
  }))));
  server.registerTool("list_schedules", { description: "List every active or paused Schedule." }, async () => result((await control.list()).map(scheduleSummary).join("\n\n") || "No Schedules."));
  server.registerTool("get_schedule", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => result(scheduleSummary(await control.get(id))));
  server.registerTool("update_schedule", {
    inputSchema: z.object({ id: z.string(), actorUserId: z.string(), task: z.string().optional(), channel: z.string().optional(), timezone: z.string().optional(), rule: timingRuleSchema.optional() }),
  }, async (input) => result(scheduleSummary(await control.update({
    id: input.id,
    actorUserId: input.actorUserId,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.rule === undefined ? {} : { rule: input.rule }),
  }))));
  server.registerTool("pause_schedule", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => result(scheduleSummary(await control.pause(id))));
  server.registerTool("resume_schedule", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => result(scheduleSummary(await control.resume(id))));
  server.registerTool("delete_schedule", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => {
    await control.delete(id);
    return result(`${id} deleted. Existing Slack history was retained.`);
  });
  server.registerTool("run_schedule_now", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => {
    const ran = await control.runNow(id);
    return result(ran.overlap ? `${id} was skipped because it is already running.` : `${id} is running now; its calendar time is unchanged.`);
  });
  return server;
}
