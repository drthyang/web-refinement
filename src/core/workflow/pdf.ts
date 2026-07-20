/**
 * PDF refinement workflow: structure + observed reduced PDF `G(r)` + parameters
 * → RefinementProblem, plus obs/calc/difference curves for plotting and export
 * (PDF_MPDF_ROADMAP §4, phase P1 — "real-space Rietveld").
 *
 * The observable changes (reciprocal → real space) but the engine does not: a
 * PDF fit is the same `RefinementProblem` shape the powder workflow builds, so
 * `refine` / `refineStaged` / `refineMultiStart` are reused verbatim.
 *
 * Two deliberate departures from the powder template (roadmap §8):
 *  - **Uniform weights.** G(r) points from a finite-Q sine transform have
 *    strongly correlated errors, so `w = 1/σ²` is not a true statistical weight
 *    and would make esds/GoF wildly optimistic. The fit minimizes the plain sum
 *    of squares and reports Rw over G(r) as a *relative* quality measure.
 *  - **No `σ = √yObs` fallback and no `yObs ≤ 0` exclusion.** G(r) legitimately
 *    oscillates about 0; negative observations are data, not gaps.
 */

import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { PdfPattern, PowderPattern } from "@/core/diffraction/types";
import type {
  LinearRestraint,
  ParameterBinding,
  ParameterKind,
  RefinementParameter,
} from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { StageKinds } from "@/core/workflow/structureRefinement";
import type { FitRange } from "@/core/workflow/powder";
import type { PdfPair } from "@/core/pdf/pairEnumerator";
import { applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { parseTie, resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import {
  expandStructureAtoms,
  expandStructureAtomsWithProvenance,
  type ExpandedAtom,
} from "@/core/diffraction/structureFactor";
import { cartesianAdpTensor, enumeratePairs } from "@/core/pdf/pairEnumerator";
import { computeGofR, PAIR_REACH_MARGIN, type PdfModelParams } from "@/core/pdf/forwardModel";
import { computeGofRWithColumns, DUISO_DBISO, type PdfColumnRequest } from "@/core/pdf/gradients";
import { rotateUAniso } from "@/core/crystal/adp";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { mulVec } from "@/core/math/mat3";
import { computePartialsGofR } from "@/core/pdf/partials";
import { bandLimit, extendGridForTermination, terminationActive, uniformStep } from "@/core/pdf/termination";

/**
 * Parameter kinds whose value changes the pair list (positions/distances via
 * the cell and coordinates, per-pair widths via the ADPs). Everything else —
 * `pdfScale`, the Qdamp/Qbroad envelope, δ1/δ2, occupancy (a pure per-atom
 * weight) — reuses the cached pairs, which dominates the Jacobian evaluations.
 */
export const PAIR_GEOMETRY_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "cellLength", "cellAngle", "atomX", "atomY", "atomZ", "positionShift", "bIso", "uAniso",
]);

/** Neutral PDF parameter set when no PDF kind is bound (identity envelope). */
export const PDF_DEFAULTS = { scale: 1, qdamp: 0, qbroad: 0, delta1: 0, delta2: 0, spdiameter: 0, sratio: 1, rcut: 0 } as const;

/** How a terminated model evaluation maps onto the data grid: the (possibly
 *  margin-extended) model grid and the slice back onto the observations.
 *  Exported for the sibling mPDF workflow (workflow/mpdf.ts), which shares the
 *  nuclear machinery and adds the magnetic component before band-limiting. */
export interface TerminationPlan {
  readonly modelGrid: Float64Array;
  readonly sliceOffset: number;
  readonly terminate: boolean;
  readonly step: number;
  readonly qmax: number;
}

export function terminationPlanFor(pattern: PdfPattern, rValues: readonly number[]): TerminationPlan {
  const qmax = pattern.qmax ?? 0;
  const step = uniformStep(rValues) ?? 0;
  const terminate = step > 0 && rValues.length > 1 && terminationActive(qmax, step);
  if (!terminate) return { modelGrid: Float64Array.from(rValues), sliceOffset: 0, terminate, step, qmax };
  const { rExt, offset } = extendGridForTermination(rValues[0]!, step, rValues.length, qmax);
  return { modelGrid: rExt, sliceOffset: offset, terminate, step, qmax };
}

/** The contiguous index window of `rValues` inside the fit range. Points
 *  outside carry zero weight, so the model is never evaluated there — the
 *  difference between a snappy fit and a hung UI on an r → 100 Å file. */
export function windowFor(rValues: readonly number[], fitRange?: FitRange): { i0: number; i1: number } {
  const min = fitRange?.min ?? -Infinity;
  const max = fitRange?.max ?? Infinity;
  let i0 = 0;
  while (i0 < rValues.length && rValues[i0]! < min) i0++;
  let i1 = rValues.length;
  while (i1 > i0 && rValues[i1 - 1]! > max) i1--;
  return { i0, i1 };
}

/**
 * The single-phase PDF problem, extended with the differentiable-model surface
 * (roadmap F1.1 real-space): `analyticColumns` feeds the LM engine exact
 * Jacobian columns for the supported kinds, and `gradChi2` is the scalar
 * χ²-gradient contract a gradient-based sampler (NUTS) consumes — analytic
 * columns where supported, central-difference fill-in elsewhere, so the
 * gradient is always complete.
 */
