/**
 * MCP tool handlers over the pure refinement core — the callable surface an
 * agent uses to run refinement the way a crystallographer does: parse → build →
 * refine → **assess** → **suggest** → **interpret**.
 *
 * Every handler is a pure function (JSON args → JSON result) with no MCP
 * dependency, so they are unit-testable directly; `server.ts` only adds the
 * stdio transport and schemas. The domain models are methods-free data (the same
 * constraint the Web Worker protocol enforces), so they cross the tool boundary
 * unchanged. Statelessness is deliberate: an agent threads the structure /
 * pattern / result through calls, so every agent-driven run is reproducible by
 * replaying the same tool calls (see docs/AGENT_TOOLS.md).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern, PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { LinearRestraint, ParameterBinding, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MagneticModel } from "@/core/magnetic/types";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parsePdfData } from "@/parsers/pdfData";
import { detectDataFormat } from "@/parsers/detectFormat";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { buildPowderSpec, type MustrainModel } from "@/app/powderSpec";
import { runPowderRefinement, runPdfRefinement } from "@/workers/runPowder";
import { powderCurves } from "@/core/workflow/powder";
import {
  buildPdfSpec,
  buildMultiPhasePdfSpec,
  buildPdfProblem,
  pdfCurves,
  multiPhasePdfCurves,
  pdfPartialCurves,
  pdfPhaseCurves,
  optimalPdfScale,
  correlatedMotionConflict,
  PDF_STAGE_KINDS,
} from "@/core/workflow/pdf";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { computeAgreementFactors, excludedPointMask, weightsFromSigma } from "@/core/refinement/factors";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import { generateReflections } from "@/core/diffraction/reflections";
import { abscissaFromD } from "@/core/diffraction/instrument";
import { bondLengths } from "@/core/crystal/geometry";
import { analyzeSiteSymmetry, type SiteSymmetry } from "@/core/crystal/siteSymmetry";
import { classifyPointGroup } from "@/core/crystal/pointGroup";
import { detectExtraPeaks, type ExtraPeakOptions } from "@/core/magnetic/extraPeaks";
import { searchPropagationVector, type KSearchOptions } from "@/core/magnetic/kSearch";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { rankNextParameterGroups } from "@/core/workflow/nextParameters";
import { buildPowderProblem } from "@/core/workflow/powder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildDistortionModes, buildSymmetryModes } from "@/core/crystal/distortionModes";
import { refine, refineParallel } from "@/core/refinement/engine";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { parseFullProfInt, looksLikeFullProfInt, writeFullProfInt } from "@/parsers/fullprofInt";
import { parseHkl } from "@/parsers/hkl";
import {
  mergeToMagneticSupercell,
  expandStructureToSupercell,
  buildModulatedMomentModel,
  type ModulatedIon,
} from "@/core/magnetic/magneticSupercell";
import { createNodeEvaluatorPool } from "@/mcp/nodeEvaluator";
import {
  samplePosterior,
  samplePosteriorParallel,
  type SampleResult,
  type WalkerState,
} from "@/core/refinement/bayes/sampler";
import type { NoiseModel, PriorSpec } from "@/core/refinement/bayes/logPosterior";
import { buildProblemForSpec } from "@/workers/runPowder";
import type { EvaluatorSpec } from "@/workers/protocol";
import type { SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PeakShape } from "@/core/diffraction/profile";
import {
  assessRefinement,
  suggestNextSteps,
  type RefinementAssessment,
} from "@/core/diagnostics/assessment";
import { interpretStructure } from "@/core/diagnostics/interpret";

const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };

/** Parse a CIF/mCIF into a structure (and magnetic model, when present). */
export function parse_structure(args: { cif: string; id?: string }): { structure: StructureModel; magnetic: MagneticModel | null } {
  const { structure, magnetic } = parseMagneticCif(args.cif, args.id ?? "loaded");
  return { structure, magnetic: magnetic ?? null };
}

/** Classify + parse powder data; returns the pattern and how the format was detected. */
export function parse_powder_data(args: { text: string; filename?: string }): {
  detected: { dataType: string; xUnit?: string; source: string; confidence: string; note?: string };
  pattern: PowderPattern;
  summary: { points: number; xUnit: string; xMin: number; xMax: number; radiation: string };
} {
  const fmt = detectDataFormat({ text: args.text, filename: args.filename ?? "data" });
  if (fmt.dataType !== "powder") throw new Error(`detected ${fmt.dataType} data, not powder — use the single-crystal path`);
  const pattern = parsePowderData(args.text, {
    id: "data",
    name: args.filename ?? "data",
    xUnit: fmt.xUnit,
    radiation: fmt.radiation,
    ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}),
  });
  const xs = pattern.points.map((p) => p.x);
  return {
    detected: { dataType: fmt.dataType, ...(fmt.xUnit ? { xUnit: fmt.xUnit } : {}), source: fmt.source, confidence: fmt.confidence, ...(fmt.note ? { note: fmt.note } : {}) },
    pattern,
    summary: { points: pattern.points.length, xUnit: pattern.xUnit, xMin: Math.min(...xs), xMax: Math.max(...xs), radiation: pattern.radiation.kind },
  };
}

/** Parse an instrument-parameter file (.instprm / .prm / .irf) into a CW or TOF calibration. */
export function parse_instrument(args: { text: string }): InstrumentParameters {
  return parseInstrumentParameters(args.text);
}

/**
 * Build the symmetry-allowed refinement parameter set + bindings + profile for a
 * structure/pattern. Only symmetry-allowed parameters are created, so the agent
 * literally cannot free a forbidden one — the search space is pre-pruned.
 */
export function build_refinement(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  instrument?: InstrumentParameters;
  backgroundTerms?: number;
  mustrain?: MustrainModel;
}): { parameters: RefinementParameter[]; bindings: ParameterBinding[]; profile: PowderProfile; freeCount: number } {
  const spec = buildPowderSpec(
    args.structure,
    args.pattern,
    args.instrument ?? DEFAULT_INSTRUMENT,
    true,
    args.backgroundTerms ?? 4,
    {},
    args.mustrain ?? "isotropic",
  );
  return {
    parameters: spec.params,
    bindings: spec.bindings,
    profile: spec.profile,
    freeCount: spec.params.filter((p) => !p.fixed && !p.expression).length,
  };
}

