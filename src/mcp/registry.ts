/**
 * The single source of truth for the MCP tool surface.
 *
 * Every tool is one entry: name + title + agent-facing description + input
 * schema + pure handler. Everything else derives from this array —
 * `server.ts` registers it in a loop (transport only), `registry.test.ts`
 * enforces the layer contract (completeness, naming, output shapes), and
 * `scripts/gen-tooldoc.mjs` regenerates the tool table in
 * docs/AGENT_TOOLS.md (a test fails if the doc drifts).
 *
 * Layer contract (docs/AGENT_TOOLS.md): a TOOL is one capability — a pure
 * JSON → JSON wrapper over the tested core. No sequencing, no judgment prose,
 * and a handler never calls another handler. Workflow knowledge (what to call
 * next) belongs to the skill layer; descriptions may say what a tool is FOR,
 * not script multi-step procedures.
 */

import { z } from "zod";
import * as tools from "@/mcp/tools";

export interface ToolDefinition {
  /** snake_case tool name, unique across the registry. */
  readonly name: string;
  /** Short human title shown by MCP clients. */
  readonly title: string;
  /** Agent-facing description: what the tool does and when to reach for it. */
  readonly description: string;
  /** Zod raw shape for the tool input (loose for methods-free domain objects). */
  readonly inputSchema: Record<string, z.ZodType>;
  /** The pure handler from tools.ts (JSON in → JSON out, no transport). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: (args: any) => unknown;
}

// Loose schemas for the (already-validated, methods-free) domain objects: the
// core functions validate by use, and re-declaring StructureModel/PowderPattern
// as Zod would duplicate the source of truth. Primitives are typed precisely.
const anyObj = z.record(z.string(), z.any());
const anyArr = z.array(z.any());

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  {
    name: "parse_structure",
    title: "Parse structure (CIF/mCIF)",
    description: "Parse CIF/mCIF text into a StructureModel (cell, sites, space group) and any magnetic model. The entry point: feed its `structure` to build_refinement / interpret_structure.",
    inputSchema: { cif: z.string().describe("CIF or mCIF file text"), id: z.string().optional() },
    handler: tools.parse_structure,
  },
  {
    name: "parse_powder_data",
    title: "Parse powder pattern",
    description: "Auto-detect and parse powder data (xye/xy/dat/GSAS/FullProf/ILL). Returns the pattern, a summary (points, unit, range, radiation), and how the format was detected (source + confidence).",
    inputSchema: { text: z.string().describe("Powder data file text"), filename: z.string().optional() },
    handler: tools.parse_powder_data,
  },
  {
    name: "parse_instrument",
    title: "Parse instrument file",
    description: "Parse an instrument-parameter file (GSAS-II .instprm, classic GSAS .prm, FullProf .irf) into a CW or TOF calibration. Pass the result to build_refinement/refine_powder so the wavelength and profile are right.",
    inputSchema: { text: z.string().describe("Instrument-parameter file text") },
    handler: tools.parse_instrument,
  },
  {
    name: "build_refinement",
    title: "Build refinement parameter set",
    description: "Build the SYMMETRY-ALLOWED parameter set, bindings, and profile for a structure + pattern. Only symmetry-allowed parameters are created, so an agent cannot free a forbidden one. Feed `parameters`/`bindings`/`profile` to refine_powder.",
    inputSchema: {
      structure: anyObj.describe("StructureModel from parse_structure"),
      pattern: anyObj.describe("PowderPattern from parse_powder_data"),
      instrument: anyObj.optional().describe("InstrumentParameters (CW or TOF); defaults to CW λ=1.54 Å"),
      backgroundTerms: z.number().int().min(1).max(24).optional(),
      mustrain: z.enum(["isotropic", "uniaxial", "generalized"]).optional(),
    },
    handler: tools.build_refinement,
  },
  {
    name: "refine_powder",
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
    handler: tools.refine_powder,
  },
  {
    name: "assess_refinement",
    title: "Assess refinement (expert judgment)",
    description: "The judgment tool. Turn a refinement result into a structured expert read: a trust VERDICT (Toby GoF bands) plus ranked FINDINGS — dangerous correlations (with the physical reason), at-bound/unphysical parameters, ill-conditioning, over/under-parameterization, and UNEXPLAINED RESIDUAL PEAKS (the missing-phase / magnetic-order signal). Pass the refine_powder outputs straight in.",
    inputSchema: {
      result: anyObj.describe("RefinementResult from refine_powder"),
      parameters: anyArr,
      observationCount: z.number().int().nonnegative(),
      residual: z.object({ d: z.array(z.number()), yObs: z.array(z.number()), yCalc: z.array(z.number()) }).optional().describe("From refine_powder; enables missing-peak detection"),
      mode: z.enum(["powder", "single-crystal"]).optional(),
    },
    handler: tools.assess_refinement,
  },
  {
    name: "suggest_next_steps",
    title: "Suggest next steps",
    description: "The decision tool. Given an assessment, return ranked next ACTIONS (sequencing the constrained refinement — never inventing values): fix an unphysical value, hold an at-bound parameter, break a correlation, hunt an impurity/magnetic phase, or validate a good fit before extending it.",
    inputSchema: { assessment: anyObj.describe("Output of assess_refinement") },
    handler: tools.suggest_next_steps,
  },
  {
    name: "interpret_structure",
    title: "Interpret structure (materials science)",
    description: "The materials tool. Read a refined structure for engineering/discovery signals: crystallite size & microstrain (microstructure), partial occupancy (off-stoichiometry / vacancies / doping), large displacement parameters (disorder), magnetic order, and bond-length sanity — each paired with its materials meaning.",
    inputSchema: {
      structure: anyObj, parameters: anyArr.optional(), esd: z.record(z.string(), z.number()).optional(),
      wavelength: z.number().positive().optional().describe("Å — needed for crystallite size"),
      magnetic: anyObj.nullable().optional(),
    },
    handler: tools.interpret_structure,
  },
  {
    name: "evaluate_pattern",
    title: "Evaluate pattern (no refinement)",
    description: "Compute the calculated pattern and agreement (wR/GoF) at the CURRENT parameter values — no refinement. The cheap what-if tool: tweak a value, evaluate, compare. Pass a magnetic model to get the nuclear and magnetic components separately (what do the moments alone contribute?).",
    inputSchema: {
      structure: anyObj, pattern: anyObj,
      parameters: anyArr, bindings: anyArr, profile: anyObj,
      magnetic: anyObj.nullable().optional().describe("MagneticModel — adds yNuclear/yMagnetic component curves"),
    },
    handler: tools.evaluate_pattern,
  },
  {
    name: "simulate_pattern",
    title: "Simulate pattern (structure only)",
    description: "Simulate the powder pattern of a structure on an instrument before any data exists — planning, phase identification by eye, generating a reference. Grid defaults: CW 5–120° 2θ; TOF the d = 0.6–6 Å band of the calibration. Pass a magnetic model to include (and separate out) the magnetic contribution.",
    inputSchema: {
      structure: anyObj,
      instrument: anyObj.optional().describe("CW or TOF calibration; defaults to CW λ=1.54 Å"),
      xMin: z.number().optional(), xMax: z.number().optional(),
      points: z.number().int().min(100).max(20000).optional(),
      scale: z.number().positive().optional(),
      magnetic: anyObj.nullable().optional(),
    },
    handler: tools.simulate_pattern,
  },
  {
    name: "reflection_list",
    title: "Reflection list (hkl, d, multiplicity)",
    description: "Unique hkl families with d-spacing and multiplicity for a structure, optionally with the instrument-frame position (2θ or TOF µs). Set absences:false to keep nuclear-extinct families — that is where AFM magnetic satellites live, and how you match an unexplained peak to a candidate hkl.",
    inputSchema: {
      structure: anyObj,
      dMin: z.number().positive().optional(), dMax: z.number().positive().optional(),
      absences: z.boolean().optional().describe("false keeps systematically-absent nuclear families"),
      instrument: anyObj.optional(),
    },
    handler: tools.reflection_list,
  },
  {
    name: "bond_geometry",
    title: "Bond lengths (sanity check)",
    description: "Nearest-neighbour bond lengths (Å) up to a cutoff from the symmetry-expanded structure, sorted shortest first. The physical-plausibility check after refining positions: an impossibly short contact means the refinement went somewhere unphysical.",
    inputSchema: { structure: anyObj, cutoff: z.number().positive().max(8).optional() },
    handler: tools.bond_geometry,
  },
  {
    name: "find_unexplained_peaks",
    title: "Find unexplained residual peaks",
    description: "Find peaks in the residual (obs − calc) that the nuclear model does not explain — the magnetic-order / impurity-phase signal. Robust MAD-based thresholding; returns d-spacings ranked by height. A handful of peaks suggests magnetic satellites; dozens mean the nuclear fit itself is poor.",
    inputSchema: {
      residual: z.object({ d: z.array(z.number()), yObs: z.array(z.number()), yCalc: z.array(z.number()) }).describe("From refine_powder"),
      options: z.object({ sigma: z.number().positive().optional(), minFraction: z.number().positive().optional(), window: z.number().int().positive().optional(), mergeD: z.number().positive().optional(), limit: z.number().int().positive().optional() }).optional(),
    },
    handler: tools.find_unexplained_peaks,
  },
  {
    name: "search_propagation_vector",
    title: "Search propagation vector k",
    description: "Rank candidate commensurate propagation vectors k (denominators 2/3/4/6) by how many unexplained peak d-spacings their satellites G ± k explain. Feed the d values from find_unexplained_peaks; the winning k goes to list_magnetic_subgroups.",
    inputSchema: {
      structure: anyObj,
      peakD: z.array(z.number().positive()).describe("Unexplained peak d-spacings (Å)"),
      options: z.object({ tolerance: z.number().positive().optional(), hklRange: z.number().int().positive().optional(), limit: z.number().int().positive().optional(), maxQ: z.number().positive().optional() }).optional(),
    },
    handler: tools.search_propagation_vector,
  },
  {
    name: "list_magnetic_subgroups",
    title: "List magnetic subgroup candidates",
    description: "Enumerate the maximal magnetic subgroup candidates of the parent space group for a propagation vector k: conjugacy-class representatives with BNS identification, subgroup index, and domain count. The chosen candidate's `operations` feed allowed_moments and build_magnetic_model.",
    inputSchema: {
      structure: anyObj,
      k: z.array(z.number()).length(3).optional().describe("Propagation vector, default (0,0,0)"),
      maxIndex: z.number().int().min(2).max(48).optional(),
    },
    handler: tools.list_magnetic_subgroups,
  },
  {
    name: "allowed_moments",
    title: "Allowed moment directions per site",
    description: "The site-symmetry analysis: which moment directions the magnetic group allows on each site (null space of the magnetic stabilizer, with the k-phase). Dimension 0 = moment symmetry-forbidden; the basis spans exactly what a refinement may vary. Matches GSAS-II's per-site moment rules.",
    inputSchema: {
      structure: anyObj,
      operations: anyArr.optional().describe("Magnetic group operations (default: the structure's own)"),
      k: z.array(z.number()).length(3).optional(),
      siteLabels: z.array(z.string()).optional(),
    },
    handler: tools.allowed_moments,
  },
  {
    name: "build_magnetic_model",
    title: "Build symmetry-allowed magnetic model",
    description: "Build the magnetic model + moment-mode parameters for chosen ion sites under a magnetic subgroup: amplitudes over the symmetry-ALLOWED directions only, co-located (occupancy-disorder) ions tied to one moment, split orbits as independent sublattices. The refinement cannot leave the allowed space by construction. Feed the outputs to refine_magnetic_powder.",
    inputSchema: {
      structure: anyObj,
      ionLabels: z.array(z.string()).min(1).describe("Magnetic site labels, e.g. [\"Mn1\"]"),
      operations: anyArr.optional().describe("Magnetic subgroup operations from list_magnetic_subgroups"),
      k: z.array(z.number()).length(3).optional(),
      moment: z.number().positive().optional().describe("Seed amplitude in µ_B (default 1)"),
      tieSameSite: z.boolean().optional(),
    },
    handler: tools.build_magnetic_model,
  },
  {
    name: "rank_next_parameters",
    title: "Rank next parameters (sensitivity)",
    description: "The next-step diagnostic: rank the currently-FIXED parameter groups by the χ² improvement freeing them is expected to buy (Gauss–Newton estimate from probed Jacobian columns at the current values). Read `predictedWr` vs `wrNow` for absolute progress — on a converged model every group promises nothing. A LOCAL probe: align the pattern first; badly displaced peaks under-credit the cell/zero groups.",
    inputSchema: {
      structure: anyObj, pattern: anyObj,
      parameters: anyArr, bindings: anyArr, profile: anyObj,
      magnetic: anyObj.nullable().optional(),
    },
    handler: tools.rank_next_parameters,
  },
  {
    name: "refine_magnetic_powder",
    title: "Refine nuclear + magnetic (staged)",
    description: "Co-refine nuclear + magnetic against a powder pattern. Staged by default: scale + background converge with moments and profile held, then everything requested is freed — a flat co-refinement from a poor moment start can collapse the scale against exploding moments. Combine the nuclear parameters/bindings from build_refinement with the moment set from build_magnetic_model. Returns the result, the refined magnetic model, and separated nuclear/magnetic component curves.",
    inputSchema: {
      structure: anyObj, magnetic: anyObj, pattern: anyObj,
      parameters: anyArr.describe("Nuclear + moment parameters (set fixed:false on what refines)"),
      bindings: anyArr, profile: anyObj,
      staged: z.boolean().optional(),
      maxIterations: z.number().int().min(1).max(200).optional(),
    },
    handler: tools.refine_magnetic_powder,
  },
];