export interface PdfRefinementProblem extends RefinementProblem {
  readonly gradChi2: (
    freeParams: readonly RefinementParameter[],
    freeValues: readonly number[],
  ) => { chi2: number; grad: Float64Array };
}

export function buildPdfProblem(
  structure: StructureModel,
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  restraints: readonly LinearRestraint[] = [],
  fitRange?: FitRange,
): PdfRefinementProblem {
  const rValues = pattern.points.map((p) => p.r);
  const gObs = pattern.points.map((p) => p.gObs);
  const observations = Float64Array.from([...gObs, ...restraints.map((r) => r.target)]);

  // Uniform unit weights over G(r) (see the module header); the fit-range mask
  // zeroes excluded points. Restraint rows keep their own 1/σ² strength.
  const uniform = new Float64Array(rValues.length).fill(1);
  const dataWeights = applyExclusionMask(uniform, fitRangeMask(rValues, fitRange));
  const weights = new Float64Array(observations.length);
  weights.set(dataWeights, 0);
  for (let i = 0; i < restraints.length; i++) {
    const sigma = Math.max(restraints[i]!.sigma, 1e-12);
    weights[rValues.length + i] = 1 / (sigma * sigma);
  }

  // Model only the fit window: everything outside has zero weight and stays 0
  // in the calculated vector (never drawn, never fitted, never enumerated).
  const { i0, i1 } = windowFor(rValues, fitRange);
  const rWindow = rValues.slice(i0, i1);

  // Single-entry pair-list cache keyed on the exact values of every
  // geometry-bound parameter (the `createPeakBuilder` pattern). Amplitudes are
  // assembled per evaluation from the atoms (occupancy lives there), and the
  // scale multiplies last inside `computeGofR`, so a cache hit is bit-identical
  // to a fresh enumeration.
  const geomIds = [...new Set(bindings.filter((b) => PAIR_GEOMETRY_KINDS.has(b.kind)).map((b) => b.parameterId))];

  // Finite-Qmax termination (pdf/termination.ts): when the data carries a Qmax
  // and sits on a uniform grid oversampled past its Nyquist, the model is
  // evaluated on the margin-extended grid, band-limited, and sliced back onto
  // the data grid. Otherwise the model grid IS the (windowed) data grid.
  const { modelGrid, sliceOffset, terminate, step, qmax } = terminationPlanFor(pattern, rWindow);
  const rMaxModel = modelGrid.length ? modelGrid[modelGrid.length - 1]! : 0;
  let lastKey: string | null = null;
  let cachedPairs: PdfPair[] = [];

  const pairsFor = (cell: UnitCell, atoms: readonly ExpandedAtom[], resolved: Readonly<Record<string, number>>): PdfPair[] => {
    let key = "";
    for (const id of geomIds) key += `|${resolved[id]}`;
    if (key !== lastKey) {
      cachedPairs = enumeratePairs(cell, atoms, rMaxModel + PAIR_REACH_MARGIN);
      lastKey = key;
    }
    return cachedPairs;
  };

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const atoms = expandStructureAtoms(applied.model);
    const pairs = pairsFor(applied.model.cell, atoms, resolved);
    const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
    const gModel = computeGofR(applied.model.cell, atoms, modelGrid, params, pairs);
    const gWindow = terminate
      ? bandLimit(gModel, modelGrid[0]!, step, qmax).subarray(sliceOffset, sliceOffset + rWindow.length)
      : gModel;
    const out = new Float64Array(rValues.length + restraints.length);
    out.set(gWindow.subarray(0, rWindow.length), i0);
    for (let i = 0; i < restraints.length; i++) {
      const restraint = restraints[i]!;
      let value = 0;
      for (const term of restraint.terms) value += term.coefficient * (resolved[term.parameterId] ?? 0);
      out[rValues.length + i] = value;
    }
    return out;
  };

  // Free parameters referenced BY a tie expression: moving them moves the tied
  // parameter too — an indirect model path the analytic columns don't carry, so
  // those fall back to finite differences (null).
  const tieReferencedIds = new Set<string>();
  for (const p of parameters) {
    if (!p.expression) continue;
    try {
      tieReferencedIds.add(parseTie(p.expression).refId);
    } catch {
      // An unparsable tie fails loudly in resolveTies; nothing to guard here.
    }
  }

  /** Analytic ∂calc/∂p for every free parameter the fused gradient pass can
   *  differentiate, null (→ engine FD) elsewhere. Restraint rows are affine in
   *  the parameters, so their derivative entries are the term coefficients —
   *  restraints are supported, not refused (unlike the powder template). */
  const columnsFor = (
    freeParams: readonly RefinementParameter[],
    freeValues: readonly number[],
  ): (Float64Array | null)[] => {
    const record: Record<string, number> = {};
    for (const p of parameters) record[p.id] = p.value;
    for (let j = 0; j < freeParams.length; j++) record[freeParams[j]!.id] = freeValues[j]!;
    const resolved = resolveTies(parameters, record);
    const applied = applyParameters(structure, bindings, resolved);
    const { atoms, provenance } = expandStructureAtomsWithProvenance(applied.model);
    const cell = applied.model.cell;
    const pairs = pairsFor(cell, atoms, resolved);
    const M = orthogonalizationMatrix(cell);
    const pdf = applied.pdf ?? PDF_DEFAULTS;

    const siteIndexByLabel = new Map(applied.model.sites.map((s, i) => [s.label, i] as const));
    const orbit: number[][] = applied.model.sites.map(() => []);
    for (let a = 0; a < provenance.length; a++) orbit[provenance[a]!.siteIndex]!.push(a);

    const requests: (PdfColumnRequest | null)[] = freeParams.map((p) => {
      if (tieReferencedIds.has(p.id)) return null;
      const bs = bindings.filter((b) => b.parameterId === p.id);
      if (bs.length === 0) return null;
      const kind = bs[0]!.kind;
      if (bs.some((b) => b.kind !== kind)) return null;
      switch (kind) {
        case "qdamp":
          return { kind: "qdamp" };
        case "qbroad":
          return { kind: "sigma", target: "qbroad" };
        case "delta1":
          return { kind: "sigma", target: "delta1" };
        case "delta2":
          return { kind: "sigma", target: "delta2" };
        case "spdiameter":
          // At diameter 0 the envelope is disabled (bulk) and the derivative is
          // one-sided — leave that boundary to FD.
          return pdf.spdiameter > 0 ? { kind: "spdiameter" } : null;
        case "occupancy": {
          const dOcc = new Float64Array(atoms.length);
          for (const b of bs) {
            const si = b.targetKey !== undefined ? siteIndexByLabel.get(b.targetKey) : undefined;
            if (si === undefined) return null;
            for (const a of orbit[si]!) dOcc[a] = dOcc[a]! + 1;
          }
          return { kind: "occupancy", dOcc };
        }
        case "bIso": {
          const constant = new Float64Array(atoms.length);
          for (const b of bs) {
            const si = b.targetKey !== undefined ? siteIndexByLabel.get(b.targetKey) : undefined;
            if (si === undefined) return null;
            // apply.ts writes bIso only onto an isotropic site — an anisotropic
            // target is a no-op, so its derivative is exactly zero.
            if (applied.model.sites[si]!.adp.kind !== "isotropic") continue;
            for (const a of orbit[si]!) constant[a] = constant[a]! + DUISO_DBISO;
          }
          return { kind: "msd", constant, tensors: atoms.map(() => null) };
        }
        case "uAniso": {
          const constant = new Float64Array(atoms.length);
          const tensors: (Mat3Like | null)[] = atoms.map(() => null);
          for (const b of bs) {
            const si = b.targetKey !== undefined ? siteIndexByLabel.get(b.targetKey) : undefined;
            if (si === undefined || !b.uBasis) return null;
            for (const a of orbit[si]!) {
              // The orbit image sees the mode basis through its operation:
              // dU_image = R·uBasis·Rᵀ, then to Cartesian (linear in U).
              const rotated = rotateUAniso(b.uBasis, provenance[a]!.rotation);
              const dU = cartesianAdpTensor(cell, { kind: "anisotropic", uAniso: rotated });
              const prev = tensors[a];
              tensors[a] = prev
                ? (prev.map((row, ri) => row.map((v, ci) => v + dU[ri]![ci]!)) as unknown as Mat3Like)
                : dU;
            }
          }
          return { kind: "msd", constant, tensors: tensors as (import("@/core/math/types").Mat3 | null)[] };
        }
        case "positionShift": {
          const velocity: ([number, number, number] | null)[] = atoms.map(() => null);
          for (const b of bs) {
            const si = b.targetKey !== undefined ? siteIndexByLabel.get(b.targetKey) : undefined;
            if (si === undefined || !b.axis) return null;
            for (const a of orbit[si]!) {
              // du_image/dv = M·(R·axis): the fractional mode axis, carried to
              // the image by its operation's rotation, then to Cartesian.
              const R = provenance[a]!.rotation;
              const rAxis: [number, number, number] = [
                R[0]![0]! * b.axis[0] + R[0]![1]! * b.axis[1] + R[0]![2]! * b.axis[2],
                R[1]![0]! * b.axis[0] + R[1]![1]! * b.axis[1] + R[1]![2]! * b.axis[2],
                R[2]![0]! * b.axis[0] + R[2]![1]! * b.axis[1] + R[2]![2]! * b.axis[2],
              ];
              const cartV = mulVec(M, rAxis);
              const prev = velocity[a];
              velocity[a] = prev
                ? [prev[0] + cartV[0], prev[1] + cartV[1], prev[2] + cartV[2]]
                : [cartV[0], cartV[1], cartV[2]];
            }
          }
          return { kind: "position", velocity };
        }
        default:
          // pdfScale rides the engine's exact linear-column path; cell,
          // sratio/rcut and raw coordinates stay on FD in v1.
          return null;
      }
    });

    const out: (Float64Array | null)[] = requests.map(() => null);
    const activeIdx: number[] = [];
    const activeReqs: PdfColumnRequest[] = [];
    for (let j = 0; j < requests.length; j++) {
      const r = requests[j];
      if (r) {
        activeIdx.push(j);
        activeReqs.push(r);
      }
    }
    if (activeReqs.length === 0) return out;

    const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...pdf };
    const { columns } = computeGofRWithColumns(cell, atoms, modelGrid, params, pairs, activeReqs);
    for (let c = 0; c < activeIdx.length; c++) {
      const j = activeIdx[c]!;
      const col = columns[c]!;
      // Columns live in calculated-pattern space: same termination convolution
      // (bandLimit is linear) and window splice as the value path.
      const colWindow = terminate
        ? bandLimit(col, modelGrid[0]!, step, qmax).subarray(sliceOffset, sliceOffset + rWindow.length)
        : col;
      const full = new Float64Array(rValues.length + restraints.length);
      full.set(colWindow.subarray(0, rWindow.length), i0);
      const pid = freeParams[j]!.id;
      for (let t = 0; t < restraints.length; t++) {
        let coeff = 0;
        for (const term of restraints[t]!.terms) if (term.parameterId === pid) coeff += term.coefficient;
        full[rValues.length + t] = coeff;
      }
      out[j] = full;
    }
    return out;
  };

  const gradChi2 = (
    freeParams: readonly RefinementParameter[],
    freeValues: readonly number[],
  ): { chi2: number; grad: Float64Array } => {
    const record: Record<string, number> = {};
    for (const p of parameters) record[p.id] = p.value;
    for (let j = 0; j < freeParams.length; j++) record[freeParams[j]!.id] = freeValues[j]!;
    const yCalc = calculate(record);
    let chi2 = 0;
    for (let k = 0; k < observations.length; k++) {
      const d = observations[k]! - yCalc[k]!;
      chi2 += weights[k]! * d * d;
    }
    const cols = columnsFor(freeParams, freeValues);
    const grad = new Float64Array(freeParams.length);
    for (let j = 0; j < freeParams.length; j++) {
      let col = cols[j];
      if (!col) {
        // Central-difference fill-in (engine step recipe) — the gradient is
        // complete even for kinds the analytic pass declines.
        const base = freeValues[j]!;
        const h = Math.max(1e-6, Math.abs(base) * 1e-5);
        record[freeParams[j]!.id] = base + h;
        const fwd = calculate(record);
        record[freeParams[j]!.id] = base - h;
        const bwd = calculate(record);
        record[freeParams[j]!.id] = base;
        col = new Float64Array(observations.length);
        for (let k = 0; k < col.length; k++) col[k] = (fwd[k]! - bwd[k]!) / (2 * h);
      }
      let s = 0;
      for (let k = 0; k < observations.length; k++) {
        s += weights[k]! * (observations[k]! - yCalc[k]!) * col[k]!;
      }
      grad[j] = -2 * s;
    }
    return { chi2, grad };
  };

  return { parameters, observations, weights, calculate, analyticColumns: columnsFor, gradChi2 };
}

