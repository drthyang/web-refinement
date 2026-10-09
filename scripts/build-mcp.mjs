/**
 * Bundle the MCP server into a single runnable ESM file.
 *
 * The refinement core imports via the `@/` alias (Vite), which plain Node cannot
 * resolve — so we bundle with esbuild (already present via Vite), aliasing `@` →
 * `src` and inlining the pure core. Output: dist/mcp-server.mjs, runnable with
 * `node dist/mcp-server.mjs`. The MCP SDK is bundled too, so the file is
 * self-contained.
 *
 * `--serve` starts the server right after building, so an MCP client
 * (`.mcp.json`) always runs the current source. Everything here logs to
 * stderr: with `--serve`, stdout is the JSON-RPC channel.
 *
 * `--outfile <path>` writes the bundle elsewhere. The examples test uses it so
 * it never replaces the dist/mcp-server.mjs a running server's evaluator
 * workers re-execute.
 *
 * `--live` builds the `materia-live` server instead (src/agent/bridge/): the
 * Agent's tools on the app open in the browser, for Claude Code. Output:
 * dist/materia-live.mjs.
 */

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const at = process.argv.indexOf("--outfile");
const outfile = at > 0 && process.argv[at + 1]
  ? resolve(process.argv[at + 1])
  : resolve(root, live ? "dist/materia-live.mjs" : "dist/mcp-server.mjs");

await build({
  entryPoints: [resolve(root, live ? "src/agent/bridge/server.ts" : "src/mcp/server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@": resolve(root, "src") },
  // ESM interop for the few CJS deps the MCP SDK pulls in.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

console.error(`built ${outfile}`);

if (process.argv.includes("--serve")) await import(pathToFileURL(outfile).href);