/**
 * Run a constrained least-squares refinement of the given (freed) parameters.
 * The numerical optimization is the deterministic Levenberg–Marquardt engine —
 * the agent chooses *what* to free, never the values. Returns the full result
 * (refined values, esds, agreement, and the SVD/correlation/at-bound
 * diagnostics) plus the observation count and residual for `assess_refinement`.
 */
export async function refine_powder(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  instrument?: InstrumentParameters;
  extraPhases?: StructureModel[];
  staged?: boolean;
  fitRange?: { min: number; max: number };
  maxIterations?: number;
}): Promise<{ result: RefinementResult; observationCount: number; residual: { d: number[]; yObs: number[]; yCalc: number[] }; parallel: { workers: number } | null }> {
  const shape: PeakShape = args.profile.shape;
  const options = { maxIterations: args.maxIterations ?? 20 };

  // Parallel fast path (flat single-phase): the Jacobian columns fan out over
  // a node worker-thread pool when the runtime supports it (the bundled MCP
  // server does; vitest/vite-node fall back to the serial driver). The
  // trajectory is bit-identical either way — see engineParallel.test.ts.
  let parallel: { workers: number } | null = null;
  let result: RefinementResult | null = null;
  const flat = !args.staged && (!args.extraPhases || args.extraPhases.length === 0);
  if (flat) {
    const spec: EvaluatorSpec = {
      kind: "powder",
      structure: args.structure,
      pattern: args.pattern,
      parameters: args.parameters,
      bindings: args.bindings,
      shape,
      ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}),
      ...(args.profile.lorentz !== undefined ? { lorentz: args.profile.lorentz } : {}),
      ...(args.profile.backgroundType !== undefined ? { backgroundType: args.profile.backgroundType } : {}),
      ...(args.fitRange ? { fitRange: args.fitRange } : {}),
    };
    const pool = await createNodeEvaluatorPool(spec);
    if (pool) {
      try {
        result = await refineParallel(buildProblemForSpec(spec), options, pool);
        parallel = { workers: pool.size };
      } finally {
        await pool.dispose();
      }
    }
  }
  if (!result) {
    result = runPowderRefinement({
      type: "refinePowder",
      requestId: 0,
      structure: args.structure,
      ...(args.extraPhases && args.extraPhases.length ? { extraPhases: args.extraPhases } : {}),
      pattern: args.pattern,
      parameters: args.parameters,
      bindings: args.bindings,
      shape,
      ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}),
      ...(args.profile.lorentz !== undefined ? { lorentz: args.profile.lorentz } : {}),
      ...(args.profile.backgroundType !== undefined ? { backgroundType: args.profile.backgroundType } : {}),
      ...(args.fitRange ? { fitRange: args.fitRange } : {}),
      options,
    });
  }

  // Residual (obs − calc) as d-spacing arrays, so assess_refinement can scan the
  // positive residual for the missing-phase / magnetic-order signal.
  const refined = args.parameters.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  const curves = powderCurves(args.structure, args.pattern, refined, args.bindings, args.profile);
  const ctx = axisContext(args.pattern, args.instrument);
  const d = args.pattern.xUnit === "dSpacing" ? [...curves.x] : convertAxisArray(curves.x, args.pattern.xUnit, "dSpacing", ctx);
  const excluded = excludedPointMask(curves.yObs);
  const observationCount = excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0);
  return { result, observationCount, residual: { d, yObs: [...curves.yObs], yCalc: [...curves.yCalc] }, parallel };
}

/**
 * The judgment tool: turn a refinement result into the structured "what matters"
 * an expert reads off it — trust verdict, dangerous correlations, at-bound and
 * unphysical parameters, ill-conditioning, over/under-parameterization, and
 * unexplained residual peaks (the missing-phase / magnetic-order signal).
 */
export function assess_refinement(args: {
  result: RefinementResult;
  parameters: RefinementParameter[];
  observationCount: number;
  residual?: { d: number[]; yObs: number[]; yCalc: number[] };
  mode?: "powder" | "single-crystal";
}): RefinementAssessment {
  return assessRefinement({
    result: args.result,
    parameters: args.parameters,
    observationCount: args.observationCount,
    ...(args.residual ? { residual: args.residual } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  });
}

/** The decision tool: rank the next actions given an assessment (sequencing only). */
export function suggest_next_steps(args: { assessment: RefinementAssessment }): ReturnType<typeof suggestNextSteps> {
  return suggestNextSteps(args.assessment);
}

/**
 * Evaluate the calculated pattern at the CURRENT parameter values — no
 * refinement. The cheap what-if tool: change a value (or a moment), evaluate,
 * compare wR. With a magnetic model the nuclear and magnetic components come
 * back separately, so an agent can see what the moments alone contribute.
 */
export function evaluate_pattern(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  magnetic?: MagneticModel | null;
}): {
  curves: { x: number[]; yObs: number[]; yCalc: number[]; diff: number[]; yNuclear?: number[]; yMagnetic?: number[] };
  agreement: { wR: number; rFactor: number; goodnessOfFit: number | null };
  observationCount: number;
} {
  const curves = args.magnetic
    ? magneticPowderComponents(args.structure, args.magnetic, args.pattern, args.parameters, args.bindings, { shape: args.profile.shape, ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}) })
    : powderCurves(args.structure, args.pattern, args.parameters, args.bindings, args.profile);
  // Poisson fallback with the standard 1-count floor: σ = √max(N, 1). Without
  // the floor a near-zero intensity (e.g. the background of a simulated
  // pattern) gets an exploding weight and poisons the agreement sums.
  const weights = weightsFromSigma(args.pattern.points.map((p) => p.sigma ?? Math.sqrt(Math.max(p.yObs, 1))));
  const nFree = args.parameters.filter((p) => !p.fixed && !p.expression).length;
  const a = computeAgreementFactors(Float64Array.from(curves.yObs), Float64Array.from(curves.yCalc), weights, nFree);
  const excluded = excludedPointMask(curves.yObs);
  return {
    curves: {
      x: [...curves.x],
      yObs: [...curves.yObs],
      yCalc: [...curves.yCalc],
      diff: curves.yObs.map((o, i) => o - (curves.yCalc[i] ?? 0)),
      ...("yNuclear" in curves ? { yNuclear: [...curves.yNuclear] } : {}),
      ...("yMagnetic" in curves ? { yMagnetic: [...curves.yMagnetic] } : {}),
    },
    agreement: { wR: 100 * (a.rWeighted ?? 0), rFactor: 100 * a.rFactor, goodnessOfFit: a.goodnessOfFit ?? null },
    observationCount: excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0),
  };
}