/** Structural alias for a 3×3 tensor built row-wise in the uAniso accumulation. */
type Mat3Like = readonly (readonly number[])[];

/** Obs/calc/difference G(r) curves for the current parameter values. The field
 *  names match `PowderCurves` so the same plot component consumes both. */
export interface PdfCurves {
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
  readonly diff: number[];
}

export function pdfCurves(
  structure: StructureModel,
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  fitRange?: FitRange,
): PdfCurves {
  const problem = buildPdfProblem(structure, pattern, parameters, bindings, [], fitRange);
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const yCalc = problem.calculate(values);
  const x = pattern.points.map((p) => p.r);
  const yObs = pattern.points.map((p) => p.gObs);
  const diff = yObs.map((o, i) => o - (yCalc[i] ?? 0));
  return { x, yObs, yCalc: Array.from(yCalc), diff };
}

// ---------------------------------------------------------------------------
// Multi-phase PDF (roadmap P3): G(r) = Σ_p G_p(r), each phase carrying its own
// pdfScale (the phase fraction folds into it, PDFfit2 convention), cell, atoms,
// correlated-motion δs and particle envelope — while the instrument resolution
// (Qdamp/Qbroad) is one-per-sample, shared across phases.
// ---------------------------------------------------------------------------

export interface PdfPhase {
  readonly structure: StructureModel;
  /** Phase id used to route bindings (scale/cell/atoms/δ) to this phase. */
  readonly id: string;
}

