/**
 * The Copilot's tools: what a model may read and do in the LIVE analysis.
 *
 * One list serves every way a model reaches the app — the in-app chat (API key
 * or local proxy) and Claude Code through the `materia-live` MCP bridge — so
 * the names, descriptions and schemas a model sees are the same everywhere.
 * This file is declarations only (no browser code), so the Node bridge can
 * serve the same list; the handlers live in powderTools.ts and run in the page.
 *
 * Unlike the MATERIA MCP tools (src/mcp/registry.ts), which are pure functions
 * over data the caller passes, these act on what is on screen: the model never
 * sends a structure or a pattern, and a `change` tool does exactly what the
 * matching control does — recorded in the step history as an agent step, so
 * ⌘Z undoes it. The analysis tools reuse the MCP handlers on the live state.
 *
 * The guardrail of docs/AGENT_TOOLS.md holds here too: the model chooses what
 * to free and when to refine; the Levenberg–Marquardt engine sets every value.
 * There is deliberately no tool that types in a parameter value.
 */

import { z } from "zod";

/**
 * What a tool does to the analysis. `read` tools run freely; `change` tools
 * alter the model or the fit and need the user's approval unless the Copilot
 * is in auto mode; `control` tools (stopping a run) never need it.
 */
export type ToolEffect = "read" | "change" | "control";

export interface CopilotToolSpec {
  /** snake_case, unique. */
  readonly name: string;
  /** Short human title, shown on the approval card. */
  readonly title: string;
  /** Model-facing: what the tool does and when to reach for it. */
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  readonly effect: ToolEffect;
}

const ids = z.array(z.string().min(1)).describe("Parameter ids, or globs such as \"bkg*\" or \"*Fe1*\"");