/**
 * Simulate the powder pattern of a structure alone — "what would this phase
 * look like on this instrument?" Used for planning, phase identification by
 * eye, and generating a reference before any data is loaded. The grid follows
 * the instrument (2θ for CW, µs for TOF) unless an explicit range is given.
 */
export function simulate_pattern(args: {
  structure: StructureModel;
  instrument?: InstrumentParameters;
  xMin?: number;
  xMax?: number;
  points?: number;
  scale?: number;
  magnetic?: MagneticModel | null;
}): {
  xUnit: string;
  curves: { x: number[]; yCalc: number[]; yNuclear?: number[]; yMagnetic?: number[] };
  summary: { points: number; xMin: number; xMax: number };
} {
  const instrument = args.instrument ?? DEFAULT_INSTRUMENT;
  const isTof = instrument.kind === "tof";
  // Default window: CW 5–120° 2θ; TOF the d = 0.6–6 Å band of the calibration.
  const xMin = args.xMin ?? (isTof ? abscissaFromD(instrument, 0.6) : 5);
  const xMax = args.xMax ?? (isTof ? abscissaFromD(instrument, 6) : 120);
  const n = Math.min(Math.max(args.points ?? 4000, 100), 20000);
  const grid = Array.from({ length: n }, (_, i) => xMin + (i * (xMax - xMin)) / (n - 1));
  const pattern: PowderPattern = {
    id: "sim",
    name: "simulated",
    xUnit: isTof ? "tof" : "twoTheta",
    radiation: isTof ? { kind: "neutron-tof" } : { kind: instrument.radiationKind === "neutron" ? "neutron" : "xray", wavelength: instrument.wavelength },
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const spec = buildPowderSpec(args.structure, pattern, instrument, true, 1, {});
  // The spec seeds scale against observed data (zeros here) and a background;
  // a simulation wants a clean pattern: unit scale, zero background.
  const params = spec.params.map((p) =>
    p.kind === "scale" ? { ...p, value: args.scale ?? 1 } : p.kind === "background" ? { ...p, value: 0 } : p,
  );
  const curves = args.magnetic
    ? magneticPowderComponents(args.structure, args.magnetic, pattern, params, spec.bindings, { shape: spec.profile.shape, ...(spec.profile.eta !== undefined ? { eta: spec.profile.eta } : {}) })
    : powderCurves(args.structure, pattern, params, spec.bindings, spec.profile);
  return {
    xUnit: pattern.xUnit,
    curves: {
      x: [...curves.x],
      yCalc: [...curves.yCalc],
      ...("yNuclear" in curves ? { yNuclear: [...curves.yNuclear] } : {}),
      ...("yMagnetic" in curves ? { yMagnetic: [...curves.yMagnetic] } : {}),
    },
    summary: { points: n, xMin, xMax },
  };
}

/**
 * The reflection list: unique hkl families with d-spacing and multiplicity for
 * a structure, optionally with the instrument-frame position (2θ or TOF µs).
 * `absences: false` keeps nuclear-extinct families — where AFM magnetic
 * satellites live (see the FeCoSn golden case).
 */
export function reflection_list(args: {
  structure: StructureModel;
  dMin?: number;
  dMax?: number;
  absences?: boolean;
  instrument?: InstrumentParameters;
}): { reflections: { h: number; k: number; l: number; d: number; multiplicity: number; x?: number }[]; count: number } {
  const refs = generateReflections(
    args.structure.cell,
    args.structure.spaceGroup,
    args.dMin ?? 0.8,
    args.dMax ?? 10,
    { absences: args.absences ?? true },
  );
  const reflections = refs.map((r) => ({
    h: r.h, k: r.k, l: r.l, d: r.d, multiplicity: r.multiplicity,
    ...(args.instrument ? { x: abscissaFromD(args.instrument, r.d) } : {}),
  }));
  return { reflections, count: reflections.length };
}

/**
 * Bond-length sanity: nearest-neighbour distances (Å) up to a cutoff, from the
 * symmetry-expanded structure. The physical-plausibility check an expert runs
 * after refining positions (a 1.2 Å metal–metal contact means the refinement
 * went somewhere wrong).
 */
export function bond_geometry(args: { structure: StructureModel; cutoff?: number }): {
  bonds: { from: string; to: string; distance: number }[];
  shortest: { from: string; to: string; distance: number } | null;
} {
  const bonds = bondLengths(args.structure, args.cutoff ?? 3.2);
  return { bonds, shortest: bonds[0] ?? null };
}

/**
 * Per-site symmetry: for each atom, its multiplicity, point-group site symmetry,
 * and the symmetry-allowed refinable degrees of freedom (free positional
 * coordinates, anisotropic-ADP components, and magnetic-moment components). The
 * parameterization guardrail — read this before freeing coordinates or moments so
 * you never fight a symmetry constraint (e.g. an atom on a fixed special position
 * has 0 free coordinates; a site with `allowedMomentComponents: 0` cannot carry a
 * moment). Also reports the crystal's overall point group.
 */
export function analyze_site_symmetry(args: { structure: StructureModel }): {
  crystalPointGroup: string | null;
  sites: SiteSymmetry[];
} {
  return {
    crystalPointGroup: classifyPointGroup(args.structure.spaceGroup.operations).symbol,
    sites: analyzeSiteSymmetry(args.structure),
  };
}

/**
 * Find unexplained residual peaks (obs − calc) after a nuclear refinement —
 * the "is there magnetic order / an impurity?" signal. Robust (MAD-based)
 * thresholding; a handful of peaks suggests satellites, dozens mean the
 * nuclear fit itself is poor.
 */
export function find_unexplained_peaks(args: {
  residual: { d: number[]; yObs: number[]; yCalc: number[] };
  options?: ExtraPeakOptions;
}): { peaks: { d: number; height: number }[]; count: number } {
  const peaks = detectExtraPeaks(args.residual.d, args.residual.yObs, args.residual.yCalc, args.options ?? {});
  return { peaks: [...peaks], count: peaks.length };
}

/**
 * Rank candidate propagation vectors k (commensurate, denominators 2/3/4/6)
 * by how many unexplained peaks their satellites G ± k explain. The k-search
 * step of magnetic structure solution.
 */
export function search_propagation_vector(args: {
  structure: StructureModel;
  peakD: number[];
  options?: KSearchOptions;
}): { candidates: { k: Vec3; label: string; matched: number; total: number; rmsd: number; score: number }[] } {
  const candidates = searchPropagationVector(args.structure.cell, args.peakD, args.options ?? {});
  return { candidates: candidates.map((c) => ({ ...c })) };
}

/**
 * Enumerate the maximal magnetic subgroup candidates of the parent group for a
 * propagation vector k — conjugacy-class representatives with their BNS
 * identification, subgroup index, and domain count. The operations of the
 * chosen candidate feed allowed_moments / build_magnetic_model.
 */
export function list_magnetic_subgroups(args: {
  structure: StructureModel;
  k?: Vec3;
  maxIndex?: number;
}): {
  candidates: {
    label: string;
    bns: string | null;
    index: number;
    domainCount: number;
    operations: SymmetryOperation[];
  }[];
} {
  const reps = latticeRepresentatives(
    magneticSubgroupLattice(args.structure.spaceGroup.operations, args.k ?? [0, 0, 0], { maxIndex: args.maxIndex ?? 8 }),
  );
  return {
    candidates: reps.map((r) => ({
      label: r.candidate.label,
      bns: r.candidate.standard?.bnsSymbol ?? r.settingMatch?.identity.bnsSymbol ?? null,
      index: r.index,
      domainCount: r.domainCount,
      operations: [...r.candidate.operations],
    })),
  };
}

/**
 * The site-symmetry analysis: which moment directions the magnetic group
 * allows on each site (the null space of the magnetic stabilizer). Dimension
 * 0 means the moment is symmetry-forbidden there; the basis spans what a
 * refinement may vary. Matches GSAS-II's per-site "site sym" moment rules.
 */
export function allowed_moments(args: {
  structure: StructureModel;
  operations?: SymmetryOperation[];
  k?: Vec3;
  siteLabels?: string[];
}): { sites: { label: string; element: string; dimension: number; basis: Vec3[] }[] } {
  const ops = args.operations ?? args.structure.spaceGroup.operations;
  const wanted = args.siteLabels ? new Set(args.siteLabels) : null;
  const sites = args.structure.sites
    .filter((s) => !wanted || wanted.has(s.label))
    .map((s) => {
      const allowed = allowedMomentDirections(ops, s.position, args.k ?? [0, 0, 0]);
      return { label: s.label, element: s.element, dimension: allowed.dimension, basis: allowed.basis.map((b) => [...b] as Vec3) };
    });
  return { sites };
}

/**
 * Build the symmetry-allowed magnetic model for chosen ion sites under a
 * magnetic subgroup: moment-mode amplitude parameters over the allowed
 * directions only, co-located (occupancy-disorder) ions tied to one moment,
 * split orbits handled as independent sublattices. The refinement cannot
 * leave the symmetry-allowed space by construction.
 */
export function build_magnetic_model(args: {
  structure: StructureModel;
  ionLabels: string[];
  operations?: SymmetryOperation[];
  k?: Vec3;
  moment?: number;
  tieSameSite?: boolean;
}): { magnetic: MagneticModel; parameters: RefinementParameter[]; bindings: ParameterBinding[]; activeSites: string[] } {
  const build = buildMagneticModel(
    args.structure,
    args.k ?? [0, 0, 0],
    args.ionLabels,
    args.operations ?? args.structure.spaceGroup.operations,
    {
      ...(args.moment !== undefined ? { moment: args.moment } : {}),
      ...(args.tieSameSite !== undefined ? { tieSameSite: args.tieSameSite } : {}),
    },
  );
  return { magnetic: build.magnetic, parameters: build.params, bindings: build.bindings, activeSites: build.activeSites };
}

/**
 * Co-refine nuclear + magnetic against a powder pattern. Staged by default —
 * scale + background converge with moments and profile held, then everything
 * requested is freed — because a flat co-refinement from a poor moment start
 * can collapse the scale against exploding moments (the scale·|m|² valley;
 * both golden datasets showed it). Returns the result, the refined magnetic
 * model, and the separated nuclear/magnetic component curves.
 */
export async function refine_magnetic_powder(args: {
  structure: StructureModel;
  magnetic: MagneticModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  staged?: boolean;
  maxIterations?: number;
}): Promise<{
  result: RefinementResult;
  magnetic: MagneticModel;
  observationCount: number;
  components: { x: number[]; yObs: number[]; yNuclear: number[]; yMagnetic: number[]; yCalc: number[] };
  parallel: { workers: number } | null;
}> {
  const prof = { shape: args.profile.shape, ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}) };
  const maxIterations = args.maxIterations ?? 25;
  let params = args.parameters.map((p) => ({ ...p }));

  // Node evaluator pool when the runtime supports it (one init serves both
  // passes — replicas evaluate from the full values record). Serial otherwise;
  // trajectories are bit-identical either way.
  const spec: EvaluatorSpec = {
    kind: "magneticPowder",
    structure: args.structure,
    magnetic: args.magnetic,
    pattern: args.pattern,
    parameters: args.parameters,
    bindings: args.bindings,
    shape: args.profile.shape,
    ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}),
  };
  const pool = await createNodeEvaluatorPool(spec);
  const solve = (ps: RefinementParameter[], opts: { maxIterations: number }): Promise<RefinementResult> | RefinementResult => {
    const problem = buildMagneticPowderProblem(args.structure, args.magnetic, args.pattern, ps, args.bindings, prof);
    return pool ? refineParallel(problem, opts, pool) : refine(problem, opts);
  };
  try {
    if (args.staged ?? true) {
      // Stage 1: scale + background only; hold moments, profile, microstructure.
      const HOLD = new Set(["momentMode", "momentX", "momentY", "momentZ", "tofProfile", "mustrainIso", "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY"]);
      const pass1 = params.map((p) => (HOLD.has(p.kind) ? { ...p, fixed: true } : { ...p }));
      const r1 = await solve(pass1, { maxIterations: Math.min(maxIterations, 20) });
      params = params.map((p) => ({ ...p, value: r1.parameters[p.id] ?? p.value }));
    }

    const result = await solve(params, { maxIterations });
    const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
    const refinedMagnetic = applyMagneticMoments(args.magnetic, args.bindings, Object.fromEntries(refined.map((p) => [p.id, p.value])));
    const c = magneticPowderComponents(args.structure, refinedMagnetic, args.pattern, refined, args.bindings, prof);
    const excluded = excludedPointMask(c.yObs);
    return {
      result,
      magnetic: refinedMagnetic,
      observationCount: excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0),
      components: { x: c.x, yObs: c.yObs, yNuclear: c.yNuclear, yMagnetic: c.yMagnetic, yCalc: c.yCalc },
      parallel: pool ? { workers: pool.size } : null,
    };
  } finally {
    await pool?.dispose();
  }
}

