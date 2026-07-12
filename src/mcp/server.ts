/**
 * MCP server exposing the refinement core's expert loop over stdio.
 *
 * Transport only: the tool surface is defined once in `registry.ts`
 * (name/title/description/schema/handler) and registered here in a loop —
 * adding a tool never touches this file. Bundle with `npm run build:mcp`
 * (esbuild resolves the `@/` alias and inlines the pure core), then point any
 * MCP client at `node dist/mcp-server.mjs`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_REGISTRY } from "@/mcp/registry";
import { maybeRunAsEvaluator } from "@/mcp/nodeEvaluator";

const server = new McpServer({ name: "materia", version: "0.1.0" });

/**
 * Wrap a pure handler: run it, return pretty JSON as text + structuredContent.
 * The transport boundary is genuinely untyped JSON-RPC (the registry schemas
 * are deliberately loose for the methods-free domain objects), so `args` is
 * `any` here and the core validates by use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function json(handler: (args: any) => unknown): (args: any) => Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    try {
      const out = await handler(args);
      // MCP `structuredContent` must be a JSON object; array results (e.g.
      // suggest_next_steps) travel as text only, which clients parse back.
      const isObject = out !== null && typeof out === "object" && !Array.isArray(out);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
        ...(isObject ? { structuredContent: out as Record<string, unknown> } : {}),
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
}

for (const tool of TOOL_REGISTRY) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
    json(tool.handler),
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout: it is the JSON-RPC channel. Diagnostics go to stderr.
  process.stderr.write(`materia MCP server ready (stdio, ${TOOL_REGISTRY.length} tools)\n`);
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