/** Kinds shared by every phase (the instrument's Q-resolution envelope). */
const PDF_SHARED_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>(["qdamp", "qbroad"]);

/** The bindings acting on one phase: its own (routed by `targetId`) plus the
 *  shared instrument bindings. */
export function pdfPhaseBindingsFor(bindings: readonly ParameterBinding[], phaseId: string): ParameterBinding[] {
  return bindings.filter((b) => b.targetId === phaseId || PDF_SHARED_KINDS.has(b.kind));
}

export function buildMultiPhasePdfProblem(
  phases: readonly PdfPhase[],
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  restraints: readonly LinearRestraint[] = [],
  fitRange?: FitRange,
): RefinementProblem {
  const rValues = pattern.points.map((p) => p.r);
  const gObs = pattern.points.map((p) => p.gObs);
  const observations = Float64Array.from([...gObs, ...restraints.map((r) => r.target)]);
  const uniform = new Float64Array(rValues.length).fill(1);
  const dataWeights = applyExclusionMask(uniform, fitRangeMask(rValues, fitRange));
  const weights = new Float64Array(observations.length);
  weights.set(dataWeights, 0);
  for (let i = 0; i < restraints.length; i++) {
    const sigma = Math.max(restraints[i]!.sigma, 1e-12);
    weights[rValues.length + i] = 1 / (sigma * sigma);
  }

  // Model only the fit window (see buildPdfProblem — zero-weight tails are
  // never enumerated or convolved).
  const { i0, i1 } = windowFor(rValues, fitRange);
  const rWindow = rValues.slice(i0, i1);
  const { modelGrid, sliceOffset, terminate, step, qmax } = terminationPlanFor(pattern, rWindow);
  const rMaxModel = modelGrid.length ? modelGrid[modelGrid.length - 1]! : 0;

  // One geometry-keyed pair cache per phase (same exactness argument as the
  // single-phase cache: amplitudes rebuild per evaluation, scale applies last).
  const caches = new Map<string, { geomIds: string[]; lastKey: string | null; pairs: PdfPair[] }>();
  for (const phase of phases) {
    const phaseBindings = pdfPhaseBindingsFor(bindings, phase.id);
    const geomIds = [...new Set(phaseBindings.filter((b) => PAIR_GEOMETRY_KINDS.has(b.kind)).map((b) => b.parameterId))];
    caches.set(phase.id, { geomIds, lastKey: null, pairs: [] });
  }

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const gSum = new Float64Array(modelGrid.length);
    for (const phase of phases) {
      const phaseBindings = pdfPhaseBindingsFor(bindings, phase.id);
      const applied = applyParameters(phase.structure, phaseBindings, resolved);
      const atoms = expandStructureAtoms(applied.model);
      const cache = caches.get(phase.id)!;
      let key = "";
      for (const id of cache.geomIds) key += `|${resolved[id]}`;
      if (key !== cache.lastKey) {
        cache.pairs = enumeratePairs(applied.model.cell, atoms, rMaxModel + PAIR_REACH_MARGIN);
        cache.lastKey = key;
      }
      const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
      const g = computeGofR(applied.model.cell, atoms, modelGrid, params, cache.pairs);
      for (let k = 0; k < gSum.length; k++) gSum[k] = gSum[k]! + g[k]!;
    }
    const gWindow = terminate
      ? bandLimit(gSum, modelGrid[0]!, step, qmax).subarray(sliceOffset, sliceOffset + rWindow.length)
      : gSum;
    const out = new Float64Array(rValues.length + restraints.length);
    out.set(gWindow.subarray(0, rWindow.length), i0);
    for (let i = 0; i < restraints.length; i++) {
      const restraint = restraints[i]!;
      let value = 0;
      for (const term of restraint.terms) value += term.coefficient * (resolved[term.parameterId] ?? 0);
      out[rValues.length + i] = value;
    }
    return out;
  };

  return { parameters, observations, weights, calculate };
}

