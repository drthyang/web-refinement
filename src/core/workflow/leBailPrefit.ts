/**
 * Le Bail cell pre-fit — decoupling the cell from the structure to dodge local
 * minima.
 *
 * The deepest local-minimum trap in Rietveld refinement is a wrong unit cell:
 * it mis-positions *every* peak, so the structure factors fight the profile and
 * the coupled solve stalls far from the truth. A Le Bail fit sidesteps this by
 * letting each reflection's intensity float freely (`leBailExtract`), so the
 * pattern is driven purely by peak POSITIONS — i.e. by the cell — with no
 * structural model at all. Refining the cell (plus a scalar width + flat
 * background as nuisances) against that free-intensity reconstruction nails the
 * cell independent of the structure; that converged cell then seeds the Rietveld
 * ladder from a much better point.
 *
 * Only the CELL is transferred back: the width/background here use `leBailExtract`'s
 * simplified single-FWHM profile and are re-refined properly by the real
 * (Caglioti / TOF) profile stages afterwards. The cell parameters and bindings
 * are the caller's own powder cell parameters, so lattice-system symmetry
 * (a = b, γ = 120°, …) is preserved exactly.
 */

import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { PeakShape } from "@/core/diffraction/profile";
import type { FitRange } from "@/core/workflow/powder";
import { applyParameters } from "@/core/workflow/apply";
import { leBailExtract, type TofCalibration } from "@/core/workflow/leBail";
import { resolveTies } from "@/core/refinement/constraints";
import { weightsFromSigma, applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { refine, type RefinementProblem } from "@/core/refinement/engine";

const FWHM_ID = "__leBail_fwhm";
const BKG_ID = "__leBail_bkg";

export interface LeBailPrefitOptions {
  readonly shape?: PeakShape;
  readonly eta?: number;
  /** Initial scalar FWHM (pattern x-units). Default ≈ 4× the median grid step. */
  readonly fwhm0?: number;
  /** Le Bail intensity-extraction cycles per evaluation. Default 6. */
  readonly cycles?: number;
  readonly fitRange?: FitRange;
  readonly maxIterations?: number;
  /** TOF diffractometer calibration — REQUIRED for a TOF pattern (else every
   *  reflection maps to a NaN position and the fit is degenerate). */
  readonly tof?: TofCalibration;
}

export interface LeBailPrefitResult {
  /** Refined FREE cell-parameter values (id → value), to seed the structure. */
  readonly cellValues: Record<string, number>;
  /** The refined unit cell. */
  readonly cell: UnitCell;
  /** Refined scalar peak FWHM (a nuisance — not transferred to the structure). */
  readonly fwhm: number;
  /** Refined flat background (a nuisance — not transferred). */
  readonly background: number;
  /** Weighted-profile R of the free-intensity fit (the best a correct cell + this
   *  simplified profile can do). */
  readonly rWeighted: number;
  /** Whether any free cell parameter was available to refine (else a no-op). */
  readonly refined: boolean;
}

function medianStep(x: readonly number[]): number {
  if (x.length < 2) return 0.02;
  const steps = [];
  for (let i = 1; i < x.length; i++) steps.push(Math.abs(x[i]! - x[i - 1]!));
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1] ?? 0.02;
}

/**
 * Refine the unit cell of `structure` by a Le Bail (free-intensity) fit of
 * `pattern`, using the caller's own cell parameters + bindings (so symmetry is
 * preserved). Returns the refined cell + free cell-parameter values to seed a
 * subsequent structural refinement. Pure and synchronous — run it in the compute
 * worker (each evaluation extracts intensities over the whole pattern).
 */
export function leBailCellPrefit(
  structure: StructureModel,
  pattern: PowderPattern,
  cellParameters: readonly RefinementParameter[],
  cellBindings: readonly ParameterBinding[],
  options: LeBailPrefitOptions = {},
): LeBailPrefitResult {
  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const shape = options.shape ?? "gaussian";
  const eta = options.eta ?? 0.5;
  const cycles = options.cycles ?? 6;
  const fwhm0 = options.fwhm0 ?? Math.max(4 * medianStep(x), 1e-3);
  const bkg0 = Math.max(0, Math.min(...yObs));

  const freeCell = cellParameters.filter((p) => !p.fixed && !p.expression);
  if (freeCell.length === 0) {
    // Nothing to refine — return the current cell untouched.
    return {
      cellValues: {},
      cell: structure.cell,
      fwhm: fwhm0,
      background: bkg0,
      rWeighted: NaN,
      refined: false,
    };
  }

  const fwhmParam: RefinementParameter = {
    id: FWHM_ID, label: "Le Bail FWHM", kind: "peakWidth",
    value: fwhm0, initialValue: fwhm0, min: fwhm0 * 0.05, max: fwhm0 * 20, fixed: false,
  };
  const bkgParam: RefinementParameter = {
    id: BKG_ID, label: "Le Bail background", kind: "background",
    value: bkg0, initialValue: bkg0, min: 0, fixed: false,
  };
  // Full list (fixed + tied cell params included so resolveTies/applyParameters
  // reproduce the symmetry-constrained cell exactly) + the two nuisances.
  const allParams: RefinementParameter[] = [...cellParameters, fwhmParam, bkgParam];

  const weights = applyExclusionMask(
    weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1))),
    fitRangeMask(x, options.fitRange),
  );

  const problem: RefinementProblem = {
    parameters: allParams,
    observations: Float64Array.from(yObs),
    weights,
    calculate: (values) => {
      const resolved = resolveTies(allParams, values);
      const cell = applyParameters(structure, cellBindings, resolved).model.cell;
      const fwhm = Math.max(resolved[FWHM_ID] ?? fwhm0, 1e-4);
      const background = Math.max(resolved[BKG_ID] ?? bkg0, 0);
      const lb = leBailExtract(pattern, cell, structure.spaceGroup, { fwhm, shape, eta, cycles, background, ...(options.tof ? { tof: options.tof } : {}) });
      return Float64Array.from(lb.yCalc);
    },
  };

  const result = refine(problem, { maxIterations: options.maxIterations ?? 12 });

  const merged: Record<string, number> = {};
  for (const p of cellParameters) merged[p.id] = result.parameters[p.id] ?? p.value;
  const cellValues: Record<string, number> = {};
  for (const p of freeCell) cellValues[p.id] = result.parameters[p.id] ?? p.value;
  const cell = applyParameters(structure, cellBindings, resolveTies(cellParameters, merged)).model.cell;

  return {
    cellValues,
    cell,
    fwhm: result.parameters[FWHM_ID] ?? fwhm0,
    background: result.parameters[BKG_ID] ?? bkg0,
    rWeighted: result.agreement.rWeighted ?? NaN,
    refined: true,
  };
}
