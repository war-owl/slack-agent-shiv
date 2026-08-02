import { afterEach, describe, expect, it } from "vitest";
import { createMcpInventoryProber } from "../src/mcp/prober.ts";
import { createScheduleControl } from "../src/schedules/control.ts";
import { SCHEDULE_MCP_TOKEN_ENV, startScheduleMcpServer, type ScheduleMcpServer } from "../src/schedules/mcp.ts";
import { openScheduleStore } from "../src/schedules/store.ts";
import { coworkerHarness } from "./support/harness.ts";

describe("Schedule MCP server", () => {
  let server: ScheduleMcpServer | undefined;
  afterEach(async () => server?.close());

  it("binds a bearer-authenticated loopback tool surface", async () => {
    const h = await coworkerHarness();
    const store = await openScheduleStore(`${h.stateDir}/schedules.json`);
    const control = createScheduleControl({ store, slack: h.slack, clock: h.clock, dispatch: async () => {} });
    const env: NodeJS.ProcessEnv = {};
    server = await startScheduleMcpServer({ control, env, log: { info: () => {}, warn: (message) => h.warnings.push(message) } });

    expect(new URL(server.config.url).hostname).toBe("127.0.0.1");
    expect(server.config.defaultToolsApprovalMode).toBe("approve");
    expect((await fetch(server.config.url)).status).toBe(401);
    const inventory = await createMcpInventoryProber(env).probe(server.config);
    expect(inventory.tools).toEqual(expect.arrayContaining([
      "create_schedule", "list_schedules", "get_schedule", "update_schedule",
      "pause_schedule", "resume_schedule", "delete_schedule", "run_schedule_now",
    ]));
    expect(env[SCHEDULE_MCP_TOKEN_ENV]).toBeTruthy();
  });
});