/** Obs/calc/difference curves for a multi-phase PDF at the current values. */
export function multiPhasePdfCurves(
  phases: readonly PdfPhase[],
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  fitRange?: FitRange,
): PdfCurves {
  const problem = buildMultiPhasePdfProblem(phases, pattern, parameters, bindings, [], fitRange);
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const yCalc = problem.calculate(values);
  const x = pattern.points.map((p) => p.r);
  const yObs = pattern.points.map((p) => p.gObs);
  const diff = yObs.map((o, i) => o - (yCalc[i] ?? 0));
  return { x, yObs, yCalc: Array.from(yCalc.subarray(0, x.length)), diff };
}

/**
 * Per-phase contributions on the data grid (terminated like the total): the
 * plot's decomposition overlay for a multi-phase fit — which phase makes which
 * peak. Sums exactly to the multi-phase calc.
 */
export function pdfPhaseCurves(
  phases: readonly PdfPhase[],
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  fitRange?: FitRange,
): PdfPartialCurve[] {
  const rValues = pattern.points.map((p) => p.r);
  const { i0, i1 } = windowFor(rValues, fitRange);
  const rWindow = rValues.slice(i0, i1);
  const plan = terminationPlanFor(pattern, rWindow);
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  return phases.map((phase) => {
    const applied = applyParameters(phase.structure, pdfPhaseBindingsFor(bindings, phase.id), resolved);
    const atoms = expandStructureAtoms(applied.model);
    const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
    const g = computeGofR(applied.model.cell, atoms, plan.modelGrid, params);
    const gWindow = plan.terminate
      ? bandLimit(g, plan.modelGrid[0]!, plan.step, plan.qmax).subarray(plan.sliceOffset, plan.sliceOffset + rWindow.length)
      : g;
    const y = new Float64Array(rValues.length);
    y.set(gWindow.subarray(0, rWindow.length), i0);
    return { label: phase.structure.name || phase.id, y: Array.from(y) };
  });
}

/**
 * Multi-phase PDF parameter set: each phase's single-phase spec with per-phase
 * ids prefixed `p{i}_` and its PDF scale/δ/envelope re-bound to the phase id;
 * the shared instrument Qdamp/Qbroad emitted once (from phase 0). Mirrors the
 * powder `buildMultiPhaseSpec` convention so the UI merge logic carries over.
 */
export function buildMultiPhasePdfSpec(
  structures: readonly StructureModel[],
  pattern: PdfPattern,
  ties: PdfSiteTies = {},
): PdfSpec & { phases: PdfPhase[] } {
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const restraints: LinearRestraint[] = [];
  structures.forEach((structure, i) => {
    const spec = buildPdfSpec(structure, pattern, ties);
    const prefix = (id: string): string => `p${i}_${id}`;
    for (const p of spec.params) {
      if (PDF_SHARED_KINDS.has(p.kind)) {
        if (i === 0) params.push(p);
        continue;
      }
      params.push({ ...p, id: prefix(p.id), label: `${structure.name || structure.id}: ${p.label}` });
    }
    for (const b of spec.bindings) {
      if (PDF_SHARED_KINDS.has(b.kind)) {
        if (i === 0) bindings.push(b);
        continue;
      }
      // Per-phase PDF parameters (scale, correlated motion, particle Ø) re-bind
      // from the pattern to this phase so the router sends them here only.
      const perPhasePdf =
        b.kind === "pdfScale" || b.kind === "delta1" || b.kind === "delta2" ||
        b.kind === "spdiameter" || b.kind === "sratio" || b.kind === "rcut";
      bindings.push({ ...b, parameterId: prefix(b.parameterId), ...(perPhasePdf ? { targetId: structure.id } : {}) });
    }
    for (const r of spec.restraints) {
      restraints.push({ ...r, id: prefix(r.id), terms: r.terms.map((t) => ({ ...t, parameterId: prefix(t.parameterId) })) });
    }
  });
  return { params, bindings, restraints, phases: structures.map((s) => ({ structure: s, id: s.id })) };
}

