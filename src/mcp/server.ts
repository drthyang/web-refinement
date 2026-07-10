/**
 * MCP server exposing the refinement core's expert loop over stdio.
 *
 * Thin by design: it adds a transport and input schemas around the pure handlers
 * in `tools.ts` — no science lives here. Bundle with `npm run build:mcp`
 * (esbuild resolves the `@/` alias and inlines the pure core), then point any
 * MCP client at `node dist/mcp-server.mjs`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tools from "@/mcp/tools";

const server = new McpServer({ name: "materia", version: "0.1.0" });

/**
 * Wrap a pure handler: run it, return pretty JSON as text + structuredContent.
 * The transport boundary is genuinely untyped JSON-RPC (the schemas below are
 * deliberately loose for the methods-free domain objects), so `args` is `any`
 * here and the core validates by use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function json(handler: (args: any) => unknown): (args: any) => Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    try {
      const out = handler(args);
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

// Loose schemas for the (already-validated, methods-free) domain objects: the
// core functions validate by use, and re-declaring StructureModel/PowderPattern
// as Zod would duplicate the source of truth. Primitives are typed precisely.
const anyObj = z.record(z.string(), z.any());
const anyArr = z.array(z.any());

server.registerTool("parse_structure", {
  title: "Parse structure (CIF/mCIF)",
  description: "Parse CIF/mCIF text into a StructureModel (cell, sites, space group) and any magnetic model. The entry point: feed its `structure` to build_refinement / interpret_structure.",
  inputSchema: { cif: z.string().describe("CIF or mCIF file text"), id: z.string().optional() },
}, json(tools.parse_structure));

server.registerTool("parse_powder_data", {
  title: "Parse powder pattern",
  description: "Auto-detect and parse powder data (xye/xy/dat/GSAS/FullProf/ILL). Returns the pattern, a summary (points, unit, range, radiation), and how the format was detected (source + confidence).",
  inputSchema: { text: z.string().describe("Powder data file text"), filename: z.string().optional() },
}, json(tools.parse_powder_data));

server.registerTool("parse_instrument", {
  title: "Parse instrument file",
  description: "Parse an instrument-parameter file (GSAS-II .instprm, classic GSAS .prm, FullProf .irf) into a CW or TOF calibration. Pass the result to build_refinement/refine_powder so the wavelength and profile are right.",
  inputSchema: { text: z.string().describe("Instrument-parameter file text") },
}, json(tools.parse_instrument));

server.registerTool("build_refinement", {
  title: "Build refinement parameter set",
  description: "Build the SYMMETRY-ALLOWED parameter set, bindings, and profile for a structure + pattern. Only symmetry-allowed parameters are created, so an agent cannot free a forbidden one. Feed `parameters`/`bindings`/`profile` to refine_powder.",
  inputSchema: {
    structure: anyObj.describe("StructureModel from parse_structure"),
    pattern: anyObj.describe("PowderPattern from parse_powder_data"),
    instrument: anyObj.optional().describe("InstrumentParameters (CW or TOF); defaults to CW λ=1.54 Å"),
    backgroundTerms: z.number().int().min(1).max(24).optional(),
    mustrain: z.enum(["isotropic", "uniaxial", "generalized"]).optional(),
  },
}, json(tools.build_refinement));

server.registerTool("refine_powder", {
  title: "Refine (constrained least squares)",
  description: "Run the deterministic Levenberg–Marquardt refinement of the FREED parameters (fix a parameter by setting its `fixed:true`). Returns refined values, esds, agreement (wR/GoF), the SVD/correlation/at-bound diagnostics, the observation count, and the residual — everything assess_refinement needs. The agent decides what to free; it never sets values.",
  inputSchema: {
    structure: anyObj, pattern: anyObj,
    parameters: anyArr.describe("RefinementParameter[] (set fixed:true/false to choose what refines)"),
    bindings: anyArr, profile: anyObj,
    instrument: anyObj.optional(),
    extraPhases: anyArr.optional().describe("Additional crystallographic phases (multi-phase)"),
    staged: z.boolean().optional(),
    fitRange: z.object({ min: z.number(), max: z.number() }).optional(),
    maxIterations: z.number().int().min(1).max(200).optional(),
  },
}, json(tools.refine_powder));

server.registerTool("assess_refinement", {
  title: "Assess refinement (expert judgment)",
  description: "The judgment tool. Turn a refinement result into a structured expert read: a trust VERDICT (Toby GoF bands) plus ranked FINDINGS — dangerous correlations (with the physical reason), at-bound/unphysical parameters, ill-conditioning, over/under-parameterization, and UNEXPLAINED RESIDUAL PEAKS (the missing-phase / magnetic-order signal). Pass the refine_powder outputs straight in.",
  inputSchema: {
    result: anyObj.describe("RefinementResult from refine_powder"),
    parameters: anyArr,
    observationCount: z.number().int().nonnegative(),
    residual: z.object({ d: z.array(z.number()), yObs: z.array(z.number()), yCalc: z.array(z.number()) }).optional().describe("From refine_powder; enables missing-peak detection"),
    mode: z.enum(["powder", "single-crystal"]).optional(),
  },
}, json(tools.assess_refinement));

server.registerTool("suggest_next_steps", {
  title: "Suggest next steps",
  description: "The decision tool. Given an assessment, return ranked next ACTIONS (sequencing the constrained refinement — never inventing values): fix an unphysical value, hold an at-bound parameter, break a correlation, hunt an impurity/magnetic phase, or validate a good fit before extending it.",
  inputSchema: { assessment: anyObj.describe("Output of assess_refinement") },
}, json(tools.suggest_next_steps));

server.registerTool("interpret_structure", {
  title: "Interpret structure (materials science)",
  description: "The materials tool. Read a refined structure for engineering/discovery signals: crystallite size & microstrain (microstructure), partial occupancy (off-stoichiometry / vacancies / doping), large displacement parameters (disorder), magnetic order, and bond-length sanity — each paired with its materials meaning.",
  inputSchema: {
    structure: anyObj, parameters: anyArr.optional(), esd: z.record(z.string(), z.number()).optional(),
    wavelength: z.number().positive().optional().describe("Å — needed for crystallite size"),
    magnetic: anyObj.nullable().optional(),
  },
}, json(tools.interpret_structure));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout: it is the JSON-RPC channel. Diagnostics go to stderr.
  process.stderr.write("materia MCP server ready (stdio)\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
