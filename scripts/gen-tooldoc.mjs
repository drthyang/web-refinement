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

// Human-facing layout: one short table per workflow (name + title), then the
// full agent-facing descriptions folded into a <details> block. A tool missing
// from TOOL_GROUPS still gets documented, under "Other tools" — add it to a
// group rather than letting that section grow. registry.test.ts only checks
// that every tool has a `| \`name\`` row, so keep descriptions out of tables.
const TOOL_GROUPS = [
  ["Structure, data and instrument", ["parse_structure", "parse_powder_data", "parse_instrument", "reflection_list", "bond_geometry", "analyze_site_symmetry"]],
  ["Powder refinement", ["build_refinement", "refine_powder", "evaluate_pattern", "simulate_pattern", "rank_next_parameters"]],
  ["Judging a refinement", ["assess_refinement", "suggest_next_steps", "interpret_structure"]],
  ["Magnetic structures", ["find_unexplained_peaks", "search_propagation_vector", "list_magnetic_subgroups", "allowed_moments", "build_magnetic_model", "refine_magnetic_powder"]],
  ["Single crystal", ["parse_single_crystal_data", "write_single_crystal_data", "merge_magnetic_supercell", "expand_structure_supercell", "build_modulated_moment_model"]],
  ["Pair distribution function (PDF)", ["parse_pdf_data", "build_pdf_model", "refine_pdf", "refine_pdf_boxcar", "compute_partial_pdf", "calibrate_qdamp", "sample_posterior"]],
  ["Magnetic PDF", ["build_mpdf_model", "refine_mpdf", "compute_mpdf_components"]],
  ["Symmetry modes", ["build_distortion_modes", "build_symmetry_modes"]],
];

const esc = (s) => s.replaceAll("|", "\\|");
const grouped = new Set(TOOL_GROUPS.flatMap(([, names]) => names));
const sections = TOOL_GROUPS.map(([heading, names]) => [heading, TOOL_REGISTRY.filter((t) => names.includes(t.name))]);
const ungrouped = TOOL_REGISTRY.filter((t) => !grouped.has(t.name));
if (ungrouped.length > 0) {
  sections.push(["Other tools", ungrouped]);
  console.warn(`gen:tooldoc — add to a TOOL_GROUPS entry: ${ungrouped.map((t) => t.name).join(", ")}`);
}

const table = [
  ...sections
    .filter(([, tools]) => tools.length > 0)
    .flatMap(([heading, tools]) => [
      `**${heading}**`,
      "",
      "| Tool | What it does |",
      "|---|---|",
      ...tools.map((t) => `| \`${t.name}\` | ${esc(t.title)} |`),
      "",
    ]),
  "<details>",
  "<summary>Full descriptions — the text an agent reads for each tool</summary>",
  "",
  ...TOOL_REGISTRY.flatMap((t) => [`**\`${t.name}\`** — ${t.description}`, ""]),
  "</details>",
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