// ---------------------------------------------------------------------------
// Multi-dataset PDF co-refinement (roadmap P3): one structure fitted against
// several G(r) datasets at once — a temperature series, or joint X-ray +
// neutron. One concatenated residual; the structure (cell/positions/ADPs) and
// the sample terms (δ1/δ2, particle Ø) are shared, while each dataset keeps its
// own scale and its own instrument envelope (Qdamp/Qbroad) routed by pattern id.
// ---------------------------------------------------------------------------

/** Kinds owned by one dataset (routed by the binding's targetId = pattern id). */
const PDF_PER_DATASET_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>(["pdfScale", "qdamp", "qbroad"]);

/** The bindings acting on one dataset: everything except the other datasets'
 *  scale/envelope bindings. */
export function pdfDatasetBindingsFor(bindings: readonly ParameterBinding[], datasetId: string): ParameterBinding[] {
  return bindings.filter((b) => !PDF_PER_DATASET_KINDS.has(b.kind) || b.targetId === datasetId);
}

export function buildMultiDatasetPdfProblem(
  structure: StructureModel,
  patterns: readonly PdfPattern[],
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  restraints: readonly LinearRestraint[] = [],
  fitRanges: readonly (FitRange | undefined)[] = [],
): RefinementProblem {
  const plans = patterns.map((pattern, i) => {
    const rValues = pattern.points.map((p) => p.r);
    const { i0, i1 } = windowFor(rValues, fitRanges[i]);
    const rWindow = rValues.slice(i0, i1);
    return { pattern, rValues, i0, rWindow, plan: terminationPlanFor(pattern, rWindow) };
  });
  const nData = plans.reduce((s, d) => s + d.rValues.length, 0);

  const observations = new Float64Array(nData + restraints.length);
  const weights = new Float64Array(nData + restraints.length);
  let offset = 0;
  plans.forEach((d, i) => {
    const uniform = new Float64Array(d.rValues.length).fill(1);
    const masked = applyExclusionMask(uniform, fitRangeMask(d.rValues, fitRanges[i]));
    for (let k = 0; k < d.rValues.length; k++) {
      observations[offset + k] = d.pattern.points[k]!.gObs;
      weights[offset + k] = masked[k]!;
    }
    offset += d.rValues.length;
  });
  for (let i = 0; i < restraints.length; i++) {
    observations[nData + i] = restraints[i]!.target;
    weights[nData + i] = 1 / Math.max(restraints[i]!.sigma, 1e-12) ** 2;
  }

  // One shared pair cache reaching the farthest dataset's model grid: pairs
  // depend only on the (shared) geometry, and pairs beyond a shorter grid cost
  // nothing in the accumulation (their window is empty).
  const geomIds = [...new Set(bindings.filter((b) => PAIR_GEOMETRY_KINDS.has(b.kind)).map((b) => b.parameterId))];
  const rMaxAll = Math.max(0, ...plans.map((d) => (d.plan.modelGrid.length ? d.plan.modelGrid[d.plan.modelGrid.length - 1]! : 0)));
  let lastKey: string | null = null;
  let cachedPairs: PdfPair[] = [];

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const out = new Float64Array(nData + restraints.length);
    let cursor = 0;
    for (const d of plans) {
      const applied = applyParameters(structure, pdfDatasetBindingsFor(bindings, d.pattern.id), resolved);
      const atoms = expandStructureAtoms(applied.model);
      let key = "";
      for (const id of geomIds) key += `|${resolved[id]}`;
      if (key !== lastKey) {
        cachedPairs = enumeratePairs(applied.model.cell, atoms, rMaxAll + PAIR_REACH_MARGIN);
        lastKey = key;
      }
      const params: PdfModelParams = { scatteringType: d.pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
      const g = computeGofR(applied.model.cell, atoms, d.plan.modelGrid, params, cachedPairs);
      const gWindow = d.plan.terminate
        ? bandLimit(g, d.plan.modelGrid[0]!, d.plan.step, d.plan.qmax).subarray(d.plan.sliceOffset, d.plan.sliceOffset + d.rWindow.length)
        : g;
      out.set(gWindow.subarray(0, d.rWindow.length), cursor + d.i0);
      cursor += d.rValues.length;
    }
    for (let i = 0; i < restraints.length; i++) {
      const restraint = restraints[i]!;
      let value = 0;
      for (const term of restraint.terms) value += term.coefficient * (resolved[term.parameterId] ?? 0);
      out[nData + i] = value;
    }
    return out;
  };

  return { parameters, observations, weights, calculate };
}

/**
 * Multi-dataset parameter set: the shared structural + sample spec (from the
 * first pattern) plus one scale/Qdamp/Qbroad trio per dataset, prefixed
 * `d{i}_` and routed by pattern id.
 */
