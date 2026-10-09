/**
 * Entry point of the `materia-live` MCP server (liveBridge.ts) for Claude Code:
 * stdio for the MCP side, 127.0.0.1:MATERIA_LIVE_PORT (default 5199) for the
 * page. Bundle and start with `node scripts/build-mcp.mjs --live --serve`
 * (.mcp.json does this).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "@/app/constants";
import { COPILOT_TOOLS } from "@/copilot/tools";
import { DEFAULT_BRIDGE_PORT, createLiveBridge } from "@/copilot/bridge/liveBridge";

async function main(): Promise<void> {
  const port = Number(process.env.MATERIA_LIVE_PORT ?? DEFAULT_BRIDGE_PORT);
  const bridge = createLiveBridge({ port, version: APP_VERSION });
  await bridge.mcp.connect(new StdioServerTransport());
  // Never write to stdout: it is the JSON-RPC channel. Diagnostics go to stderr.
  try {
    const at = await bridge.listening;
    process.stderr.write(`materia-live MCP server ready (stdio, ${COPILOT_TOOLS.length} tools; app bridge on http://127.0.0.1:${at})\n`);
  } catch (e) {
    // Keep serving MCP: each tool call then explains the port problem.
    process.stderr.write(`materia-live: could not listen on 127.0.0.1:${port} — ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
