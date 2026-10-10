/**
 * The Agent's tools: what a model may read and do in the LIVE analysis.
 *
 * One list serves every way a model reaches the app (API key, local proxy,
 * Ollama, LM Studio), so the names, descriptions and schemas a model sees are
 * the same everywhere. This file is declarations only (no browser code); the
 * handlers live in powderTools.ts and pdfTools.ts and run in the page. Every tool names the pages it works on; on another page it
 * answers with an error that says so.
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
 * alter the model or the fit and need the user's approval unless the Agent
 * is in auto mode; `control` tools (stopping a run) never need it.
 */
export type ToolEffect = "read" | "change" | "control";

/** The pages the Agent works on. Each publishes its own port (port.ts). */
export type AgentPage = "powder" | "pdf";

export interface LiveToolSpec {
  /** snake_case, unique. */
  readonly name: string;
  /** Short human title, shown on the approval card. */
  readonly title: string;
  /** Model-facing: what the tool does and when to reach for it. */
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
  readonly effect: ToolEffect;
  /** The pages it works on; on another page it answers with an error naming them. */
  readonly pages: readonly AgentPage[];
  /** A change only the user may make: it asks them even in Auto. */
  readonly alwaysAsk?: boolean;
  /** The skill to have read before a change with this tool (default: the page's method). */
  readonly skill?: string;
}

const ids = z.array(z.string().min(1)).describe("Parameter ids, or globs such as \"bkg*\" or \"*Fe1*\"");

