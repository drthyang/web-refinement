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
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MagneticModel } from "@/core/magnetic/types";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { detectDataFormat } from "@/parsers/detectFormat";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { buildPowderSpec, type MustrainModel } from "@/app/powderSpec";
import { runPowderRefinement } from "@/workers/runPowder";
import { powderCurves } from "@/core/workflow/powder";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { computeAgreementFactors, excludedPointMask, weightsFromSigma } from "@/core/refinement/factors";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import { generateReflections } from "@/core/diffraction/reflections";
import { abscissaFromD } from "@/core/diffraction/instrument";
import { bondLengths } from "@/core/crystal/geometry";
import { detectExtraPeaks, type ExtraPeakOptions } from "@/core/magnetic/extraPeaks";
import { searchPropagationVector, type KSearchOptions } from "@/core/magnetic/kSearch";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { refine } from "@/core/refinement/engine";
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
export function refine_powder(args: {
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
}): { result: RefinementResult; observationCount: number; residual: { d: number[]; yObs: number[]; yCalc: number[] } } {
  const shape: PeakShape = args.profile.shape;
  const result = runPowderRefinement({
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
    options: { maxIterations: args.maxIterations ?? 20 },
  });

  // Residual (obs − calc) as d-spacing arrays, so assess_refinement can scan the
  // positive residual for the missing-phase / magnetic-order signal.
  const refined = args.parameters.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  const curves = powderCurves(args.structure, args.pattern, refined, args.bindings, args.profile);
  const ctx = axisContext(args.pattern, args.instrument);
  const d = args.pattern.xUnit === "dSpacing" ? [...curves.x] : convertAxisArray(curves.x, args.pattern.xUnit, "dSpacing", ctx);
  const excluded = excludedPointMask(curves.yObs);
  const observationCount = excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0);
  return { result, observationCount, residual: { d, yObs: [...curves.yObs], yCalc: [...curves.yCalc] } };
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
export function refine_magnetic_powder(args: {
  structure: StructureModel;
  magnetic: MagneticModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  staged?: boolean;
  maxIterations?: number;
}): {
  result: RefinementResult;
  magnetic: MagneticModel;
  observationCount: number;
  components: { x: number[]; yObs: number[]; yNuclear: number[]; yMagnetic: number[]; yCalc: number[] };
} {
  const prof = { shape: args.profile.shape, ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}) };
  const maxIterations = args.maxIterations ?? 25;
  let params = args.parameters.map((p) => ({ ...p }));

  if (args.staged ?? true) {
    // Stage 1: scale + background only; hold moments, profile, microstructure.
    const HOLD = new Set(["momentMode", "momentX", "momentY", "momentZ", "tofProfile", "mustrainIso", "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY"]);
    const pass1 = params.map((p) => (HOLD.has(p.kind) ? { ...p, fixed: true } : { ...p }));
    const r1 = refine(buildMagneticPowderProblem(args.structure, args.magnetic, args.pattern, pass1, args.bindings, prof), { maxIterations: Math.min(maxIterations, 20) });
    params = params.map((p) => ({ ...p, value: r1.parameters[p.id] ?? p.value }));
  }

  const result = refine(buildMagneticPowderProblem(args.structure, args.magnetic, args.pattern, params, args.bindings, prof), { maxIterations });
  const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  const refinedMagnetic = applyMagneticMoments(args.magnetic, args.bindings, Object.fromEntries(refined.map((p) => [p.id, p.value])));
  const c = magneticPowderComponents(args.structure, refinedMagnetic, args.pattern, refined, args.bindings, prof);
  const excluded = excludedPointMask(c.yObs);
  return {
    result,
    magnetic: refinedMagnetic,
    observationCount: excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0),
    components: { x: c.x, yObs: c.yObs, yNuclear: c.yNuclear, yMagnetic: c.yMagnetic, yCalc: c.yCalc },
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
