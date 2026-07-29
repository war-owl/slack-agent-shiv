import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "open-agent-test-server", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        {
          name: "read_fixture",
          description: "Read a fixture",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