/**
 * Parse single-crystal integrated intensities (FullProf `.int` h k l I σ, or a
 * SHELX HKLF4 `.hkl`) into a SingleCrystalDataset — the entry point for the
 * single-crystal and joint co-refinement paths. Detection is by content; GSAS
 * reflection lists (which need a cell to d-filter) are out of scope here.
 */
export function parse_single_crystal_data(args: { text: string; name?: string; id?: string }): {
  dataset: SingleCrystalDataset;
  kept: number;
  dropped: number;
  format: "fullprof" | "shelx";
  /** Propagation vectors declared in the file ([] for a plain nuclear file). */
  kVectors: [number, number, number][];
  /** Line-numbered {line, expected, found} diagnostics for skipped rows ([] when clean). */
  problems: { line: number; expected: string; found: string }[];
} {
  const id = args.id ?? "sc-hkl";
  const name = args.name ?? "single crystal";
  if (looksLikeFullProfInt(args.text)) {
    const parsed = parseFullProfInt(args.text);
    return {
      dataset: { id, name, radiation: { kind: "neutron", wavelength: parsed.wavelength ?? 1.0 }, reflections: parsed.reflections },
      kept: parsed.reflections.length,
      dropped: parsed.skipped,
      format: "fullprof",
      kVectors: (parsed.kVectors ?? []).map((k) => [...k] as [number, number, number]),
      problems: parsed.problems.map((p) => ({ ...p })),
    };
  }
  const reflections = parseHkl(args.text);
  return {
    dataset: { id, name, radiation: { kind: "neutron", wavelength: 1.54 }, reflections },
    kept: reflections.length,
    dropped: 0,
    format: "shelx",
    kVectors: [],
    problems: [],
  };
}

