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
export type AgentPage = "powder" | "pdf" | "singleCrystal";

export interface LiveToolSpec {
  /** snake_case, unique. */
  readonly name: string;
  /** Short human title, shown on the approval card. */
  readonly title: string;
  /** Model-facing: what the tool does and when to reach for it. */
  readonly description: string;
  /**
   * The description without the skills (the validation's arm C), where this
   * one refers to the page's written method; absent: the same in both.
   */
  readonly withoutSkills?: string;
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
      "The live analysis on the page the user has open — `technique` says which: \"powder\" (Rietveld), \"pdf\" (a real-space fit of G(r)) or \"singleCrystal\" (F² from integrated reflections). Phases (space group, cell), data (points, axis, fit window), the page's settings (powder: instrument, background, microstrain, ADP model, any magnetic model; PDF: position parameterization, any spin model, warnings), the last refinement (status and agreement: wR and GoF on powder, Rw on PDF; iterations), the parameter groups with how many are free, and the recent steps of the history. Lists the free parameters with values and esds; pass `parameters` (ids or globs, [\"*\"] for all) to list others. Call it first, and again whenever you are unsure what changed.",
    inputSchema: {
      parameters: ids.optional().describe("Which parameters to list in full (ids or globs, [\"*\"] for every one). Default: the free ones."),
    },
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "assess_refinement",
    title: "Assess the fit",
    description:
      "Expert read of the LAST refinement on screen: a trust verdict (Toby GoF bands) and ranked findings — dangerous correlations with their physical reason, parameters at a bound or unphysical, ill-conditioning, over- or under-parameterization, and unexplained residual peaks (a missing phase or magnetic order). Needs a refinement result; after a model change, refine first. On the PDF page the verdict reads convergence only (uniform weights: no GoF) and there is no residual-peak scan.",
    inputSchema: {},
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
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
      "Powder page only. A sanity check at the START of a refinement, not a gate: a Le Bail fit refines the cell from peak positions alone, then reports leftover peaks no reflection can index (`unindexedPeaks`: a wrong cell or a missing phase — worth settling before refining), small bumps on a strong line's flank (`shoulders`: a profile tail, not a phase) and forbidden reflections showing intensity (`absences.violated`). An absence flag is NOT a reason to change the space group: before the structure is refined it is as often profile misfit or an impurity line. Note it (write_note) and refine on; the space group is questioned only at the end, with review_symmetry. Never blocks a refinement. Uses the loaded phases, data, instrument and fit window; the other phases count as known impurities. Cannot catch a too-large cell. Takes several seconds.",
    inputSchema: {
      significance: z.number().positive().optional().describe("Leftover height, in σ, that counts as observed intensity (default 5)"),
      dMin: z.number().positive().optional().describe("Smallest d-spacing read, Å (default 0.7)"),
    },
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "check_fit_range",
    title: "Check the fit range",
    description:
      "Powder page only. Reads the data's two ends and proposes where the fit window should start and stop, as the GSAS-II tutorials do: the long-d end starts just below the first reflection (the background beyond it tells the structure nothing) unless the data hold peaks there that no phase explains (magnetic order, an impurity: then keep them); the far end ends in a gap below a detector's or scan's edge (counts that step up and stay), points with no counts, a line cut by the last point, or the stretch where peaks have faded into the noise; on a converged fit, a stretch at an end the model misses by more than anywhere just inside. Each cut lies in a gap between reflections. Returns each end's verdict with the evidence, the counting σ at the ends, and `proposed` (the window, in the data's unit and in d) — apply it with set_fit_range, which asks the user. The first step of the method: run it before the cell check, and again after the first refinement, when the residual can show what the data alone could not. It never changes the window itself.",
    withoutSkills:
      "Powder page only. Reads the data's two ends and proposes where the fit window should start and stop, as the GSAS-II tutorials do: the long-d end starts just below the first reflection (the background beyond it tells the structure nothing) unless the data hold peaks there that no phase explains (magnetic order, an impurity: then keep them); the far end ends in a gap below a detector's or scan's edge (counts that step up and stay), points with no counts, a line cut by the last point, or the stretch where peaks have faded into the noise; on a converged fit, a stretch at an end the model misses by more than anywhere just inside. Each cut lies in a gap between reflections. Returns each end's verdict with the evidence, the counting σ at the ends, and `proposed` (the window, in the data's unit and in d) — apply it with set_fit_range, which asks the user. Run it again after the first refinement, when the residual can show what the data alone could not. It never changes the window itself.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "reflection_statistics",
    title: "Read the reflection data",
    description:
      "Single-crystal page only. The data before the model, as a crystallographer reads them first: reflections measured and unique after merging in the Laue class, R_int and R_σ, the redundancy, the resolution (d_min, sinθ/λ max) and the completeness to it, ⟨I/σ⟩ and completeness shell by shell, whether Friedel pairs were measured apart (the absolute structure needs them in a non-centrosymmetric group), the reflections the space group forbids that carry intensity (≥ 3σ: a wrong group, twinning, or multiple scattering), the intensity statistics ⟨|E²−1|⟩ (≈ 0.97 centrosymmetric, ≈ 0.74 not; low values hint at twinning), and where the lattice holds more symmetry than the Laue class, each merohedral twin law (`twinLaws`, as set_twin takes it) with the twin fraction Yeates' H-test reads for it from the intensities alone. The method's first stage: read it before refining.",
    withoutSkills:
      "Single-crystal page only. The data before the model, as a crystallographer reads them first: reflections measured and unique after merging in the Laue class, R_int and R_σ, the redundancy, the resolution (d_min, sinθ/λ max) and the completeness to it, ⟨I/σ⟩ and completeness shell by shell, whether Friedel pairs were measured apart (the absolute structure needs them in a non-centrosymmetric group), the reflections the space group forbids that carry intensity (≥ 3σ: a wrong group, twinning, or multiple scattering), the intensity statistics ⟨|E²−1|⟩ (≈ 0.97 centrosymmetric, ≈ 0.74 not; low values hint at twinning), and where the lattice holds more symmetry than the Laue class, each merohedral twin law (`twinLaws`, as set_twin takes it) with the twin fraction Yeates' H-test reads for it from the intensities alone.",
    inputSchema: {},
    effect: "read",
    pages: ["singleCrystal"],
  },
  {
    name: "reflection_equivalents",
    title: "Compare a reflection's equivalents",
    description:
      "Single-crystal page only. Every measurement of one reflection and of its symmetry equivalents (the Laue class): its batch (run, orientation) and wavelength when the file gives them, Fo² with σ, Fc², (Fo² − Fc²)/σ and the extinction factor y, and how far each lies from the equivalents' median (robust to the one that failed). Before leaving a reflection out, this tells a measurement that failed (one far from its equivalents, which agree with Fc²) from a misfit of the model (all of them off the same way).",
    inputSchema: { h: z.number().int(), k: z.number().int(), l: z.number().int() },
    effect: "read",
    pages: ["singleCrystal"],
  },
  {
    name: "set_outlier_filter",
    title: "Set the outlier filter",
    description:
      "Single-crystal page only. The SHELX-style OMIT filter: leave out reflections whose (Fo² − Fc²)/σ exceeds `cutoffSigma` against the current model (off by default; 6σ to start). For a few reflections hit by the beam stop, an ice ring or a detector edge (reflection_equivalents shows which) — never to improve R: say which and why, and keep it off when the misfit is systematic (extinction, twinning). `minExtinction` also leaves out the reflections whose extinction factor y falls below it (GSAS-II's minimum extinction; null removes it): where the correction is that severe the extinction model carries the intensity, so it is a test of whether the structure rests on those reflections, to report beside the fit with all of them. Applies to the next refinement; get_state lists how many it leaves out.",
    inputSchema: {
      on: z.boolean().optional(),
      cutoffSigma: z.number().positive().optional().describe("|Fo² − Fc²|/σ beyond which a reflection is left out"),
      minExtinction: z.number().gt(0).lt(1).nullable().optional().describe("Leave out the reflections whose extinction factor y is below this (0–1); null removes the cut"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "keep_reflections",
    title: "Keep failed measurements",
    description:
      "Single-crystal page only. Keep in the fit measurements assess_refinement lists as failed (`failedMeasurements`: off by themselves, their equivalents agreeing with the model), when the user wants them kept: write_report refuses while a listed failure is fitted and neither left out (omit_reflections) nor kept. Only when the user asks for it, never to get past the refusal. Always shows the user an approval card, even in Auto; only they can approve it. Give their reason in `reason`; the report lists what was kept and why. Lasts until the data change.",
    inputSchema: {
      reflections: z.array(z.object({ h: z.number().int(), k: z.number().int(), l: z.number().int(), batch: z.number().int().optional() })).min(1),
      reason: z.string().min(3).describe("Why the user keeps them, in their terms"),
    },
    effect: "change",
    pages: ["singleCrystal"],
    alwaysAsk: true,
  },
  {
    name: "test_extinction",
    title: "Test the extinguished reflections",
    description:
      "Single-crystal page only. The extinction test, with the page left as it is: the fit on screen refined twice as probes (the free set and start as they are), once on all the data fitted and once without the reflections whose extinction factor y is below `below` (default 0.5). Answers how many that leaves out, wR2 and the extinction parameter each way, and every free parameter that moves by more than 2 esd between them. None moving: the structure does not rest on the reflections the correction carries; one moving (an ADP, an occupancy): the model leans on them — try the other extinction model (set_extinction_model) and compare. Nothing on the page changes: no filter, no values, no step. Refine first: it starts from the converged fit.",
    inputSchema: {
      below: z.number().gt(0).lt(1).optional().describe("Leave out the reflections whose y is below this (default 0.5)"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "omit_reflections",
    title: "Omit measurements",
    description:
      "Single-crystal page only. Leaves single measurements out of the fit by their indices and batch, as SHELXL's OMIT h k l: for a measurement that failed (a detector edge or gap, a shadow), which its equivalents expose — assess_refinement marks each outlier whose equivalents fit as a failed measurement, and reflection_equivalents shows the family. Unlike the σ filter it takes only the measurements named, whatever their residual, so a failed one inside the misfit of an extinction-limited fit can go while the misfits stay. Give `batch` when the file has batches (the same indices measured in another batch stay); say why in `reason`, which goes into the report. `restore` puts measurements back (\"all\" for every one). Applies to the next refinement.",
    inputSchema: {
      omit: z.array(z.object({ h: z.number().int(), k: z.number().int(), l: z.number().int(), batch: z.number().int().optional() })).optional().describe("Measurements to leave out, by the file's own indices"),
      reason: z.string().optional().describe("Why, for the report: what the equivalents show"),
      restore: z.union([z.literal("all"), z.array(z.object({ h: z.number().int(), k: z.number().int(), l: z.number().int(), batch: z.number().int().optional() }))]).optional().describe("Omitted measurements to put back, or \"all\""),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_radiation",
    title: "Set the radiation",
    description:
      "Single-crystal page only. The probe and the wavelength the data were measured with, which a reflection file cannot say (a SHELX .hkl or .fcf loads as neutron at 1.54 Å): \"xray\" (atomic form factors f(s)), \"neutron\" (scattering lengths, one wavelength) or \"neutron-tof\" (a Laue measurement, each reflection at its own wavelength). `wavelength` in Å for X-ray and constant-wavelength neutrons: Mo Kα 0.71073, Cu Kα 1.54184, Ag Kα 0.56087. The probe changes every Fc; the wavelength enters the extinction correction (not |F|²). The scale restarts from its best value under the new physics and the last fit is cleared: refine again. Set it before anything else when get_state's probe or wavelength is not what the user says the data are.",
    inputSchema: {
      probe: z.enum(["xray", "neutron", "neutron-tof"]).optional(),
      wavelength: z.number().gt(0.1).lt(5).optional().describe("Å, for X-ray and constant-wavelength neutrons"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_resolution_range",
    title: "Set the resolution range",
    description:
      "Single-crystal page only. Fits only the reflections with d between `dMin` and `dMax` (Å), as SHELXL's SHEL; null opens that end. Its use is a test, made and undone: a high-order refinement (dMax 0.5–0.6 Å, the reflections extinction barely reaches) gives ADPs nearly free of the extinction model, so the extinction model whose all-data ADPs agree with them, and whose parameter stays put, describes the crystal; or a range the data cannot support, said why. Put the full range back (both null) before the final refinement; the report states any limit. Applies to the next refinement.",
    inputSchema: {
      dMin: z.number().positive().nullable().optional().describe("Smallest d fitted (Å); null: no limit"),
      dMax: z.number().positive().nullable().optional().describe("Largest d fitted (Å); null: no limit"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_extinction_model",
    title: "Set the extinction model",
    description:
      "Single-crystal page only. The extinction model: SHELXL's empirical EXTI (\"shelx\", the default), or Becker–Coppens secondary extinction as GSAS-II applies it — type I, where the mosaic spread limits it (\"bc-1-lorentzian\", \"bc-1-gaussian\"), or type II, where the domain size does (\"bc-2-lorentzian\", \"bc-2-gaussian\") — with each reflection's mean path length when the file gives it (TOPAZ). The parameter is another quantity under each model (x, Eg, Es), so it restarts at 0: refine it with the scale and what was free before, to convergence, then compare wR2, GooF and the lowest resolution shell and strongest bin of assess_refinement with the model before. Worth trying when the extinction is severe (y well below 0.5) and the strongest low-angle reflections are what is left in the residual; report the model chosen and why.",
    inputSchema: { model: z.enum(["shelx", "bc-1-lorentzian", "bc-1-gaussian", "bc-2-lorentzian", "bc-2-gaussian"]) },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_riding_hydrogens",
    title: "Ride the hydrogens",
    description:
      "Single-crystal page only. The riding model for hydrogen, as SHELXL's AFIX and as X-ray structures are published: each hydrogen follows the atoms it is bonded to, in its group's ideal geometry — an sp² X–H on the external bisector of its parent's two neighbours (AFIX 43); a methyl's (or NH₃'s) three hydrogens tetrahedral about the X–C axis and rotating: the group's torsion is a parameter (rot_C1, AFIX 137) to free with the positions; a hydroxyl's hydrogen likewise (AFIX 147); a CH₂ pair in the plane bisecting X–C–Y (AFIX 23); a tertiary C–H or N–H opposite its three neighbours (AFIX 13); a metal's hydrogen, or any other, at its present offset (AFIX 3) — with U_iso = 1.2·U_eq of the parent (1.5 for methyl and hydroxyl; `uFactor` sets one value for all), so it carries no parameter of its own. X–H: each group at its present distance; `temperature` (the measurement's, K) sets SHELXL's for each group (C–H 0.93 sp², 0.96 CH₃, 0.97 CH₂, 0.98 CH at room temperature, +0.01 Å below 253 K and +0.02 below 203 K; N–H 0.86–0.91; O–H 0.82); `distance` one value for all. `refine` names hydrogens whose positions the data determine (a hydride beside a metal, a hydrogen-bonded OH seen in the difference map): their positions refine — usually restrained (restrain_distances) — while their U_iso rides. `sharedU` gives a group of hydrogens one U_iso that refines instead of riding (SHELXL's free variable on the U column, as a .ins's 21.0 for every methyl hydrogen): a parameter B_shared_1 (fixed, freed with the ADPs) for the first list, B_shared_2 for the next. X-ray data cannot place a hydrogen on its own (one electron, displaced into its bond): ride them in an X-ray refinement before the heavy atoms go anisotropic, and say so in the report. Neutron data see the hydrogens as well as any atom and can refine them freely. The result lists the groups and the X–H distances as placed. `on: false` gives the hydrogens their own rows again (fixed, at the loaded positions). The parents come from the structure as refined now; the last fit is cleared.",
    inputSchema: {
      on: z.boolean(),
      uFactor: z.number().min(1).max(2).optional().describe("U_iso as this multiple of the parent's U_eq, for every hydrogen (default: 1.2, and 1.5 for methyl and hydroxyl)"),
      temperature: z.number().min(1).max(1000).optional().describe("The measurement's temperature (K): each group at SHELXL's X–H for it"),
      distance: z.number().min(0.8).max(1.3).optional().describe("X–H (Å) of every hydrogen placed in a group's geometry; default: each group at its present distance"),
      refine: z.array(z.string()).optional().describe("Hydrogens whose own positions refine (their U_iso still rides): [\"H1'\", \"H2'\"]"),
      sharedU: z.array(z.array(z.string()).min(1)).optional().describe("Groups of hydrogens whose U_iso refines in common rather than riding, one U_iso per list: name hydrogens by label, a whole geometry (\"methyl\", \"aromatic\", \"hydroxyl\", \"methylene\", \"methine\", \"fixed\", \"free\"), or \"all\": [[\"methyl\"]]"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "merge_equivalents",
    title: "Merge the equivalents",
    description:
      "Single-crystal page only. Fit the measurement's equivalents merged, as SHELXL merges them before it refines (MERG 2): each set of symmetry-equivalent measurements becomes one reflection, their mean weighted by 1/σ², its σ the larger of the propagated one and the spread. In a non-centrosymmetric group the Friedel opposites stay apart — their difference is the anomalous signal the absolute structure (the Flack x) rests on — and in a centrosymmetric one they merge with the rest. R1, wR2 and GooF are then on unique reflections, comparable with SHELXL's; R_int and the redundancy still read the measurement as loaded. For monochromatic data with equivalents measured (a SHELX .hkl, a CIF's own measurement); not for a time-of-flight Laue file (each measurement has its own wavelength and extinction) or a refinement's listing (merged already). Merge before the model is refined, so the fit and the outliers read the reflections SHELXL would. `on: false` fits every measurement again. The omissions are cleared (they named the other set's reflections), and so is the last fit.",
    inputSchema: {
      on: z.boolean(),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "restrain_distances",
    title: "Restrain distances",
    description:
      "Single-crystal page only. SHELXL's distance restraints: observations beside the data that hold a geometry the data alone place poorly — a hydride beside a heavy metal, hydrogens whose positions refine, a disordered fragment. `add` DFIX (each distance near `distance` Å) or SADI (the distances near one another), each with an esd `sigma` (SHELXL's default 0.02 Å; smaller holds tighter). A pair is two atom labels; the shorter contact between them is meant (its symmetry image found). Counted as SHELXL counts them: a DFIX one per distance; a SADI of two distances one, of more one per distance. `remove: true` clears them all; `remove` with pairs drops the restraints that name any of them. They change what the fit minimizes: refine again. assess_refinement lists each restraint's distances and its deviation in σ, and the report counts them. Restrain what the chemistry fixes and the data cannot; a restraint more than 3σ off says the data disagree with it.",
    inputSchema: {
      add: z.array(z.object({
        kind: z.enum(["dfix", "sadi"]),
        pairs: z.array(z.tuple([z.string(), z.string()])).min(1).describe("Atom pairs: [[\"Ga2\", \"H3'\"], [\"Ga2\", \"H4'\"]]"),
        distance: z.number().min(0.5).max(5).optional().describe("DFIX: the target distance (Å)"),
        sigma: z.number().min(0.001).max(0.5).optional().describe("The esd the distances are held to (Å; default 0.02)"),
      })).min(1).optional(),
      remove: z.union([z.literal(true), z.array(z.tuple([z.string(), z.string()])).min(1)]).optional().describe("true: every restraint; or the pairs whose restraints to drop"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_weighting",
    title: "Set the weighting scheme",
    description:
      "Single-crystal page only. SHELXL's weighting scheme WGHT a b: w = 1/[σ²(Fo²) + (aP)² + bP], P = (max(Fo², 0) + 2Fc²)/3, for the errors the file's σ do not carry (absorption, scaling, what no model describes). `use: \"suggested\"` takes the a and b SHELXL's criterion gives for the model as refined now — each of ten intensity bins' GooF nearest 1, the overall GooF left a little above 1 as SHELXL leaves it (assess_refinement shows them; SHELXL's own printed suggestion, from a coarser search, can differ by a few thousandths in a and up to about 0.2 in b); `use: \"sigma\"` goes back to w = 1/σ²; or give `a` and `b`. Set it LAST, when the model is complete (ADPs, extinction, hydrogens): weights fitted to an unfinished model hide its errors. Then refine once more (the weights follow Fc² and are re-evaluated until they settle). wR2 and GooF depend on the weights, R1 does not; the report states the scheme.",
    inputSchema: {
      use: z.enum(["suggested", "sigma"]).optional().describe("\"suggested\": the weights SHELXL's criterion suggests for the model as refined now; \"sigma\": w = 1/σ²"),
      a: z.number().min(0).max(0.5).optional(),
      b: z.number().min(0).optional(),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "set_twin",
    title: "Set the twin law",
    description:
      "Single-crystal page only. Twin domains, as SHELXL's TWIN and BASF. `law: \"inversion\"`: an inversion twin — in a non-centrosymmetric crystal, domains of both hands; its fraction is the Flack parameter x (0: the model's hand, 1: the inverted one, between: a twin, racemic near 0.5). It needs the Friedel pairs measured apart (reflection_statistics says) and an anomalous scatterer at the wavelength (X-rays at a tabulated line). Or a merohedral law as a 3×3 integer matrix, rows, h′ = R·h: a symmetry of the lattice the point group lacks ([[0,1,0],[1,0,0],[0,0,-1]] is common in trigonal and tetragonal crystals), for intensity statistics that read low (⟨|E²−1|⟩ well under 0.736), a law reflection_statistics' H-test reads a twin fraction for (`twinLaws`), or a fit that stalls with K drifting on the weakest reflections. The law brings its fraction (`twin_1`), free from 0.1: refine it with the structure, and report it with its esd; `remove: true` takes the law away. One law at a time, or a merohedral law `withInversion` (four domains, three fractions: SHELXL's TWIN R −4) when the crystal's hand is in question too; the last fit is cleared.",
    inputSchema: {
      law: z.union([z.literal("inversion"), z.array(z.array(z.number().int()).length(3)).length(3)]).optional().describe("\"inversion\" (h′ = −h), or a merohedral law: 3×3 integer matrix, rows, h′ = R·h"),
      withInversion: z.boolean().optional().describe("With a merohedral `law` in an acentric crystal: the inversion as well, four domains (SHELXL's TWIN R −4); the inverted domains' fractions add up to the Flack x"),
      remove: z.boolean().optional().describe("Take the twin law away"),
    },
    effect: "change",
    pages: ["singleCrystal"],
  },
  {
    name: "invert_structure",
    title: "Invert the structure",
    description:
      "Single-crystal page only. The model inverted through the origin — the other hand of an acentric structure, as SHELXL's MOVE 1 1 1 −1 with the space group changed by hand: every coordinate x → −x (plus the origin shift that I4₁, I4₁22, I4₁md, I4₁cd, I-42d, Fdd2 and F4₁32 need to keep their setting), and in the eleven enantiomorphic pairs the space group to its enantiomorph (P3₁ ↔ P3₂, P4₁ ↔ P4₃, P6₁ ↔ P6₅, P6₂ ↔ P6₄, P4₁32 ↔ P4₃32, …). For a Flack x near 1, the data preferring the other hand. The positions as refined, the riding groups (placed afresh), the restraints and every other row are kept; a twin with both hands keeps its fit (each domain takes the fraction of its inverse), a lone inversion twin's x becomes 1 − x, a merohedral law alone keeps its fraction. Refine again and compare the hands: the right one has x near 0 and the lower wR2 (Hamilton's test). Called again, it returns to the hand as loaded. A centrosymmetric group has no other hand. The last fit is cleared.",
    inputSchema: {},
    effect: "change",
    pages: ["singleCrystal"],
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
    withoutSkills:
      "Powder page only. Once the structure is refined to the best its group allows and the fit is still not good, read the REFINED residual at the reflections the space group forbids. Lists the forbidden reflections that still carry intensity and the subgroups of the same lattice that allow them (smallest index first, with their domain counts). Refuses until a refinement has converged: intensity differences on known reflections are what refinement fixes, so lowering the symmetry before refining to the best is wrong. The result is a proposal for the user: a lower group is a new model (its CIF), refined again from the start.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "diagnose_fit",
    title: "Diagnose the fit",
    description:
      "Powder page only. Why the fit on screen is not good, cause by cause, each with the share of χ² it carries and what to do: background (misfit between the peaks), peak positions (residual on one side of every peak: zero, cell, displacement), asymmetry (one-sided residual at low angle), peak width/shape (± lobes everywhere), intensity falling off with angle wrongly (a Wilson-type ΔB: ADPs, absorption, roughness), texture (intensity misfit following the angle to a low-index direction: preferred orientation), and what is left for the structure. Also the background-subtracted Rwp′, the Durbin–Watson statistic, χ² by d shell, and the reflections that carry the most χ². Call it when assess_refinement says the fit is poor or fair and you need to know what to free next; it reads the curves on screen, refined or not.",
    inputSchema: {},
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "set_corrections",
    title: "Set the corrections",
    description:
      "Powder page only. Switch sample and geometry corrections on or off, as the profile group's corrections boxes do: `asymmetry` (Finger–Cox–Jephcoat axial divergence, S/L and H/L; constant wavelength), `preferredOrientation` (March–Dollase along a reciprocal-lattice direction [h, k, l]; null turns it off), and `peak` — the set of displacement (flat plate, Δ2θ ∝ cosθ), transparency (flat plate, ∝ sin2θ), absorption (Debye–Scherrer μR, capillary), roughness (Suortti, flat-plate X-ray). Their rows come in fixed: free them with set_free and refine. Match the correction to the geometry and to what diagnose_fit found; they are polish after the structure, never a substitute for it.",
    inputSchema: {
      asymmetry: z.boolean().optional(),
      preferredOrientation: z.array(z.number().int()).length(3).nullable().optional().describe("[h, k, l], or null to turn texture off"),
      peak: z.array(z.enum(["displacement", "transparency", "absorption", "roughness"])).optional().describe("The full set of peak corrections wanted on (the others go off)"),
    },
    effect: "change",
    pages: ["powder"],
  },
  {
    name: "add_antisite",
    title: "Add antisite disorder",
    description:
      "Powder page only. Let two sites of different elements exchange their atoms: site B's element is added on site A and A's on B, at occupancy 0, each sharing its host's position and ADP, with the Shared site ties Σ occ = 1 and hold composition switched on — so the exchange refines as one fraction while the formula stays. Call it when the ADPs point at it (one site's B rails toward 0 while the other's is high: the first scatters more, the second less, than the ordered model has), on data with contrast between the two elements, after positions, profile and ADPs are refined. Then free the occupancies of both sites (set_free with the occ_ ids) and refine; report the exchange fraction with its esd, and how the ADPs moved. On data to a modest Q the exchange trades with the two sites' B values (both scale a site's scattering): the esd is then large, and further cycles drift along that valley — report the esd and the correlation, not just the value. Always asks the user.",
    inputSchema: {
      siteA: z.string().describe("Label of one site, e.g. W1"),
      siteB: z.string().describe("Label of the other site, e.g. Cr1"),
    },
    effect: "change",
    pages: ["powder"],
    alwaysAsk: true,
  },
  {
    name: "tie_parameters",
    title: "Tie parameters to one value",
    description:
      "Powder and single-crystal pages. Constrain parameters to one refined value, as a crystallographer does when the data cannot separate them or the chemistry says they are one: `equal` (ids or globs, the leader first) makes every other row take the leader's value and follow it, so only the leader refines; `release` undoes a tie (the row comes back fixed at its current value). For ADPs (B, or U on the single-crystal page) and occupancies. Tie when two values trade off rather than being measured: they swap between refinement paths at the same wR, an esd is as large as the value, or one B rails at 0 while its partner climbs — common below Q ≈ 6 Å⁻¹, and for light atoms beside heavy ones on X-rays. Tie chemically alike atoms (the cations of one oxide, all the oxygens, the H atoms), refine, and report the common value with its esd and why it is tied. A disorder (single-crystal page: the alternatives of one site, SHELXL's PART 1 and PART 2; get_state lists them): `complement` [A, B] makes B's occupancy 1 − A's (SHELXL's 21 and −21), so the split refines as one fraction — free A's occ_ row after it; `adp` [A, B] gives B the ADP of A, every U (or B) row (SHELXL's EADP), for alternatives too close to separate their displacements. Report the fraction with its esd. set_free skips tied rows.",
    inputSchema: {
      equal: z.array(z.string()).min(1).optional().describe("Ids or globs, the leader first: [\"B_W1\", \"B_Cr1\"], or [\"B_O*\"] (the first match leads)"),
      complement: z.tuple([z.string(), z.string()]).optional().describe("Single-crystal page: two occupancies (occ_ ids or site labels), the second = 1 − the first: [\"Al1\", \"Ga1\"]"),
      adp: z.array(z.string()).min(2).optional().describe("Single-crystal page: site labels, the first leads: every ADP row of the others follows its (EADP): [\"Al1\", \"Ga1\"]"),
      release: z.array(z.string()).min(1).optional().describe("Ids or globs of tied rows to release"),
    },
    effect: "change",
    pages: ["powder", "singleCrystal"],
  },
  {
    name: "sample_posterior",
    title: "Sample the Bayesian posterior",
    description:
      "Powder and PDF pages. The Bayesian check of a converged refinement: an ensemble MCMC (Goodman–Weare stretch moves over the worker pool) samples the posterior of the FREE parameters around the refined values and returns, per parameter, the median with 68 % and 95 % credible intervals, the posterior width over the least-squares esd (esdRatio), whether the interval ends on a bound, and the convergence (split-R̂, effective sample size); with the posterior correlations the data leave. Use it when a number is not convincing: an esd as large as the value, a parameter on a bound (B = 0, an occupancy at 1: the posterior gives a one-sided limit where the esd means nothing), a pair the correlation check flags, values that move between refinement paths at the same wR, or a physical claim resting on one parameter (an exchange fraction, a moment, a small distortion). esdRatio ≈ 1 confirms the esds; > 1.5 means they understate the uncertainty: quote the credible interval. `compare` gives the posterior of a difference (two B's, two occupancies, two moments) and the probability one is the larger: whether the data tell them apart. It quantifies uncertainty within the model and cannot fix a wrong one; with a systematic misfit (Durbin–Watson well below 2) it is as overconfident as the esds. Cost: each step evaluates the pattern 2·nFree+2 times, and the chain mixes more slowly with more free parameters (about 10⁴ steps at 20 free; a few thousand at 8–10): fix what does not correlate with the values in question (the profile, the background, the cell and zero usually), refine that set — the posterior is read against that refinement's esds — then sample. Not converged: call again with continue: true. Changes nothing in the model; the page shows the marginals in its Posterior view.",
    inputSchema: {
      continue: z.boolean().optional().describe("Resume the last run's chain (same problem) instead of starting a new one"),
      steps: z.number().int().min(50).max(5000).optional().describe("Ensemble steps this call (default 400)"),
      compare: z.array(z.tuple([z.string(), z.string()])).optional().describe("Pairs [a, b] of free parameter ids: the posterior of a − b and P(a > b) — do two B's, occupancies or moments differ?"),
    },
    effect: "read",
    pages: ["powder", "pdf"],
  },
  {
    name: "identify_peaks",
    title: "Identify extra peaks",
    description:
      "Powder page only. Match peaks no phase of the model explains against phases a pattern often holds besides the sample: the sample environment (Al can or cryostat shields, V, Cu, steels, Nb heat shields, Pb shielding), holders (corundum, graphite), standards (Si, LaB₆, CeO₂) and the synthesis impurities in its library, their lines computed for this radiation. Each phase may scale its d-spacings by up to ±1.5 % (cooling; a part off the sample position shifts its lines). Returns the candidates with the lines they explain and the strong lines they should also show. Uses the residual's unexplained peaks (find_unexplained_peaks), or the d-spacings you pass (e.g. the cell check's unindexed peaks). A lead to put to the user, not an identification; add_known_phase then adds a matched phase to the model.",
    inputSchema: {
      d: z.array(z.number().positive()).optional().describe("d-spacings (Å) to identify; default: the residual's unexplained peaks"),
    },
    effect: "read",
    pages: ["powder"],
  },
  {
    name: "add_known_phase",
    title: "Add a known phase",
    description:
      "Powder page only. Add one of identify_peaks' library phases (the sample environment, holders, line standards, and the synthesis impurities in its library) to the model as a further phase, with the library's room-temperature cell and positions and B ≈ 0.5 Å². Its scale and cell then refine with the others (free them with set_free; the cell first if identify_peaks found a d scale away from 1); report its weight fraction. Call it once identify_peaks has matched the unindexed peaks to it and the user agrees. A phase outside the library needs the user's CIF (Add CIF…). Always asks the user.",
    inputSchema: {
      name: z.string().describe("The phase as identify_peaks names it, e.g. \"CaF₂\""),
    },
    effect: "change",
    pages: ["powder"],
    alwaysAsk: true,
  },
  {
    name: "set_instrument_constants",
    title: "Set X-ray instrument constants",
    description:
      "Powder page, constant-wavelength X-ray only. The constants a fit cannot determine: the polarization fraction P of the Lorentz-polarization factor, (1−P)·cos²2θ + P (0.5 an unpolarized tube; ≈ 0.56 Cu Kα with a graphite monochromator; ≈ 0.9–0.95 a synchrotron), and a tube's Kα₂/Kα₁ intensity ratio (≈ 0.5). Neither is refined: P changes intensity smoothly with angle exactly as the ADPs do, so the fit cannot tell them apart and every B moves with it (fluorapatite on a Cu tube: P 0.7 → 0.5 lowered every B by ≈ 0.55 Å² at the same wR). Take them from the instrument; change them when the instrument file does not match the setup the user describes, or to show how much a result depends on them — then say so in the report. Always asks the user. Clears the last result.",
    inputSchema: {
      polarization: z.number().min(0.4).max(1).optional().describe("Polarization fraction P"),
      kAlpha2Ratio: z.number().min(0).max(1).optional().describe("Kα₂/Kα₁ intensity ratio"),
    },
    effect: "change",
    pages: ["powder"],
    alwaysAsk: true,
  },
  {
    name: "structure_table",
    title: "The refined structure",
    description:
      "The refined structure as it is reported: per phase the cell (a, b, c, angles, volume) and per site the fractional coordinates, occupancy and B_iso (U_eq when anisotropic), each as value(esd) in the last digits, from the last refinement's esds (no esd on a fixed value; a cell held fixed carries the structure file's esds, SHELXL's ZERR or a CIF's su, and the volume's from them). Call it for the final report, or to compare with a published structure; get_state shows parameter shifts, not coordinates. On the single-crystal page, `against: \"loaded\"` compares each site with the structure as loaded (a published refinement's CIF): its shift in Å and in esds, and its U_eq against the loaded one, listing the sites beyond 2 esds.",
    inputSchema: {
      against: z.enum(["loaded"]).optional().describe("Single-crystal page: compare with the structure as loaded"),
    },
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
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
      "Powder page only. Search commensurate propagation vectors k (denominators 2, 3, 4, 6, and k = 0, whose magnetic peaks can sit on reflections the space group forbids) that put magnetic reflections G ± k on the residual peaks the k-search uses (magnetic_state lists them, numbered; peaks on allowed nuclear reflections are left out). Ranked by how many peaks each explains and how closely. Leave out lines already identified as not magnetic — the sample environment, an impurity, a line present above the ordering temperature — with `exclude` (their numbers), as the peak table's check boxes do; `include` puts a peak in. Shows the list on the magnetic step. It does not set k: set_propagation_vector does.",
    inputSchema: {
      exclude: z.array(z.number().int().positive()).optional().describe("Numbers of residual peaks to leave out of the search (magnetic_state's residualPeaks n)"),
      include: z.array(z.number().int().positive()).optional().describe("Numbers of residual peaks to put into the search"),
    },
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
      "Powder page only. Fit the moments of each magnetic group that allows a moment (the nuclear model held) and rank them by wR: `scope` \"open\" (default) fits the groups in the index sections open on the page (the maximal, index-2 groups at first: the top-down start), \"all\" every group. Each group is fitted from its seed moments and from `restarts` kicked starts (default 12), the best kept: magnetic intensity is quadratic in the moments, so one fit can stop in a minimum with a sublattice switched off. Returns the fitted groups, best first, with the best marked (ties go to the maximal group with the fewest moment parameters). Several seconds per group.",
    inputSchema: {
      scope: z.enum(["open", "all"]).optional(),
      restarts: z.number().int().min(0).max(32).optional().describe("Kicked restarts per group beyond the seeded fit (default 12; 0 = one fit)"),
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
      "Nearest-neighbour bond lengths (Å) of a phase at the current parameter values, shortest first (at most 40: `atoms` lists only the bonds to the sites named, for a molecule with more), and each cation's bond-valence sum against its oxidation state (oxides and fluorides; the CIF's type symbol gives the state, else the tabulated state closest to the sum is assumed). The plausibility check after refining positions: an impossibly short contact, or a sum more than ~15 % from the valence, means a wrong position, a wrong element on the site, or a strained or mixed-valent site. A riding hydrogen's bond is set by the constraint and carries no esd.",
    inputSchema: {
      cutoff: z.number().positive().max(8).optional().describe("Longest bond listed, Å (default 3.2)"),
      phase: z.string().optional().describe("Phase id (get_state lists them); default the primary phase"),
      atoms: z.array(z.string()).optional().describe("Only the bonds to these sites (labels)"),
    },
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
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
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "allow_exception",
    title: "Allow an exception to the method",
    description:
      "Ask the user to lift one of their method's firm rules for this analysis, when refine refused on it and the user wants to go on regardless: \"bare-occupancy\" (refine an occupancy with no tie, because a second contrast — anomalous X-ray, isotopic neutron — determines it), or \"instrument-with-thermal\" (refine the instrument's terms — the zero, the peak shape and asymmetry, Qdamp/Qbroad — together with the B values or ADPs, which the user's method alternates). Only when the user asks for it, never to get past a refusal. Always shows the user an approval card, even in Auto; only they can approve it. Give their reason in `reason`. Lasts until the data or the phases change.",
    inputSchema: {
      rule: z.enum(["bare-occupancy", "instrument-with-thermal"]),
      reason: z.string().min(3).describe("Why the rule does not apply here, in the user's terms"),
    },
    effect: "change",
    pages: ["powder", "pdf", "singleCrystal"],
    alwaysAsk: true,
  },
  {
    name: "write_note",
    title: "Note it for this analysis",
    description:
      "Keep one short note in this analysis's record, which is saved with the project: a finding that should outlast this conversation (an absence the cell check flagged, to revisit at the symmetry review; a correlation that forced a choice, an impurity identified) or a decision the user made and why (hold the composition; the minor phase is MnO; keep Qdamp from the Ni standard). get_state lists the notes, so they carry into the next conversation and the next session. One fact per note, a sentence or two; not for narrating progress. An engine number by reference ({{wR}}, {{p:ID}}) is filled in as it stands when the note is written.",
    inputSchema: {
      text: z.string().min(3).max(400).describe("The note, in a sentence or two"),
    },
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "write_report",
    title: "Write the analysis report",
    description:
      "Write the analysis report and open it for the user, who can save it as HTML, Markdown or PDF, with the CIF. It holds what the page's own report holds — the data and the model, the fit figure, the refined structure with esds, every parameter, the agreement factors and the diagnostics — and the analysis as you ran it: the History's steps on the path to the result (what each refinement freed, and the method stage that is the reason), the method's checklist, the engine's checks (convergence, agreement, correlations, bounds, residual peaks, serial correlation, bond valences, the cell check and symmetry review) with the issues left open, the Bayesian check if you ran sample_posterior on this refinement, and your notes. Every number in it comes from the engine and the History. You write only `summary`, your own account, which the report labels as yours. Quote the engine's numbers by reference ({{wR2}}, {{Rwp}}, {{verdict}}, {{p:ID}}; get_state lists them): the app fills them in from the engine, and refuses a reference that names nothing the page has. Any decimal number you type yourself is checked against the numbers the report computed: one that matches none is underlined in the report and listed in the answer — correct it (get_state, structure_table) and call again, or leave it out. Call it when the analysis is done and you have reported, or when the user asks for the report.",
    withoutSkills:
      "Write the analysis report and open it for the user, who can save it as HTML, Markdown or PDF, with the CIF. It holds what the page's own report holds — the data and the model, the fit figure, the refined structure with esds, every parameter, the agreement factors and the diagnostics — and the analysis as you ran it: the History's steps on the path to the result (what each refinement freed), the engine's checks (convergence, agreement, correlations, bounds, residual peaks, serial correlation, bond valences, the cell check and symmetry review) with the issues left open, the Bayesian check if you ran sample_posterior on this refinement, and your notes. Every number in it comes from the engine and the History. You write only `summary`, your own account, which the report labels as yours. Quote the engine's numbers by reference ({{wR2}}, {{Rwp}}, {{verdict}}, {{p:ID}}; get_state lists them): the app fills them in from the engine, and refuses a reference that names nothing the page has. Any decimal number you type yourself is checked against the numbers the report computed: one that matches none is underlined in the report and listed in the answer — correct it (get_state, structure_table) and call again, or leave it out. Call it when the analysis is done and you have reported, or when the user asks for the report.",
    inputSchema: {
      summary: z.string().min(20).max(6000).describe(
        "Your account, in plain prose, one to four short paragraphs separated by blank lines: what you did and why, what the result shows about the structure, its caveats, and what is left open. The engine's numbers by reference ({{wR2}}, {{p:ID}}); any other number exactly as the tools gave it (or rounded from it); add none of your own.",
      ),
    },
    effect: "read",
    pages: ["powder", "pdf", "singleCrystal"],
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
    pages: ["powder", "pdf", "singleCrystal"],
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
    pages: ["powder", "pdf", "singleCrystal"],
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
      "Switch the primary phase's atomic displacement model between isotropic (one B_iso / U per site) and anisotropic (the symmetry-allowed U tensor components), seeded from the current refined values. New rows start fixed — free them with set_free. A CIF with U_aniso columns loads anisotropic (get_state says which): on the PDF page a small-box fit usually refines one U per site. Anisotropic ADPs need good data; they are the last structural step. On the single-crystal page with X-ray data the hydrogens stay isotropic (one electron, displaced into its bond, defines no tensor); with neutrons they follow.",
    inputSchema: { anisotropic: z.boolean() },
    effect: "change",
    pages: ["powder", "pdf", "singleCrystal"],
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
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "boxcar_scan",
    title: "Boxcar scan",
    description:
      "PDF page only. The way to answer whether the local structure differs from the average one — not the full fit, nor bond_geometry, which give the average only. The r-resolved view of the current model: a box of fixed width slid across the fit window, the FREE parameters refined in each box (seeded from the previous one), as the page's Boxcar view does — the user watches it there. It answers whether the local structure differs from the average: Rw and parameters that drift between low and high r. The parameter rows are left as they are (a diagnostic, not a fit). Returns, per box, its r range, Rw and the free parameters' values, and each parameter's spread; with `bonds`, also those sites' bond lengths per box and each bond's spread — a distortion read as lengths, not coordinate shifts. Takes about one refinement per box. Pass `free` for a scan's own small set (scale, cell, the parameters in question): the page keeps its free set and its fit, so the report that follows still matches them.",
    inputSchema: {
      width: z.number().positive().optional().describe("Box width in Å (default 5)"),
      step: z.number().positive().optional().describe("Advance between boxes in Å (default 1; width/2 gives half-overlapping boxes)"),
      direction: z.enum(["up", "down", "both"]).optional().describe("Walk low → high r (default), high → low, or both (path dependence shows as a gap)"),
      free: ids.optional().describe("The parameters each box refines (ids or globs), for this scan only; default the page's free set. The page's own free set and fit are left as they are."),
      bonds: z.array(z.string()).max(4).optional().describe("Site labels (e.g. [\"Mn1\"]) whose bond lengths each box reports, from the structure that box refined: the local geometry box by box"),
    },
    effect: "change",
    pages: ["pdf"],
  },
  {
    name: "reset_parameters",
    title: "Reset to starting values",
    description: "Put parameters back to their starting values (the values the model was loaded with) and clear the result: `parameters` (ids or globs) for only those — e.g. a profile term that refined to an unphysical value — or every parameter when omitted (the Reset control). Recorded as a step, so it can be undone. It sets no value of your choosing.",
    inputSchema: {
      parameters: ids.optional().describe("Only these parameters (ids or globs); omit for all"),
    },
    effect: "change",
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "go_to_step",
    title: "Go to a step",
    description:
      "Return the analysis to an earlier step of the history (get_state lists recent ones; ids look like \"s7\"), as clicking it in History does. Nothing is lost: the steps after it stay in the tree as a branch.",
    inputSchema: { step: z.string().regex(/^s\d+$/).describe("Step id, e.g. \"s7\"") },
    effect: "change",
    pages: ["powder", "pdf", "singleCrystal"],
  },
  {
    name: "cancel_refinement",
    title: "Cancel the running refinement",
    description: "Stop a refinement that is running. The parameters keep their values from before it started.",
    inputSchema: {},
    effect: "control",
    pages: ["powder", "pdf", "singleCrystal"],
  },
];

export const PAGE_LABEL: Readonly<Record<AgentPage, string>> = { powder: "powder", pdf: "PDF", singleCrystal: "single-crystal" };

export function liveTool(name: string): LiveToolSpec | undefined {
  return LIVE_TOOLS.find((t) => t.name === name);
}

/** The JSON Schema of a tool's input, for an LLM API or an MCP client. */
export function inputJsonSchema(spec: LiveToolSpec): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(spec.inputSchema).strict()) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
