/**
 * MCP server exposing the refinement core's expert loop over stdio.
 *
 * Transport only: the tool surface is defined once in `registry.ts` and served
 * by `host.ts` (server-side refs, `path`, `free`, `read_ref`) — adding a tool
 * never touches this file. Bundle with `npm run build:mcp` (esbuild resolves
 * the `@/` alias and inlines the pure core), then point any MCP client at
 * `node dist/mcp-server.mjs`, or at `node scripts/build-mcp.mjs --serve` to
 * rebuild first.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_REGISTRY } from "@/mcp/registry";
import { createMateriaServer, defaultRoots } from "@/mcp/host";
import { maybeRunAsEvaluator } from "@/mcp/nodeEvaluator";

async function main(): Promise<void> {
  const roots = defaultRoots();
  const server = createMateriaServer({ roots });
  await server.connect(new StdioServerTransport());
  // Never write to stdout: it is the JSON-RPC channel. Diagnostics go to stderr.
  const files = roots.length ? `data folders: ${roots.join(", ")}` : "file reading off (set MATERIA_ROOTS)";
  process.stderr.write(`materia MCP server ready (stdio, ${TOOL_REGISTRY.length} tools + read_ref; ${files})\n`);
}

// When this bundle is re-executed as a worker thread of the evaluator pool,
// serve evaluations instead of starting a second MCP transport.
maybeRunAsEvaluator()
  .then((isEvaluator) => {
    if (!isEvaluator) return main();
    return undefined;
  })
  .catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