export const LIVE_TOOLS: readonly LiveToolSpec[] = [
  {
    name: "get_state",
    title: "Read the analysis",
    description:
      "The live analysis on the page the user has open — `technique` says which: \"powder\" (Rietveld) or \"pdf\" (a real-space fit of G(r)). Phases (space group, cell), data (points, axis, fit window), the page's settings (powder: instrument, background, microstrain, ADP model, any magnetic model; PDF: position parameterization, any spin model, warnings), the last refinement (status and agreement: wR and GoF on powder, Rw on PDF; iterations), the parameter groups with how many are free, and the recent steps of the history. Lists the free parameters with values and esds; pass `parameters` (ids or globs, [\"*\"] for all) to list others. Call it first, and again whenever you are unsure what changed.",
    inputSchema: {
      parameters: ids.optional().describe("Which parameters to list in full (ids or globs, [\"*\"] for every one). Default: the free ones."),
    },
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "assess_refinement",
    title: "Assess the fit",
    description:
      "Expert read of the LAST refinement on screen: a trust verdict (Toby GoF bands) and ranked findings — dangerous correlations with their physical reason, parameters at a bound or unphysical, ill-conditioning, over- or under-parameterization, and unexplained residual peaks (a missing phase or magnetic order). Needs a refinement result; after a model change, refine first. On the PDF page the verdict reads convergence only (uniform weights: no GoF) and there is no residual-peak scan.",
    inputSchema: {},
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "suggest_next_steps",
    title: "Suggest next steps",
    description:
      "Ranked next actions for the fit on screen, from its assessment: fix an unphysical value, hold an at-bound parameter, break a correlation, look for an impurity or magnetic phase, or validate a good fit before extending it. Sequencing only — it never proposes values.",
    inputSchema: {},
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "rank_next_parameters",
    title: "Rank what to free next",
    description:
      "Powder page only. Rank the currently FIXED parameter groups by the χ² improvement freeing them is expected to buy (a Gauss–Newton estimate at the current values). Compare `predictedWr` with `wrNow`: on a converged model every group promises little. A local probe — align the pattern (scale, background, cell, zero) first. Single-phase only.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "check_cell_symmetry",
    title: "Check cell and space group",
    description:
      "Powder page only. A sanity check at the START of a refinement, not a gate: a Le Bail fit refines the cell from peak positions alone, then reports leftover peaks no reflection can index (`unindexedPeaks`: a wrong cell or a missing phase — worth settling before refining) and forbidden reflections showing intensity (`absences.violated`). An absence flag is NOT a reason to change the space group: before the structure is refined it is as often profile misfit or an impurity line. Note it (write_note) and refine on; the space group is questioned only at the end, with review_symmetry. Never blocks a refinement. Uses the loaded phases, data, instrument and fit window; the other phases count as known impurities. Cannot catch a too-large cell. Takes several seconds.",
    inputSchema: {
      significance: z.number().positive().optional().describe("Leftover height, in σ, that counts as observed intensity (default 5)"),
      dMin: z.number().positive().optional().describe("Smallest d-spacing read, Å (default 0.7)"),
    },
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "find_unexplained_peaks",
    title: "Find unexplained peaks",
    description:
      "Powder page only. Peaks in the residual (obs − calc) of the curves on screen that sit on NO reflection of any phase — the impurity / magnetic-order signal (`unexplained`, `count`). Residual on or beside a known reflection is listed apart as `misfits`: that is a reflection whose intensity or shape the model does not match yet — what refining the structure, profile and corrections fixes — never an extra peak. Marks the unexplained peaks on the plot for the user (▽ with a guide line, listed under it, cleared at the next refinement; pass showMisfits to mark the misfits too) — so call it when the user asks to see or show the unexplained peaks. A handful suggests satellites or one impurity.",
    inputSchema: {
      sigma: z.number().positive().optional().describe("Detection threshold in robust σ (default 8)"),
      limit: z.number().int().positive().max(50).optional().describe("Most peaks to return (default 12)"),
      showMisfits: z.boolean().optional().describe("Also mark the misfits (residual on or beside a known reflection) on the plot; default false"),
    },
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "review_symmetry",
    title: "Review the space group (last step)",
    description:
      "Powder page only. The LAST step of the method, never the first: once every required stage is refined (scale, background, cell, positions, profile, ADPs) and the fit is still not good, read the REFINED residual at the reflections the space group forbids. Lists the forbidden reflections that still carry intensity and the subgroups of the same lattice that allow them (smallest index first, with their domain counts). Refuses, naming the stages left, until the method's stages are done: intensity differences on known reflections are what refinement fixes, so lowering the symmetry before refining to the best is wrong. The result is a proposal for the user: a lower group is a new model (its CIF), refined again from the start.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "magnetic_state",
    title: "Read the magnetic analysis",
    description:
      "Powder page only. The magnetic analysis step as it stands: the magnetic ions (✓ chosen), the residual peaks the nuclear fit leaves (d, σ, any nuclear reflection they sit on, whether the k-search uses them), the last k-search, the propagation vector k and its kind, the magnetic space groups of the little group of k that allow a moment on the chosen ions (ids G1, G2, … in the page's order; index, domains, moment components, and the moments-only fit once ranked), the chosen group with its amplitudes and moments, and the nuclear-only wR they are compared with.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "search_propagation_vector",
    title: "Search the propagation vector",
    description:
      "Powder page only. Search commensurate propagation vectors k (denominators 2, 3, 4, 6) that put magnetic satellites G ± k on the residual peaks the k-search uses (magnetic_state lists them; peaks on nuclear reflections are left out). Ranked by how many peaks each explains and how closely. Shows the list on the magnetic step. It does not set k: set_propagation_vector does.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "set_propagation_vector",
    title: "Set the propagation vector",
    description:
      "Powder page only. Set k on the magnetic step (reciprocal-lattice units; fractions as \"1/2\" or 0.5). The magnetic space groups are recomputed for this k and any group pick is dropped; the outcome lists them.",
    inputSchema: {
      k: z.array(z.union([z.number(), z.string()])).length(3).describe("The three components, e.g. [\"1/2\", 0, 0]"),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "select_magnetic_ions",
    title: "Choose the magnetic ions",
    description: "Powder page only. The sites that carry a moment (magnetic_state lists the candidates, e.g. Mn1). The groups' allowed moment components are counted on these sites.",
    inputSchema: {
      sites: z.array(z.string().min(1)).min(1).describe("Site labels"),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "set_moment_ties",
    title: "Tie the moments",
    description:
      "Powder page only. How the moment amplitudes are tied in the model built for a group: `sameSite` (default on) gives co-located ions on a mixed site one moment; `magnitudes` ties |M| across sublattices, within each element or across all chosen sites (\"off\" to release). Fewer free amplitudes when the powder cannot separate them.",
    inputSchema: {
      sameSite: z.boolean().optional(),
      magnitudes: z.enum(["off", "element", "all"]).optional(),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "rank_magnetic_groups",
    title: "Rank the magnetic groups",
    description:
      "Powder page only. Fit the moments of each magnetic group that allows a moment (the nuclear model held) and rank them by wR: `scope` \"open\" (default) fits the groups in the index sections open on the page (the maximal, index-2 groups at first: the top-down start), \"all\" every group. Returns the fitted groups, best first, with the best marked (ties go to the maximal group with the fewest moment parameters). Several seconds per group.",
    inputSchema: {
      scope: z.enum(["open", "all"]).optional(),
    },
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "choose_magnetic_group",
    title: "Choose a magnetic group",
    description:
      "Powder page only. Choose one magnetic space group by its id (G1, G2, … from magnetic_state or rank_magnetic_groups): its symmetry-allowed moment model is built on the chosen ions and drawn on the pattern and in 3D. A ranked group starts from its fitted moments.",
    inputSchema: {
      id: z.string().min(1).describe("The group's id, e.g. \"G3\""),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "refine_moments",
    title: "Fit the moments",
    description: "Powder page only. Fit the chosen group's moment amplitudes against the pattern, the nuclear model held fixed. Returns wR and the moments (µB).",
    inputSchema: {},
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "show_magnetic_model",
    title: "Show the model on the refinement pattern",
    description:
      "Powder page only. Put the chosen magnetic model on the refinement step with its moments held (`show` false removes it): the nuclear refinement then fits against nuclear + magnetic. continue_magnetic_refinement instead adds the moments as parameters.",
    inputSchema: {
      show: z.boolean().optional(),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
  },
  {
    name: "continue_magnetic_refinement",
    title: "Refine nuclear and magnetic together",
    description:
      "Powder page only. Hand the chosen model to the refinement step: its moment amplitudes become free parameter rows (and the allowed k components too with `refineK`, when canRefineK). The page switches to the refinement step; refine then fits nuclear and magnetic together — choose the free set with set_free as usual.",
    inputSchema: {
      refineK: z.boolean().optional(),
    },
    effect: "change",
    pages: ["powder"],
    skill: "magnetic-analysis",
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
    pages: ["powder", "pdf"],
  },
  {
    name: "interpret_structure",
    title: "Interpret the structure",
    description:
      "Read the refined primary phase for materials signals: crystallite size and microstrain (powder), partial occupancy (off-stoichiometry, vacancies), large displacement parameters (disorder), magnetic order, and bond-length sanity — each with its materials meaning.",
    inputSchema: {},
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "read_skill",
    title: "Read a skill",
    description:
      "Read one of the user's skills (the system prompt lists them): the method you follow, in the user's own words, and the references behind it. Read the open page's method skill before your first change on that page — changes are refused until you have, in this conversation. Pass `reference` with one of the names the skill lists to read that reference (a longer knowledge base: read one only when the task needs it).",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name, e.g. \"my-rietveld-workflow\""),
      reference: z.string().min(1).optional().describe("One of the skill's references, by the name it lists"),
    },
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "allow_exception",
    title: "Allow an exception to the method",
    description:
      "Ask the user to lift one of their method's firm rules for this analysis, when refine refused on it and the user wants to go on regardless: \"bare-occupancy\" (refine an occupancy with no tie, because a second contrast — anomalous X-ray, isotopic neutron — determines it). Always shows the user an approval card, even in Auto; only they can approve it. Give their reason in `reason`. Lasts until the data or the phases change.",
    inputSchema: {
      rule: z.enum(["bare-occupancy"]),
      reason: z.string().min(3).describe("Why the rule does not apply here, in the user's terms"),
    },
    effect: "change",
    pages: ["powder", "pdf"],
    alwaysAsk: true,
  },
  {
    name: "write_note",
    title: "Note it for this analysis",
    description:
      "Keep one short note in this analysis's record, which is saved with the project: a finding that should outlast this conversation (an absence the cell check flagged, to revisit at the symmetry review; a correlation that forced a choice, an impurity identified) or a decision the user made and why (hold the composition; the minor phase is MnO; keep Qdamp from the Ni standard). get_state lists the notes, so they carry into the next conversation and the next session. One fact per note, a sentence or two; not for narrating progress.",
    inputSchema: {
      text: z.string().min(3).max(400).describe("The note, in a sentence or two"),
    },
    effect: "read",
    pages: ["powder", "pdf"],
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
    pages: ["powder", "pdf"],
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
    pages: ["powder", "pdf"],
  },
  {
    name: "set_background",
    title: "Change the background",
    description:
      "Powder page only. Change the background model: the number of coefficients (rebuilds the parameter set, keeping every other value and free state) and/or the basis. Changing the basis between a polynomial and an interpolation type reseeds the coefficients. Clears the last result.",
    inputSchema: {
      terms: z.number().int().min(0).max(24).optional().describe("Number of background coefficients"),
      type: z.enum(["chebyshev", "cosine", "powerSeries", "linInterpolate", "logInterpolate"]).optional(),
    },
    effect: "change",
    pages: ["powder"],
  },
  {
    name: "set_microstrain",
    title: "Change the microstrain model",
    description:
      "Powder page only. Set the sample microstrain (Mustrain) model: isotropic (Lorentzian Y), uniaxial (equatorial/axial about c), or generalized (Stephens S-parameters, one per symmetry-allowed term). New rows start fixed — free them with set_free. Clears the last result.",
    inputSchema: { model: z.enum(["isotropic", "uniaxial", "generalized"]) },
    effect: "change",
    pages: ["powder"],
  },
  {
    name: "set_adp_model",
    title: "Change the ADP model",
    description:
      "Powder page only. Switch the atomic displacement model between isotropic (B_iso) and anisotropic (symmetry-allowed U tensor components, seeded from each site's current B_iso). New rows start fixed — free them with set_free. Anisotropic ADPs need good data; they are the last structural step.",
    inputSchema: { anisotropic: z.boolean() },
    effect: "change",
    pages: ["powder"],
  },
  {
    name: "set_site_ties",
    title: "Change the site ties",
    description:
      "Powder page only. The Shared site settings, for atoms that share a crystallographic site or an element spread over several sites. `positions`/`adp`: one position / one ADP per shared site (default on). `occupancyToUnity`: a shared site's Σ occupancy is restrained to 1 instead of its starting sum. `composition`: each element on two or more sites keeps its total in the cell, so atoms exchange between sites while the formula stays (anti-site disorder, spinel inversion). With the shared-site Σ and the composition held, freeing the occupancies of two mixed sites refines one exchange fraction, and refine's correlation check does not count occupancies tied by one restraint against each other (scale and ADPs still count). The restraints act only while one of their occupancies is free; get_state lists them. Multi-phase too; not with a magnetic model applied.",
    inputSchema: {
      positions: z.boolean().optional(),
      adp: z.boolean().optional(),
      occupancyToUnity: z.boolean().optional(),
      composition: z.boolean().optional(),
    },
    effect: "change",
    pages: ["powder"],
  },
  {
    name: "set_fit_range",
    title: "Change the fit window",
    description:
      "Restrict the refinement to a window, or pass whole:true to undo it: the whole pattern on powder, the page's default r window on PDF. On powder, min/max may be in any unit the pattern converts to (get_state lists them with the extent in each): pass `unit` and the page converts with its own calibration (wavelength, or difC/difA/zero for TOF) — never convert yourself. On the PDF page the window is r in Å.",
    inputSchema: {
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.enum(["tof", "twoTheta", "dSpacing", "q"]).optional().describe("Powder only: the unit of min/max — tof (µs), twoTheta (°), dSpacing (Å) or q (Å⁻¹). Default: the data's own axis"),
      whole: z.boolean().optional().describe("Powder: fit the whole pattern. PDF: the default r window"),
    },
    effect: "change",
    pages: ["powder", "pdf"],
  },
  {
    name: "refine",
    title: "Refine",
    description:
      "Run the refinement of the free parameters, as the Refine button does, and wait for it. mode \"thorough\" is the Prefit / Escape-minimum button instead: with no fit yet, a multi-start search (on powder, after a Le Bail cell pre-fit); after a fit, a light multi-start nudge out of a local minimum. Correlated parameters are never refined together: before it runs (and before the user is asked), it measures the free set at the current values, and refuses when two free parameters correlate at |ρ| ≥ 0.95 or the data cannot determine a combination of them, naming them with the physical reason; fix one of each pair with set_free, or refine them in separate stages. Returns the outcome (status; wR and GoF on powder, Rw on PDF; iterations, free count; any pair that correlates at the refined values) and the step it recorded. Follow it with assess_refinement.",
    inputSchema: {
      mode: z.enum(["refine", "thorough"]).optional().describe("Default \"refine\""),
    },
    effect: "change",
    pages: ["powder", "pdf"],
  },
  {
    name: "boxcar_scan",
    title: "Boxcar scan",
    description:
      "PDF page only. The r-resolved view of the current model: a box of fixed width slid across the fit window, the FREE parameters refined in each box (seeded from the previous one), as the page's Boxcar view does — the user watches it there. It answers whether the local structure differs from the average: Rw and parameters that drift between low and high r. The parameter rows are left as they are (a diagnostic, not a fit). Returns, per box, its r range, Rw and the free parameters' values, and each parameter's spread. Takes about one refinement per box. Free only what you want tracked first.",
    inputSchema: {
      width: z.number().positive().optional().describe("Box width in Å (default 5)"),
      step: z.number().positive().optional().describe("Advance between boxes in Å (default 1; width/2 gives half-overlapping boxes)"),
      direction: z.enum(["up", "down", "both"]).optional().describe("Walk low → high r (default), high → low, or both (path dependence shows as a gap)"),
    },
    effect: "change",
    pages: ["pdf"],
  },
  {
    name: "reset_parameters",
    title: "Reset to starting values",
    description: "Put every parameter back to its starting value and clear the result (the Reset control). Recorded as a step, so it can be undone.",
    inputSchema: {},
    effect: "change",
    pages: ["powder", "pdf"],
  },
  {
    name: "go_to_step",
    title: "Go to a step",
    description:
      "Return the analysis to an earlier step of the history (get_state lists recent ones; ids look like \"s7\"), as clicking it in History does. Nothing is lost: the steps after it stay in the tree as a branch.",
    inputSchema: { step: z.string().regex(/^s\d+$/).describe("Step id, e.g. \"s7\"") },
    effect: "change",
    pages: ["powder", "pdf"],
  },
  {
    name: "cancel_refinement",
    title: "Cancel the running refinement",
    description: "Stop a refinement that is running. The parameters keep their values from before it started.",
    inputSchema: {},
    effect: "control",
    pages: ["powder", "pdf"],
  },
];

export const PAGE_LABEL: Readonly<Record<AgentPage, string>> = { powder: "powder", pdf: "PDF" };

export function liveTool(name: string): LiveToolSpec | undefined {
  return LIVE_TOOLS.find((t) => t.name === name);
}

/** The JSON Schema of a tool's input, for an LLM API or an MCP client. */
export function inputJsonSchema(spec: LiveToolSpec): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(spec.inputSchema).strict()) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