/**
 * Merge a nuclear + magnetic single-crystal reflection pair into the magnetic
 * supercell (Phase 3), the FullProf single-k convention: both files are indexed
 * in the nuclear cell (the magnetic file's `h k l` being the fundamental of a
 * satellite at `hkl + k`); this converts both into the supercell where k is an
 * integer reciprocal-lattice vector and concatenates them into one dataset ready
 * for a magnetic structure refinement. k must be commensurate and axis-diagonal.
 */
export function merge_magnetic_supercell(args: {
  nuclearDataset: SingleCrystalDataset;
  magneticDataset: SingleCrystalDataset;
  k: [number, number, number];
}): { dataset: SingleCrystalDataset; multiplicity: [number, number, number]; kInteger: [number, number, number]; reflections: number } {
  const { dataset, supercell } = mergeToMagneticSupercell(args.nuclearDataset, args.magneticDataset, args.k);
  return {
    dataset,
    multiplicity: [...supercell.multiplicity] as [number, number, number],
    kInteger: [...supercell.kInteger] as [number, number, number],
    reflections: dataset.reflections.length,
  };
}

/**
 * Expand a nuclear structure into the magnetic supercell of a commensurate k —
 * an exact geometric regrouping (full orbits explicit, replicated per cell
 * offset, P1; positions/occupancies/ADPs verbatim). Pair with
 * merge_magnetic_supercell: the merged reflections refine against this expanded
 * structure with the nuclear scaffold frozen (two-phase practice). The refined
 * scale in this setting is the base-cell scale divided by N² (N = cells per
 * supercell), identically for nuclear and magnetic intensities.
 */
export function expand_structure_supercell(args: { structure: StructureModel; k: [number, number, number] }): {
  structure: StructureModel;
  multiplicity: [number, number, number];
  kInteger: [number, number, number];
  atoms: number;
  replicas: { label: string; parent: string; offset: readonly [number, number, number] }[];
} {
  const { structure, supercell, replicas } = expandStructureToSupercell(args.structure, args.k);
  return {
    structure,
    multiplicity: [...supercell.multiplicity] as [number, number, number],
    kInteger: [...supercell.kInteger] as [number, number, number],
    atoms: structure.sites.length,
    replicas: replicas.map((r) => ({ ...r })),
  };
}

/**
 * Build the k-modulated moment model on an expanded supercell: one refinable
 * amplitude per magnetic sublattice drives every replica of its parent site
 * through cos(2πk·L + φ) — replica moments are tied by the modulation, so the
 * parameter count stays that of the base-cell description and the magnetic ion
 * positions are exactly the nuclear ones. Feed the returned parameters/bindings
 * (with a scale + magneticScale tied to it) to the magnetic refinement of the
 * merged supercell dataset. Directions are base-cell crystal-axis components;
 * phase φ = 0 gives the node pattern for k = ¼, φ = π/4 the equal-moment one.
 */
export function build_modulated_moment_model(args: {
  structure: StructureModel;
  k: [number, number, number];
  ions: { site: string; direction: [number, number, number]; phase?: number }[];
  moment?: number;
}): {
  structure: StructureModel;
  magnetic: MagneticModel;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  multiplicity: [number, number, number];
} {
  const expansion = expandStructureToSupercell(args.structure, args.k);
  const build = buildModulatedMomentModel(expansion, args.k, args.ions as readonly ModulatedIon[], args.moment ?? 1);
  return {
    structure: expansion.structure,
    magnetic: build.magnetic,
    parameters: build.params,
    bindings: build.bindings,
    multiplicity: [...expansion.supercell.multiplicity] as [number, number, number],
  };
}

/**
 * Serialize a single-crystal dataset to a FullProf `.int` file (Phase 3). Writes
 * the plain nuclear variant (h k l F² σ cod) through the declared Fortran format;
 * pass `kVectors` + per-reflection `kIndex` for the propagation-vector variant
 * (satellite = H + k_nv). The k path is pending external FullProf validation.
 */