export function buildMultiDatasetPdfSpec(
  structure: StructureModel,
  patterns: readonly PdfPattern[],
  ties: PdfSiteTies = {},
): PdfSpec {
  const first = buildPdfSpec(structure, patterns[0]!, ties);
  const perDataset = new Set<string>(["pdfScale", "qdamp", "qbroad"]);
  const params: RefinementParameter[] = first.params.filter((p) => !perDataset.has(p.id));
  const bindings: ParameterBinding[] = first.bindings.filter((b) => !perDataset.has(b.parameterId));
  patterns.forEach((pattern, i) => {
    const spec = buildPdfSpec(structure, pattern, ties);
    for (const id of perDataset) {
      const p = spec.params.find((q) => q.id === id)!;
      const label = patterns.length > 1 ? `${pattern.name || pattern.id}: ${p.label}` : p.label;
      params.push({ ...p, id: `d${i}_${id}`, label });
      bindings.push({ parameterId: `d${i}_${id}`, kind: p.kind, targetId: pattern.id });
    }
  });
  return { params, bindings, restraints: first.restraints };
}

/** One element-pair partial G_AB(r) on the data grid (terminated like the total). */
export interface PdfPartialCurve {
  readonly label: string;
  readonly y: number[];
}

/**
 * Element-pair partial PDFs at the current parameter values, band-limited and
 * sliced exactly like the total curve — so overlays sum to the plotted calc.
 */
export function pdfPartialCurves(
  structure: StructureModel,
  pattern: PdfPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  fitRange?: FitRange,
): PdfPartialCurve[] {
  const rValues = pattern.points.map((p) => p.r);
  const { i0, i1 } = windowFor(rValues, fitRange);
  const rWindow = rValues.slice(i0, i1);
  const plan = terminationPlanFor(pattern, rWindow);
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const applied = applyParameters(structure, bindings, resolved);
  const atoms = expandStructureAtoms(applied.model);
  const params: PdfModelParams = { scatteringType: pattern.scatteringType, ...(applied.pdf ?? PDF_DEFAULTS) };
  const partials = computePartialsGofR(applied.model.cell, atoms, plan.modelGrid, params);
  return partials.map((p) => {
    const gWindow = plan.terminate
      ? bandLimit(p.g, plan.modelGrid[0]!, plan.step, plan.qmax).subarray(plan.sliceOffset, plan.sliceOffset + rWindow.length)
      : p.g;
    const y = new Float64Array(rValues.length);
    y.set(gWindow.subarray(0, rWindow.length), i0);
    return { label: p.label, y: Array.from(y) };
  });
}

/**
 * Least-squares single scale κ = Σ G_obs·G_calc / Σ G_calc² — the exact optimum
 * for a linear scale, used to seed `pdfScale` from the first calculated curve.
 * Returns 1 when the calculated curve is degenerate (all zero).
 */
export function optimalPdfScale(gObs: readonly number[], gCalc: readonly number[]): number {
  let num = 0;
  let den = 0;
  const n = Math.min(gObs.length, gCalc.length);
  for (let i = 0; i < n; i++) {
    num += gObs[i]! * gCalc[i]!;
    den += gCalc[i]! * gCalc[i]!;
  }
  return den > 0 && num > 0 ? num / den : 1;
}

/**
 * Staged (guided) order for a PDF refinement — roadmap P1: scale first, the
 * cell (peak positions), then ADPs (peak widths), correlated motion (low-r
 * sharpening), positions, and occupancy last. Qdamp/Qbroad are instrument
 * constants calibrated from a standard and are deliberately not staged.
 */
export const PDF_STAGE_KINDS: readonly StageKinds[] = [
  { name: "scale", kinds: ["pdfScale"] },
  { name: "cell", kinds: ["cellLength", "cellAngle"] },
  { name: "ADP", kinds: ["bIso", "uAniso"] },
  { name: "correlated motion", kinds: ["delta1", "delta2"] },
  { name: "positions", kinds: ["positionShift"] },
  { name: "occupancy", kinds: ["occupancy"] },
];

/** Whether atoms sharing a crystallographic site are tied (mirrors `SiteTies`). */
export interface PdfSiteTies {
  readonly positions?: boolean;
  readonly adp?: boolean;
  readonly occupancyToUnity?: boolean;
}

export interface PdfSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly restraints: LinearRestraint[];
}

/**
 * Build the full PDF parameter set for a structure + observed G(r): the PDF
 * scale and envelope parameters, plus the same symmetry-reduced cell /
 * symmetry-adapted positions / per-site ADP / occupancy set the powder UI
 * refines.
 *
 * The structural parameters are emitted by `buildStructureRefinement` — whose
 * structural half is pattern-independent (the pattern only stamps binding
 * `targetId`s and gates profile/correction parameters, all disabled here) — so
 * the symmetry machinery (cell reduction, position/ADP modes, shared-site ties,
 * occupancy restraints) is reused rather than duplicated. Its reciprocal-space
 * leftovers (Rietveld `scale`, single `peakWidth`) are filtered out.
 *
 * Free on load: `pdfScale` and the cell — the safe first fit. ADPs, δ1/δ2,
 * positions, and occupancies start fixed (freed per row or by the guided
 * sequence); Qdamp/Qbroad start fixed at the header/calibration values.
 */
