/**
 * Regenerate the MCP tool table in docs/AGENT_TOOLS.md from the registry —
 * the registry (src/mcp/registry.ts) is the single source of truth, and
 * src/mcp/registry.test.ts fails when the doc drifts, so run this after any
 * registry change:
 *
 *   npm run gen:tooldoc
 *
 * The registry uses the Vite `@/` alias, so it is esbuild-bundled to a temp
 * file first (same approach as scripts/build-mcp.mjs).
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = resolve(root, "dist/.tooldoc-registry.mjs");

await build({
  entryPoints: [resolve(root, "src/mcp/registry.ts")],
  outfile: tmp,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@": resolve(root, "src") },
  logLevel: "silent",
});

const { TOOL_REGISTRY } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

const esc = (s) => s.replaceAll("|", "\\|");
const rows = TOOL_REGISTRY.map((t) => `| \`${t.name}\` | ${esc(t.title)} | ${esc(t.description)} |`);
const table = [
  "| Tool | Title | Description |",
  "|---|---|---|",
  ...rows,
].join("\n");

const docPath = resolve(root, "docs/AGENT_TOOLS.md");
const doc = readFileSync(docPath, "utf8");
const marked = /(<!-- TOOLS:BEGIN[^>]*-->)[\s\S]*?(<!-- TOOLS:END -->)/;
if (!marked.test(doc)) {
  console.error("docs/AGENT_TOOLS.md is missing the <!-- TOOLS:BEGIN --> … <!-- TOOLS:END --> markers");
  process.exit(1);
}
writeFileSync(docPath, doc.replace(marked, `$1\n${table}\n$2`));
console.log(`regenerated tool table (${TOOL_REGISTRY.length} tools) in docs/AGENT_TOOLS.md`);