export function write_single_crystal_data(args: {
  dataset: SingleCrystalDataset;
  wavelength?: number;
  title?: string;
  format?: string;
  kVectors?: [number, number, number][];
}): { text: string; reflections: number } {
  const rad = args.dataset.radiation;
  const wavelength = args.wavelength ?? (rad.kind === "neutron-tof" ? 0 : rad.wavelength);
  const text = writeFullProfInt(args.dataset.reflections, {
    ...(args.title !== undefined ? { title: args.title } : {}),
    wavelength,
    ...(args.format !== undefined ? { format: args.format } : {}),
    ...(args.kVectors ? { kVectors: args.kVectors } : {}),
  });
  return { text, reflections: args.dataset.reflections.length };
}

/**
 * The next-parameter diagnostic (roadmap F1.5): rank the currently-FIXED
 * parameter groups by the χ² improvement freeing them is expected to buy —
 * a Gauss–Newton estimate from probed Jacobian columns at the current values.
 * A LOCAL probe: run it after the pattern is roughly aligned (badly displaced
 * peaks under-credit cell/zero groups; see find_unexplained_peaks for that).
 */
export function rank_next_parameters(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  magnetic?: MagneticModel | null;
}): {
  wrNow: number;
  chiSquared: number;
  groups: {
    group: string;
    parameterIds: readonly string[];
    expectedRelativeImprovement: number;
    predictedWr: number;
  }[];
} {
  const problem = args.magnetic
    ? buildMagneticPowderProblem(args.structure, args.magnetic, args.pattern, args.parameters, args.bindings, {
        shape: args.profile.shape,
        ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}),
      })
    : buildPowderProblem(args.structure, args.pattern, args.parameters, args.bindings, args.profile);
  const ranking = rankNextParameterGroups(problem);
  return {
    wrNow: ranking.wrNow,
    chiSquared: ranking.chiSquared,
    groups: ranking.groups.map((g) => ({
      group: g.group,
      parameterIds: g.parameterIds,
      expectedRelativeImprovement: g.expectedRelativeImprovement,
      predictedWr: g.predictedWr,
    })),
  };
}

/**
 * The materials tool: read the refined structure for engineering/discovery
 * signals — microstructure (size/microstrain), stoichiometry (partial
 * occupancy), displacement anomalies, magnetic order, and bond-length sanity.
 */
export function interpret_structure(args: {
  structure: StructureModel;
  parameters?: RefinementParameter[];
  esd?: Record<string, number>;
  wavelength?: number;
  magnetic?: MagneticModel | null;
}): ReturnType<typeof interpretStructure> {
  return interpretStructure({
    structure: args.structure,
    ...(args.parameters ? { parameters: args.parameters } : {}),
    ...(args.esd ? { esd: args.esd } : {}),
    ...(args.wavelength !== undefined ? { wavelength: args.wavelength } : {}),
    ...(args.magnetic ? { magnetic: args.magnetic } : {}),
  });
}

// ---------------------------------------------------------------------------
// PDF (pair distribution function) tools — the real-space track's agent
// surface (PDF_MPDF_ROADMAP P6, nuclear slice). Same layer contract: one pure
// JSON → JSON wrapper per capability over the tested core.
// ---------------------------------------------------------------------------

/** Parse a reduced PDF file (.gr/.sq/.fq — PDFgetX3 or Mantid dialect). */
export function parse_pdf_data(args: { text: string; filename?: string }): {
  detected: { dataType: string; source: string; confidence: string; note?: string };
  pattern: PdfPattern;
  summary: {
    points: number; rMin: number; rMax: number; rStep?: number;
    scatteringType: string; qmax?: number; qdamp?: number; composition?: string;
  };
} {
  const fmt = detectDataFormat({ text: args.text, filename: args.filename ?? "data.gr" });
  if (fmt.dataType !== "pdf") throw new Error(`detected ${fmt.dataType} data, not a reduced PDF — use the powder/single-crystal path`);
  const pattern = parsePdfData(args.text, { id: "pdf", ...(args.filename ? { filename: args.filename } : {}) });
  if (pattern.points.length < 3) throw new Error("fewer than 3 usable G(r) rows");
  const rMin = pattern.points[0]!.r;
  const rMax = pattern.points[pattern.points.length - 1]!.r;
  return {
    detected: { dataType: fmt.dataType, source: fmt.source, confidence: fmt.confidence, ...(fmt.note ? { note: fmt.note } : {}) },
    pattern,
    summary: {
      points: pattern.points.length, rMin, rMax,
      ...(pattern.rstep !== undefined ? { rStep: pattern.rstep } : {}),
      scatteringType: pattern.scatteringType,
      ...(pattern.qmax !== undefined ? { qmax: pattern.qmax } : {}),
      ...(pattern.qdamp !== undefined ? { qdamp: pattern.qdamp } : {}),
      ...(pattern.composition ? { composition: pattern.composition } : {}),
    },
  };
}

/**
 * Build the symmetry-allowed PDF parameter set for a structure (or several
 * phases) + observed G(r): PDF scale (seeded to the least-squares optimum) and
 * envelope terms plus the symmetry-reduced structural set. Only
 * symmetry-allowed parameters are created.
 */
export function build_pdf_model(args: {
  structure: StructureModel;
  pattern: PdfPattern;
  extraPhases?: StructureModel[];
}): { parameters: RefinementParameter[]; bindings: ParameterBinding[]; restraints: LinearRestraint[]; freeCount: number } {
  const multi = args.extraPhases && args.extraPhases.length > 0;
  const spec = multi
    ? buildMultiPhasePdfSpec([args.structure, ...args.extraPhases!], args.pattern)
    : buildPdfSpec(args.structure, args.pattern);
  const phases = multi
    ? [{ structure: args.structure, id: args.structure.id }, ...args.extraPhases!.map((s) => ({ structure: s, id: s.id }))]
    : null;
  const start = phases
    ? multiPhasePdfCurves(phases, args.pattern, spec.params, spec.bindings)
    : pdfCurves(args.structure, args.pattern, spec.params, spec.bindings);
  const kappa = optimalPdfScale(start.yObs, start.yCalc) / (phases ? phases.length : 1);
  const parameters = spec.params.map((p) => (p.kind === "pdfScale" ? { ...p, value: kappa, initialValue: kappa } : p));
  return {
    parameters,
    bindings: spec.bindings,
    restraints: spec.restraints,
    freeCount: parameters.filter((p) => !p.fixed && !p.expression).length,
  };
}