export function buildPdfSpec(structure: StructureModel, pattern: PdfPattern, ties: PdfSiteTies = {}): PdfSpec {
  // Minimal placeholder so the structural emitter can stamp binding targetIds.
  // Its unit/radiation are never read: no corrections are requested, no profile
  // options are set, and backgroundTerms = 0 emits no background.
  const placeholder: PowderPattern = {
    id: pattern.id,
    name: pattern.name,
    xUnit: "dSpacing",
    radiation: { kind: "neutron", wavelength: 1.5 },
    points: [],
  };
  const structural = buildStructureRefinement(structure, placeholder, {
    backgroundTerms: 0,
    refineOccupancy: true,
    tieSharedPositions: ties.positions ?? true,
    tieSharedAdp: ties.adp ?? true,
    constrainOccupancyToUnity: ties.occupancyToUnity ?? false,
  });
  const drop = new Set<ParameterKind>(["scale", "peakWidth"]);
  const keptIds = new Set(structural.params.filter((p) => !drop.has(p.kind)).map((p) => p.id));

  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const push = (p: RefinementParameter): void => {
    params.push(p);
    bindings.push({ parameterId: p.id, kind: p.kind, targetId: pattern.id });
  };
  push({ id: "pdfScale", label: "PDF scale", kind: "pdfScale", value: 1, initialValue: 1, min: 0, fixed: false });
  // Qdamp/Qbroad: instrument resolution, calibrated from a standard (Ni/Si) and
  // then held — refined only deliberately. Seed from the .gr header when the
  // reduction wrote them; else a moderate synchrotron/TOF ballpark for Qdamp.
  const qdamp = pattern.qdamp ?? 0.03;
  const qbroad = pattern.qbroad ?? 0;
  push({ id: "qdamp", label: "Qdamp", kind: "qdamp", value: qdamp, initialValue: qdamp, min: 0, max: 0.5, fixed: true });
  push({ id: "qbroad", label: "Qbroad", kind: "qbroad", value: qbroad, initialValue: qbroad, min: 0, max: 0.5, fixed: true });
  // Correlated-motion sharpening: δ1 (1/r) and δ2 (1/r²) are near-degenerate —
  // the guided sequence frees them in one stage but users typically keep one.
  push({ id: "delta1", label: "δ1 (corr. motion)", kind: "delta1", value: 0, initialValue: 0, min: 0, max: 5, fixed: true });
  push({ id: "delta2", label: "δ2 (corr. motion)", kind: "delta2", value: 0, initialValue: 0, min: 0, max: 10, fixed: true });
  // Nanoparticle sphere envelope: 0 = bulk (disabled). Set a starting diameter
  // by hand, then free it — refining from 0 is impossible (flat at the bound).
  push({ id: "spdiameter", label: "particle Ø (Å)", kind: "spdiameter", value: 0, initialValue: 0, min: 0, fixed: true });
  // Alternative correlated-motion model (PDFgui sratio/rcut): step-sharpen the
  // peaks below rcut instead of the smooth δ1/δ2 laws. Mutually exclusive with
  // δ1/δ2 — see correlatedMotionConflict; both start disabled.
  push({ id: "sratio", label: "sratio (r < rcut)", kind: "sratio", value: 1, initialValue: 1, min: 0.1, max: 1, fixed: true });
  push({ id: "rcut", label: "rcut (Å)", kind: "rcut", value: 0, initialValue: 0, min: 0, fixed: true });

  const structuralFixed = new Set<ParameterKind>(["bIso", "uAniso", "positionShift", "atomX", "atomY", "atomZ", "occupancy"]);
  for (const p of structural.params) {
    if (!keptIds.has(p.id)) continue;
    params.push(structuralFixed.has(p.kind) ? { ...p, fixed: true } : p);
  }
  for (const b of structural.bindings) {
    if (keptIds.has(b.parameterId)) bindings.push(b);
  }
  return { params, bindings, restraints: structural.restraints };
}

/**
 * Kinds the PDF guided (staged) sequence may unlock — the staged stages minus
 * occupancy (correlates with scale/ADP; freed only deliberately, mirroring the
 * powder guided flow) and minus δ2 (near-degenerate with δ1; δ1 carries the
 * correlated-motion stage).
 */
const PDF_GUIDED_UNLOCK: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "pdfScale", "cellLength", "cellAngle", "bIso", "uAniso", "delta1", "positionShift",
]);

/** Free the guided-refinable rows (per-row fixed choices are overridden). */
export function guidedPdfParams(params: readonly RefinementParameter[]): RefinementParameter[] {
  return params.map((p) => (PDF_GUIDED_UNLOCK.has(p.kind) ? { ...p, fixed: false } : { ...p }));
}

/**
 * The two correlated-motion models — smooth δ1/δ2 laws vs the sratio/rcut step
 * — describe the same physics and must not be refined together (they are
 * near-degenerate; PDFgui carries the same warning). Returns a user-facing
 * message when both families have free parameters, else null.
 */
export function correlatedMotionConflict(params: readonly RefinementParameter[]): string | null {
  const freeDelta = params.some((p) => !p.fixed && (p.kind === "delta1" || p.kind === "delta2"));
  const freeStep = params.some((p) => !p.fixed && (p.kind === "sratio" || p.kind === "rcut"));
  return freeDelta && freeStep
    ? "δ1/δ2 and sratio/rcut are alternative correlated-motion models — refine one family, fix the other."
    : null;
}