export const COPILOT_TOOLS: readonly CopilotToolSpec[] = [
  {
    name: "get_state",
    title: "Read the analysis",
    description:
      "The live powder analysis as the user sees it: phases (space group, cell), data (points, axis, radiation, fit window), instrument, settings (background, microstrain, ADP model), any magnetic model, the last refinement (status, wR, GoF, iterations), the parameter groups with how many are free, and the recent steps of the history. Lists the free parameters with values and esds; pass `parameters` (ids or globs, [\"*\"] for all) to list others. Call it first, and again whenever you are unsure what changed.",
    inputSchema: {
      parameters: ids.optional().describe("Which parameters to list in full (ids or globs, [\"*\"] for every one). Default: the free ones."),
    },
    effect: "read",
  },
  {
    name: "assess_refinement",
    title: "Assess the fit",
    description:
      "Expert read of the LAST refinement on screen: a trust verdict (Toby GoF bands) and ranked findings — dangerous correlations with their physical reason, parameters at a bound or unphysical, ill-conditioning, over- or under-parameterization, and unexplained residual peaks (a missing phase or magnetic order). Needs a refinement result; after a model change, refine first.",
    inputSchema: {},
    effect: "read",
  },
  {
    name: "suggest_next_steps",
    title: "Suggest next steps",
    description:
      "Ranked next actions for the fit on screen, from its assessment: fix an unphysical value, hold an at-bound parameter, break a correlation, look for an impurity or magnetic phase, or validate a good fit before extending it. Sequencing only — it never proposes values.",
    inputSchema: {},
    effect: "read",
  },
  {
    name: "rank_next_parameters",
    title: "Rank what to free next",
    description:
      "Rank the currently FIXED parameter groups by the χ² improvement freeing them is expected to buy (a Gauss–Newton estimate at the current values). Compare `predictedWr` with `wrNow`: on a converged model every group promises little. A local probe — align the pattern (scale, background, cell, zero) first. Single-phase only.",
    inputSchema: {},
    effect: "read",
  },
  {
    name: "check_cell_symmetry",
    title: "Check cell and space group",
    description:
      "The gate before refining a structure: a Le Bail fit refines the cell from peak positions alone, then every leftover peak must index (`unindexedPeaks`: wrong cell or lattice, or a missing phase) and every forbidden reflection must carry no intensity (`absences.violated`: the group is too symmetric). Uses the loaded phases, data, instrument and fit window; the other phases count as known impurities. Cannot catch a too-large cell. Takes several seconds.",
    inputSchema: {
      significance: z.number().positive().optional().describe("Leftover height, in σ, that counts as observed intensity (default 5)"),
      dMin: z.number().positive().optional().describe("Smallest d-spacing read, Å (default 0.7)"),
    },
    effect: "read",
  },
  {
    name: "find_unexplained_peaks",
    title: "Find unexplained peaks",
    description:
      "Peaks in the residual (obs − calc) of the curves on screen that the model does not explain — the impurity / magnetic-order signal. Returns d-spacings ranked by height. A handful suggests satellites or one impurity; dozens mean the fit itself is poor.",
    inputSchema: {
      sigma: z.number().positive().optional().describe("Detection threshold in robust σ (default 8)"),
      limit: z.number().int().positive().max(50).optional().describe("Most peaks to return (default 12)"),
    },
    effect: "read",
  },
  {
    name: "bond_geometry",
    title: "Bond lengths",
    description:
      "Nearest-neighbour bond lengths (Å) of a phase at the current parameter values, shortest first. The plausibility check after refining positions: an impossibly short contact means the refinement went somewhere unphysical.",
    inputSchema: {
      cutoff: z.number().positive().max(8).optional().describe("Longest bond listed, Å (default 3.2)"),
      phase: z.string().optional().describe("Phase id (get_state lists them); default the primary phase"),
    },
    effect: "read",
  },
  {
    name: "interpret_structure",
    title: "Interpret the structure",
    description:
      "Read the refined primary phase for materials signals: crystallite size and microstrain, partial occupancy (off-stoichiometry, vacancies), large displacement parameters (disorder), magnetic order, and bond-length sanity — each with its materials meaning.",
    inputSchema: {},
    effect: "read",
  },
  {
    name: "read_ref",
    title: "Read a stored value",
    description:
      "Show the value behind a ref from an earlier result of these tools, e.g. \"#3/findings\". For a long array, pass start/end (end exclusive) to read a window.",
    inputSchema: {
      ref: z.string().describe("A ref such as \"#3\" or \"#3/findings/0\""),
      start: z.number().int().min(0).optional(),
      end: z.number().int().min(0).optional(),
    },
    effect: "read",
  },
  {
    name: "set_free",
    title: "Free or fix parameters",
    description:
      "Free (refine) or fix (hold) parameters, as the check boxes in the parameter panel do. Only the parameters named change; the others keep their state. Tied parameters (an expression) follow their tie and cannot be freed. Recorded as a step.",
    inputSchema: {
      free: ids.optional().describe("Parameters to refine"),
      fix: ids.optional().describe("Parameters to hold at their current values"),
    },
    effect: "change",
  },
  {
    name: "set_background",
    title: "Change the background",
    description:
      "Change the background model: the number of coefficients (rebuilds the parameter set, keeping every other value and free state) and/or the basis. Changing the basis between a polynomial and an interpolation type reseeds the coefficients. Clears the last result.",
    inputSchema: {
      terms: z.number().int().min(0).max(24).optional().describe("Number of background coefficients"),
      type: z.enum(["chebyshev", "cosine", "powerSeries", "linInterpolate", "logInterpolate"]).optional(),
    },
    effect: "change",
  },
  {
    name: "set_microstrain",
    title: "Change the microstrain model",
    description:
      "Set the sample microstrain (Mustrain) model: isotropic (Lorentzian Y), uniaxial (equatorial/axial about c), or generalized (Stephens S-parameters, one per symmetry-allowed term). New rows start fixed — free them with set_free. Clears the last result.",
    inputSchema: { model: z.enum(["isotropic", "uniaxial", "generalized"]) },
    effect: "change",
  },
  {
    name: "set_adp_model",
    title: "Change the ADP model",
    description:
      "Switch the atomic displacement model between isotropic (B_iso) and anisotropic (symmetry-allowed U tensor components, seeded from each site's current B_iso). New rows start fixed — free them with set_free. Anisotropic ADPs need good data; they are the last structural step.",
    inputSchema: { anisotropic: z.boolean() },
    effect: "change",
  },
  {
    name: "set_fit_range",
    title: "Change the fit window",
    description:
      "Restrict the refinement to a window on the pattern's own axis (get_state gives the unit and extent), or pass whole:true to fit the whole pattern again.",
    inputSchema: {
      min: z.number().optional(),
      max: z.number().optional(),
      whole: z.boolean().optional().describe("Fit the whole pattern"),
    },
    effect: "change",
  },
  {
    name: "refine",
    title: "Refine",
    description:
      "Run the refinement of the free parameters, as the Refine button does, and wait for it. mode \"thorough\" is the Prefit / Escape-minimum button instead: with no fit yet, a Le Bail cell pre-fit and a multi-start search; after a fit, a light multi-start nudge out of a local minimum. Returns the outcome (status, wR, GoF, iterations, free count) and the step it recorded. Follow it with assess_refinement.",
    inputSchema: {
      mode: z.enum(["refine", "thorough"]).optional().describe("Default \"refine\""),
    },
    effect: "change",
  },
  {
    name: "reset_parameters",
    title: "Reset to starting values",
    description: "Put every parameter back to its starting value and clear the result (the Reset control). Recorded as a step, so it can be undone.",
    inputSchema: {},
    effect: "change",
  },
  {
    name: "go_to_step",
    title: "Go to a step",
    description:
      "Return the analysis to an earlier step of the history (get_state lists recent ones; ids look like \"s7\"), as clicking it in History does. Nothing is lost: the steps after it stay in the tree as a branch.",
    inputSchema: { step: z.string().regex(/^s\d+$/).describe("Step id, e.g. \"s7\"") },
    effect: "change",
  },
  {
    name: "cancel_refinement",
    title: "Cancel the running refinement",
    description: "Stop a refinement that is running. The parameters keep their values from before it started.",
    inputSchema: {},
    effect: "control",
  },
];

export function copilotTool(name: string): CopilotToolSpec | undefined {
  return COPILOT_TOOLS.find((t) => t.name === name);
}

/** The JSON Schema of a tool's input, for an LLM API or an MCP client. */
export function inputJsonSchema(spec: CopilotToolSpec): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(spec.inputSchema).strict()) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