/**
 * Refine the freed parameters against an observed G(r) (uniform weights, Rw
 * over G — real-space Rietveld). Flat co-refinement or the staged PDF sequence;
 * single- or multi-phase. Returns the result, the r-space residual, the
 * masked-observation count, and any correlated-motion model conflict.
 */
export async function refine_pdf(args: {
  structure: StructureModel;
  pattern: PdfPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  restraints?: LinearRestraint[];
  extraPhases?: StructureModel[];
  staged?: boolean;
  fitRange?: { min?: number; max?: number };
  maxIterations?: number;
}): Promise<{
  result: RefinementResult;
  observationCount: number;
  residual: { r: number[]; gObs: number[]; gCalc: number[] };
  warnings: string[];
  parallel: { workers: number } | null;
}> {
  const options = { maxIterations: args.maxIterations ?? 30 };
  const multi = args.extraPhases && args.extraPhases.length > 0;

  // Parallel fast path (flat fits): the Jacobian fans out over the node
  // worker-thread pool when the runtime supports it; bit-identical to serial.
  let parallel: { workers: number } | null = null;
  let result: RefinementResult | null = null;
  if (!args.staged) {
    const spec: EvaluatorSpec = {
      kind: "pdf",
      structure: args.structure,
      ...(multi ? { extraPhases: args.extraPhases } : {}),
      pattern: args.pattern,
      parameters: args.parameters,
      bindings: args.bindings,
      ...(args.restraints && args.restraints.length ? { restraints: args.restraints } : {}),
      ...(args.fitRange ? { fitRange: args.fitRange } : {}),
    };
    const pool = await createNodeEvaluatorPool(spec);
    if (pool) {
      try {
        result = await refineParallel(buildProblemForSpec(spec), options, pool);
        parallel = { workers: pool.size };
      } finally {
        await pool.dispose();
      }
    }
  }
  if (!result) {
    result = runPdfRefinement({
      type: "refinePdf",
      requestId: 0,
      structure: args.structure,
      ...(multi ? { extraPhases: args.extraPhases } : {}),
      pattern: args.pattern,
      parameters: args.parameters,
      bindings: args.bindings,
      ...(args.restraints && args.restraints.length ? { restraints: args.restraints } : {}),
      ...(args.staged ? { staged: PDF_STAGE_KINDS } : {}),
      ...(args.fitRange ? { fitRange: args.fitRange } : {}),
      options,
    });
  }

  const refined = args.parameters.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  const phases = multi
    ? [{ structure: args.structure, id: args.structure.id }, ...args.extraPhases!.map((s) => ({ structure: s, id: s.id }))]
    : null;
  const curves = phases
    ? multiPhasePdfCurves(phases, args.pattern, refined, args.bindings, args.fitRange)
    : pdfCurves(args.structure, args.pattern, refined, args.bindings, args.fitRange);
  const inRange = (r: number): boolean =>
    (args.fitRange?.min === undefined || r >= args.fitRange.min) &&
    (args.fitRange?.max === undefined || r <= args.fitRange.max);
  const observationCount = curves.x.filter(inRange).length;
  const conflict = correlatedMotionConflict(args.parameters);
  return {
    result,
    observationCount,
    residual: { r: [...curves.x], gObs: [...curves.yObs], gCalc: [...curves.yCalc] },
    warnings: conflict ? [conflict] : [],
    parallel,
  };
}

/**
 * Draw Bayesian posterior samples over the FREED parameters of a PDF fit with
 * the affine-invariant ensemble sampler. Where refine_pdf returns a point
 * estimate + linearized esds, this returns the full posterior: credible
 * intervals, true correlations, and the esdRatio verdict on whether the
 * least-squares error bars were honest. Bounded per call; the returned resume
 * token continues the same chain in a later call.
 */
export async function sample_posterior(args: {
  structure: StructureModel;
  pattern: PdfPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  restraints?: LinearRestraint[];
  extraPhases?: StructureModel[];
  fitRange?: { min?: number; max?: number };
  nSteps: number;
  nWalkers?: number;
  burnIn?: number;
  thin?: number;
  seed?: number;
  noiseModel?: NoiseModel;
  priors?: Record<string, PriorSpec>;
  linearizedEsd?: Record<string, number>;
  resume?: WalkerState;
  includeChains?: boolean;
}): Promise<{
  posterior: SampleResult["posterior"]["parameters"];
  correlations: { parameterIdA: string; parameterIdB: string; coefficient: number }[];
  acceptanceFraction: number;
  converged: boolean;
  status: SampleResult["status"];
  message?: string;
  nSamples: number;
  freeIds: string[];
  resume: WalkerState;
  chains?: number[][][];
  parallel: { workers: number } | null;
}> {
  const multi = args.extraPhases && args.extraPhases.length > 0;
  const spec: EvaluatorSpec = {
    kind: "pdf",
    structure: args.structure,
    ...(multi ? { extraPhases: args.extraPhases } : {}),
    pattern: args.pattern,
    parameters: args.parameters,
    bindings: args.bindings,
    ...(args.restraints && args.restraints.length ? { restraints: args.restraints } : {}),
    ...(args.fitRange ? { fitRange: args.fitRange } : {}),
  };
  const problem = buildProblemForSpec(spec);
  const options = {
    nSteps: args.nSteps,
    ...(args.nWalkers !== undefined ? { nWalkers: args.nWalkers } : {}),
    ...(args.burnIn !== undefined ? { burnIn: args.burnIn } : {}),
    ...(args.thin !== undefined ? { thin: args.thin } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    ...(args.noiseModel !== undefined ? { noiseModel: args.noiseModel } : {}),
    ...(args.priors !== undefined ? { priors: args.priors } : {}),
    ...(args.linearizedEsd !== undefined ? { linearizedEsd: args.linearizedEsd } : {}),
    ...(args.resume !== undefined ? { init: args.resume } : {}),
  };

  // Pool fast path: half-ensemble batches fan out over the node worker threads;
  // bit-identical to the serial path (the RNG never leaves the generator).
  let parallel: { workers: number } | null = null;
  let result: SampleResult | null = null;
  const pool = await createNodeEvaluatorPool(spec);
  if (pool) {
    try {
      result = await samplePosteriorParallel(problem, options, pool);
      parallel = { workers: pool.size };
    } finally {
      await pool.dispose();
    }
  }
  if (!result) result = samplePosterior(problem, options);

  const ids = result.freeIds;
  const correlations: { parameterIdA: string; parameterIdB: string; coefficient: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const c = result.posterior.correlation[i]![j]!;
      if (Math.abs(c) >= 0.3) {
        correlations.push({ parameterIdA: ids[i]!, parameterIdB: ids[j]!, coefficient: c });
      }
    }
  }
  correlations.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

  return {
    posterior: result.posterior.parameters,
    correlations: correlations.slice(0, 20),
    acceptanceFraction: result.acceptanceFraction,
    converged: result.status === "ok",
    status: result.status,
    ...(result.message !== undefined ? { message: result.message } : {}),
    nSamples: result.diagnostics.nSamples,
    freeIds: [...ids],
    resume: result.resume,
    ...(args.includeChains ? { chains: result.chains.map((w) => w.map((r) => [...r])) } : {}),
    parallel,
  };
}

