import type { McpInventory, McpInventoryProber, McpServerConfig } from "../ports/mcp.ts";

/**
 * Connectors are not wired up yet — build/09 (GitHub) and build/11 (Linear) add
 * them, and build/08 adds the pinned inventory hash this prober feeds.
 *
 * It fails loudly rather than returning an empty inventory, because an empty
 * inventory that silently passed a hash check is exactly the failure the pin exists
 * to prevent.
 */
export const unimplementedInventoryProber: McpInventoryProber = {
  async probe(server: McpServerConfig): Promise<McpInventory> {
    throw new Error(
      `Connector "${server.name}" is configured, but probing MCP tool inventories is not ` +
        "implemented yet (build/08). Remove it from configuration until it is: running with " +
        "an unverified tool inventory is what the pin exists to prevent.",
    );
  },
};