/**
 * Decompose the calculated G(r) for interpretation: element-pair (Faber–Ziman)
 * partials for a single phase, or per-phase contributions for a multi-phase
 * model. The curves sum exactly to the total calc.
 */
export function compute_partial_pdf(args: {
  structure: StructureModel;
  pattern: PdfPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  extraPhases?: StructureModel[];
}): { kind: "element-pairs" | "phases"; r: number[]; partials: { label: string; g: number[] }[] } {
  const r = args.pattern.points.map((p) => p.r);
  if (args.extraPhases && args.extraPhases.length > 0) {
    const phases = [{ structure: args.structure, id: args.structure.id }, ...args.extraPhases.map((s) => ({ structure: s, id: s.id }))];
    const curves = pdfPhaseCurves(phases, args.pattern, args.parameters, args.bindings);
    return { kind: "phases", r, partials: curves.map((c) => ({ label: c.label, g: c.y })) };
  }
  const curves = pdfPartialCurves(args.structure, args.pattern, args.parameters, args.bindings);
  return { kind: "element-pairs", r, partials: curves.map((c) => ({ label: c.label, g: c.y })) };
}

/**
 * Calibrate the instrument resolution (Qdamp/Qbroad) from a measured STANDARD
 * (Ni/Si/LaB₆) with a known structure: frees only the PDF scale + Qdamp +
 * Qbroad (structure held at the certified values) and returns the calibrated
 * constants to carry to sample fits.
 */
export function calibrate_qdamp(args: {
  structure: StructureModel;
  pattern: PdfPattern;
  fitRange?: { min?: number; max?: number };
  maxIterations?: number;
}): { qdamp: number; qbroad: number; esd: { qdamp?: number; qbroad?: number }; rw?: number; iterations: number } {
  const spec = buildPdfSpec(args.structure, args.pattern);
  const start = pdfCurves(args.structure, args.pattern, spec.params, spec.bindings);
  const kappa = optimalPdfScale(start.yObs, start.yCalc);
  const free = new Set(["pdfScale", "qdamp", "qbroad"]);
  const params = spec.params.map((p) => ({
    ...p,
    ...(p.kind === "pdfScale" ? { value: kappa, initialValue: kappa } : {}),
    fixed: !free.has(p.id) && !free.has(p.kind),
  }));
  const problem = buildPdfProblem(args.structure, args.pattern, params, spec.bindings, spec.restraints, args.fitRange);
  const result = refine(problem, { maxIterations: args.maxIterations ?? 30, convergenceTolerance: 1e-9 });
  return {
    qdamp: result.parameters["qdamp"] ?? 0,
    qbroad: result.parameters["qbroad"] ?? 0,
    esd: {
      ...(result.esd["qdamp"] !== undefined ? { qdamp: result.esd["qdamp"] } : {}),
      ...(result.esd["qbroad"] !== undefined ? { qbroad: result.esd["qbroad"] } : {}),
    },
    ...(result.agreement.rWeighted !== undefined ? { rw: result.agreement.rWeighted } : {}),
    iterations: result.history.length,
  };
}

/**
 * Decompose a low-symmetry CHILD structure against its high-symmetry PARENT
 * into refinable distortion-mode amplitudes (AMPLIMODES/ISODISTORT paradigm):
 * the frozen distortion is mode 1 (its amplitude is the order parameter, Å),
 * plus an orthonormal complement. Feed `structure`/`parameters`/`bindings` to
 * refine_pdf or refine_powder in place of per-coordinate positions — same
 * engine, more informative parameters.
 */
export function build_distortion_modes(args: {
  parent: StructureModel;
  child: StructureModel;
  originShift?: [number, number, number];
}): {
  structure: StructureModel;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  modes: { id: string; label: string; star?: string; observedAmplitude: number }[];
  totalAmplitude: number;
  originShift: [number, number, number];
  unpaired: string[];
} {
  const set = buildDistortionModes(args.parent, args.child, args.originShift);
  return {
    structure: set.parentized,
    parameters: set.parameters,
    bindings: set.bindings,
    modes: set.modes.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.star !== undefined ? { star: m.star } : {}),
      observedAmplitude: m.observedAmplitude,
    })),
    totalAmplitude: set.totalAmplitude,
    originShift: [...set.originShift] as [number, number, number],
    unpaired: [...set.unpaired],
  };
}

/**
 * Enumerate the symmetry-adapted displacement modes of a structure FROM ITS
 * OWN SPACE GROUP — no parent/child pair. All amplitudes seed at 0 (activating
 * a mode never changes the curve); modes enter `fixed` and are freed
 * deliberately. Rigid-translation (acoustic) combinations — unobservable in
 * any scattering fit — are projected out (`acousticExcluded` counts them).
 * These are the symmetry-CONSERVING (Γ, identity-irrep) modes: the same DOF
 * as per-coordinate positions, re-expressed as orthonormal whole-cell Å
 * amplitudes. Symmetry-breaking (subgroup-tree) modes are a separate,
 * irrep-projected capability.
 */
export function build_symmetry_modes(args: { structure: StructureModel }): {
  structure: StructureModel;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  modes: { id: string; label: string; star?: string }[];
  acousticExcluded: number;
} {
  const set = buildSymmetryModes(args.structure);
  return {
    structure: set.parentized,
    parameters: set.parameters,
    bindings: set.bindings,
    modes: set.modes.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.star !== undefined ? { star: m.star } : {}),
    })),
    acousticExcluded: set.acousticExcluded ?? 0,
  };
}
