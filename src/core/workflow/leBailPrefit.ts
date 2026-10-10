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
 * simplified profile and are re-refined properly by the real (Caglioti / TOF)
 * profile stages afterwards. A constant-wavelength pattern gets one FWHM; a TOF
 * pattern with `shape: "tof"` gets back-to-back-exponential peaks whose widths
 * grow with d (σ₁², σ₂², α, β₀ refined), since one width cannot span a TOF pattern —
 * its peaks broaden several-fold from short to long flight times. The cell parameters and bindings
 * are the caller's own powder cell parameters, so lattice-system symmetry
 * (a = b, γ = 120°, …) is preserved exactly.
 */

import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { AxialDivergence, PeakShape } from "@/core/diffraction/profile";
import type { FitRange } from "@/core/workflow/powder";
import { applyParameters } from "@/core/workflow/apply";
import { leBailExtract, tofFwhmAt, tofShapeAt, type Caglioti, type LeBailPhase, type LeBailTofProfile, type TofCalibration } from "@/core/workflow/leBail";
import { resolveTies } from "@/core/refinement/constraints";
import { weightsFromSigma, applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { refine, type RefinementProblem } from "@/core/refinement/engine";

const FWHM_ID = "__leBail_fwhm";
const BKG_ID = "__leBail_bkg";
const ETA_ID = "__leBail_eta";
const FWHM_U_ID = "__leBail_fwhmU";
const SIG1_ID = "__leBail_sig1";
const strainId = (i: number): string => `__leBail_strain_${i}`;
const widthId = (i: number): string => `__leBail_width_${i}`;
const SIG2_ID = "__leBail_sig2";
const ALPHA_ID = "__leBail_alpha";
const BETA0_ID = "__leBail_beta0";
const ZERO_ID = "__leBail_zero";
const ASYM_ID = "__leBail_asym";
/** Where the asymmetry starts: S/L = H/L = 0.01, a lab or CW-neutron value. */
const ASYM_START = 0.01;
/** Chebyshev background terms past the constant (`BKG_ID`). */
const bkgTermId = (j: number): string => `__leBail_bkg${j}`;
/** A TOF background follows the incident spectrum: four Chebyshev terms. */
const TOF_BACKGROUND_TERMS = 4;
/** A lab or synchrotron 2θ background slopes too (air scatter at low angle,
 *  fluorescence, the holder): a flat one left the whole slope as residual
 *  (Le Bail wR 50% on a sloped Cu Kα pattern). Three Chebyshev terms, one
 *  more per 20° of 2θ past 60°, up to eight: over 15–130° a quadratic fell
 *  from the air scatter at 15° to near zero at 100°, and the peaks there took
 *  up the background (fluorapatite, Cu tube). */
function cwBackgroundTerms(x: readonly number[], twoTheta: boolean): number {
  if (!twoTheta || x.length === 0) return 3;
  const span = Math.max(...x) - Math.min(...x);
  return Math.min(8, Math.max(3, 3 + Math.floor((span - 60) / 20)));
}

/**
 * Chebyshev coefficients of a smooth curve under the peaks: a low percentile
 * of the counts in each of several windows, fitted by least squares. The
 * background starts there rather than flat, so the free intensities do not
 * take it up before it can move.
 */
function backgroundSeed(y: readonly number[], cheb: readonly (readonly number[])[], terms: number): number[] | null {
  const n = y.length;
  const windows = Math.max(4 * terms, 12);
  const rows: { t: readonly number[]; v: number }[] = [];
  for (let w = 0; w < windows; w++) {
    const a = Math.floor((w * n) / windows);
    const b = Math.floor(((w + 1) * n) / windows);
    const counted = y.slice(a, b).filter((v) => v > 0).sort((p, q) => p - q);
    if (counted.length < 5) continue;
    rows.push({ t: cheb[(a + b) >> 1]!, v: counted[Math.floor(0.2 * (counted.length - 1))]! });
  }
  if (rows.length < terms) return null;
  // Normal equations, solved by Gaussian elimination with partial pivoting.
  const m = rows[0]!.t.length;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m + 1 }, (_, j) =>
    rows.reduce((sum, r) => sum + r.t[i]! * (j < m ? r.t[j]! : r.v), 0)));
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    if (Math.abs(A[c]![c]!) < 1e-12) return null;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k <= m; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const coef = A.map((row, i) => row[m]! / row[i]!);
  return coef.every(Number.isFinite) ? coef : null;
}

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
  /** Starting TOF peak coefficients (an instrument file's), for `shape: "tof"`.
   *  Without them the start is read off the data's binning. */
  readonly tofProfile?: LeBailTofProfile;
  /** Impurity phases fitted alongside, each with one refined expansion factor
   *  (lengths × (1 + ε), |ε| ≤ 3 %), enough to follow thermal expansion, and
   *  one width factor (0.5–4×), since each phase has its own microstructure. */
  readonly extraPhases?: readonly LeBailPhase[];
  /** Constant wavelength: the instrument's resolution curve (leBail.ts `caglioti`). */
  readonly caglioti?: Caglioti;
}

export interface LeBailPrefitResult {
  /** Refined FREE cell-parameter values (id → value), to seed the structure. */
  readonly cellValues: Record<string, number>;
  /** The refined unit cell. */
  readonly cell: UnitCell;
  /** Refined peak FWHM (a nuisance — not transferred to the structure). For a
   *  TOF fit, the FWHM at the middle of the pattern's d range. */
  readonly fwhm: number;
  /** The refined pseudo-Voigt Lorentzian fraction, for `shape: "pseudoVoigt"`. */
  readonly eta?: number;
  /** 2θ patterns: the width's growth with angle (see leBail.ts `fwhmU`); `fwhm` is then the width at the middle angle. */
  readonly fwhmU?: number;
  /** The refined TOF peak coefficients, when the fit used them. */
  readonly tofProfile?: LeBailTofProfile;
  /** Each extra phase's cell, expanded by its refined factor. */
  readonly extraCells: UnitCell[];
  /** Each extra phase's refined width factor. */
  readonly extraWidthScales: number[];
  /** 2θ patterns: the refined zero shift (degrees), a nuisance. */
  readonly zero?: number;
  /** 2θ patterns: the refined axial divergence (S/L = H/L), a nuisance. */
  readonly axial?: AxialDivergence;
  /** Refined background level, the constant term (a nuisance — not transferred). */
  readonly background: number;
  /** The refined background at each pattern point (flat at constant wavelength). */
  readonly backgroundCurve: number[];
  /** Weighted-profile R of the free-intensity fit (the best a correct cell + this
   *  simplified profile can do). */
  readonly rWeighted: number;
  /** Whether any free cell parameter was available to refine (else a no-op). */
  readonly refined: boolean;
}

/**
 * The relative width (FWHM/TOF) of the strongest peak: its half-maximum
 * crossings above the background. NaN when the peak is not resolved (fewer
 * than three points across, or it runs off the pattern's edge).
 */
function strongestPeakWidth(x: readonly number[], y: readonly number[], background: number): number {
  let top = 0;
  for (let i = 1; i < y.length; i++) if (y[i]! > y[top]!) top = i;
  const half = background + (y[top]! - background) / 2;
  if (!(y[top]! > background)) return NaN;
  const crossing = (dir: 1 | -1): number => {
    for (let i = top; i + dir >= 0 && i + dir < y.length; i += dir) {
      if (y[i + dir]! < half) return x[i]! + ((x[i + dir]! - x[i]!) * (y[i]! - half)) / (y[i]! - y[i + dir]!);
    }
    return NaN;
  };
  const lo = crossing(-1);
  const hi = crossing(1);
  const fwhm = Math.abs(hi - lo);
  const step = Math.abs(x[Math.min(top + 1, x.length - 1)]! - x[Math.max(top - 1, 0)]!) / 2;
  return Number.isFinite(fwhm) && fwhm >= 3 * step && x[top]! > 0 ? fwhm / x[top]! : NaN;
}

/** A TOF start read off the data: the strongest peak's measured FWHM/TOF (or,
 *  when it is not resolved, four bins), shared out as 60 % Gaussian, 10 % rising
 *  edge, 30 % falling tail at the middle d. The Gaussian variance is split
 *  evenly between the d² and d⁴ terms. */
function tofSeed(x: readonly number[], y: readonly number[], background: number, tof: TofCalibration, dMid: number): LeBailTofProfile {
  let r = strongestPeakWidth(x, y, background);
  if (!Number.isFinite(r)) {
    const ratios: number[] = [];
    for (let i = 1; i < x.length; i++) if (x[i - 1]! > 0) ratios.push(Math.abs(x[i]! - x[i - 1]!) / x[i - 1]!);
    ratios.sort((a, b) => a - b);
    r = 4 * (ratios[ratios.length >> 1] ?? 1e-3);
  }
  r = Math.min(Math.max(r, 2e-4), 0.05);
  const perD = r * tof.difC; // FWHM per Å of d, µs
  const gaussVar = ((0.6 * perD) / (2 * Math.sqrt(2 * Math.LN2))) ** 2;
  return {
    sig1: 0.5 * gaussVar,
    sig2: (0.5 * gaussVar) / (dMid * dMid),
    alpha: Math.LN2 / (0.1 * perD),
    beta0: Math.LN2 / (0.3 * perD * dMid),
  };
}

/** Lengths scaled by (1 + ε); angles kept. */
function expand(cell: UnitCell, eps: number): UnitCell {
  const f = 1 + eps;
  return { ...cell, a: cell.a * f, b: cell.b * f, c: cell.c * f };
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
  // With the instrument's curve, start at its width at the middle angle.
  const xSorted = [...x].sort((a, b) => a - b);
  const tMid = Math.tan(((xSorted[xSorted.length >> 1] ?? 0) * Math.PI) / 360);
  const curveMid = options.caglioti && pattern.xUnit === "twoTheta" ? options.caglioti.u * tMid * tMid + options.caglioti.v * tMid + options.caglioti.w : 0;
  const fwhm0 = options.fwhm0 ?? (curveMid > 0 ? Math.sqrt(curveMid) : Math.max(4 * medianStep(x), 1e-3));
  // A low percentile of the counted points, not the minimum: one dead point
  // (y = 0) started the background at zero, and the free-intensity fit then
  // filled it with peaks broadened across the whole pattern.
  const counted = yObs.filter((y) => y > 0).sort((a, b) => a - b);
  const bkg0 = counted.length ? counted[Math.floor(0.1 * (counted.length - 1))]! : 0;

  const extras = options.extraPhases ?? [];
  const tof = options.tof;
  const useTof = shape === "tof" && pattern.xUnit === "tof" && tof !== undefined;
  const dSpan = useTof ? [(Math.min(...x) - tof.zero) / tof.difC, (Math.max(...x) - tof.zero) / tof.difC] : [];
  const dMid = useTof ? Math.sqrt(Math.max(dSpan[0]!, 0.1) * dSpan[1]!) : 0;
  const tof0: LeBailTofProfile | undefined = useTof ? (options.tofProfile ?? tofSeed(x, yObs, bkg0, tof, dMid)) : undefined;

  // The FCJ tail is only drawn below 2θ = 90°, and only matters well below it.
  const lowAngle = pattern.xUnit === "twoTheta" && x.some((xi) => xi < 60);
  const freeCell = cellParameters.filter((p) => !p.fixed && !p.expression);
  if (freeCell.length === 0) {
    // Nothing to refine — return the current cell untouched.
    return {
      cellValues: {},
      cell: structure.cell,
      fwhm: tof0 ? tofFwhmAt(dMid, tof0) : fwhm0,
      ...(tof0 ? { tofProfile: tof0 } : {}),
      extraCells: extras.map((ph) => ph.cell),
      extraWidthScales: extras.map(() => 1),
      background: bkg0,
      backgroundCurve: x.map(() => bkg0),
      rWeighted: NaN,
      refined: false,
    };
  }

  // The width nuisances: one FWHM, or the TOF peak's σ₁², σ₂², α and β₀ (the
  // edges within a factor of 10 of their start; the other TOF terms held). The
  // variance terms may change sign — an instrument's own fit often has one
  // negative — within 100 times the Gaussian variance at the middle d.
  const varMid = tof0 ? tofShapeAt(dMid, tof0).sigma ** 2 : 0;
  const varRange = (value: number, perD: number): [number, number] => {
    const r = 100 * Math.max(Math.abs(value), varMid / perD);
    return [-r, r];
  };
  const nuisance = (id: string, label: string, kind: RefinementParameter["kind"], value: number, min: number, max: number): RefinementParameter =>
    ({ id, label, kind, value, initialValue: value, min, max, fixed: false });
  const widthParams: RefinementParameter[] = tof0
    ? [
      nuisance(SIG1_ID, "Le Bail TOF σ₁²", "tofProfile", tof0.sig1, ...varRange(tof0.sig1, dMid ** 2)),
      nuisance(SIG2_ID, "Le Bail TOF σ₂²", "tofProfile", tof0.sig2 ?? 0, ...varRange(tof0.sig2 ?? 0, dMid ** 4)),
      nuisance(ALPHA_ID, "Le Bail TOF α", "tofProfile", tof0.alpha, tof0.alpha / 10, tof0.alpha * 10),
      nuisance(BETA0_ID, "Le Bail TOF β₀", "tofProfile", tof0.beta0, tof0.beta0 / 10, tof0.beta0 * 10),
    ]
    : [
      nuisance(FWHM_ID, "Le Bail FWHM", "peakWidth", fwhm0, fwhm0 * 0.05, fwhm0 * 20),
      // On a 2θ pattern the width grows with angle (Caglioti's U): one width
      // left high-angle flanks as false unindexed peaks (Mn₃Ga 30 K, 5–130°).
      ...(pattern.xUnit === "twoTheta" ? [nuisance(FWHM_U_ID, "Le Bail FWHM growth U", "peakWidth", 0, -100 * fwhm0 * fwhm0, 400 * fwhm0 * fwhm0)] : []),
      // A fixed η = 0.5 overshot every tail of Gaussian-like peaks, and once
      // the partition gave peaks their full intensity those tails dragged the
      // residual baseline negative between lines.
      ...(shape === "pseudoVoigt" ? [nuisance(ETA_ID, "Le Bail η", "peakWidth", eta, 0, 1)] : []),
      // A lab instrument's zero error and the axial-divergence tail of its
      // low-angle lines: without them the cell takes up the zero, and every
      // strong line's tail is left as a leftover peak (fluorapatite, Cu tube).
      ...(pattern.xUnit === "twoTheta" ? [nuisance(ZERO_ID, "Le Bail zero shift", "zeroShift", 0, -1, 1)] : []),
      ...(lowAngle ? [nuisance(ASYM_ID, "Le Bail axial divergence S/L = H/L", "asymSL", ASYM_START, 0, 0.1)] : []),
    ];
  const bkgTerms: number = useTof ? TOF_BACKGROUND_TERMS : cwBackgroundTerms(x, pattern.xUnit === "twoTheta");
  // Chebyshev polynomials over the pattern's own x span.
  const xLo = Math.min(...x);
  const xHi = Math.max(...x);
  const cheb = x.map((xi) => {
    const u = xHi > xLo ? (2 * (xi - xLo)) / (xHi - xLo) - 1 : 0;
    const t = [1, u];
    for (let j = 2; j < bkgTerms; j++) t.push(2 * u * t[j - 1]! - t[j - 2]!);
    return t.slice(0, bkgTerms);
  });
  // A 2θ background starts from the curve under the peaks (the constant term kept ≥ 0).
  const seed = pattern.xUnit === "twoTheta" ? backgroundSeed(yObs, cheb, bkgTerms) : null;
  const c0Start = seed ? Math.max(seed[0]!, 0) : bkg0;
  const bkgParam: RefinementParameter = {
    id: BKG_ID, label: "Le Bail background", kind: "background",
    value: c0Start, initialValue: c0Start, min: 0, fixed: false,
  };
  const bkgShapeParams = Array.from({ length: bkgTerms - 1 }, (_, j) => {
    const v = seed?.[j + 1] ?? 0;
    return { id: bkgTermId(j + 1), label: `Le Bail background T${j + 1}`, kind: "background", value: v, initialValue: v, fixed: false } as RefinementParameter;
  });
  const backgroundAt = (v: Record<string, number>): number | number[] => {
    const c0 = Math.max(v[BKG_ID] ?? c0Start, 0);
    if (bkgTerms === 1) return c0;
    const c = [c0, ...Array.from({ length: bkgTerms - 1 }, (_, j) => v[bkgTermId(j + 1)] ?? 0)];
    return cheb.map((t) => c.reduce((sum, cj, j) => sum + cj * t[j]!, 0));
  };
  // Full list (fixed + tied cell params included so resolveTies/applyParameters
  // reproduce the symmetry-constrained cell exactly) + the nuisances.
  const strainParams = extras.map((_, i) => nuisance(strainId(i), `Le Bail phase ${i + 2} expansion`, "cellLength", 0, -0.03, 0.03));
  const phaseWidthParams = extras.map((_, i) => nuisance(widthId(i), `Le Bail phase ${i + 2} width`, "peakWidth", 1, 0.5, 4));
  const allParams: RefinementParameter[] = [...cellParameters, ...widthParams, bkgParam, ...bkgShapeParams, ...strainParams, ...phaseWidthParams];
  const extraAt = (v: Readonly<Record<string, number>>): LeBailPhase[] =>
    extras.map((ph, i) => ({ cell: expand(ph.cell, v[strainId(i)] ?? 0), spaceGroup: ph.spaceGroup, widthScale: v[widthId(i)] ?? 1 }));
  const tofAt = (v: Record<string, number>): LeBailTofProfile | undefined => tof0 && {
    ...tof0,
    sig1: v[SIG1_ID] ?? tof0.sig1,
    sig2: v[SIG2_ID] ?? tof0.sig2 ?? 0,
    alpha: v[ALPHA_ID] ?? tof0.alpha,
    beta0: v[BETA0_ID] ?? tof0.beta0,
  };


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
      const fwhmU = resolved[FWHM_U_ID] ?? 0;
      const background = backgroundAt(resolved);
      const tofProfile = tofAt(resolved);
      const lb = leBailExtract(pattern, cell, structure.spaceGroup, {
        fwhm, fwhmU, shape, eta: resolved[ETA_ID] ?? eta, cycles, background,
        ...(resolved[ZERO_ID] !== undefined ? { zero: resolved[ZERO_ID] } : {}),
        ...(resolved[ASYM_ID] !== undefined ? { axial: { sl: resolved[ASYM_ID], hl: resolved[ASYM_ID] } } : {}),
        ...(options.caglioti ? { caglioti: options.caglioti } : {}),
        ...(options.tof ? { tof: options.tof } : {}),
        ...(tofProfile ? { tofProfile } : {}),
        ...(extras.length ? { extraPhases: extraAt(resolved) } : {}),
      });
      return Float64Array.from(lb.yCalc);
    },
  };

  const maxIterations = options.maxIterations ?? 12;
  // The zero shift and the asymmetry are freed only once the cell has
  // converged without them: from a cell a few per cent off, a free zero lines
  // up some of the misplaced peaks and holds the cell in a false minimum.
  const staged = new Set([ZERO_ID, ASYM_ID]);
  const hasStaged = allParams.some((p) => staged.has(p.id));
  const cost = (v: Readonly<Record<string, number>>): number => {
    const calc = problem.calculate(v);
    let sum = 0;
    for (let i = 0; i < calc.length; i++) sum += weights[i]! * (yObs[i]! - calc[i]!) ** 2;
    return sum;
  };
  const valuesOf = (params: readonly RefinementParameter[]): Record<string, number> => Object.fromEntries(params.map((p) => [p.id, p.value]));
  const unstaged = hasStaged ? allParams.map((p) => (staged.has(p.id) ? { ...p, value: 0, initialValue: 0, fixed: true } : p)) : allParams;
  // The background starts from the curve under the peaks, or flat at a low
  // percentile, whichever fits better as it stands: the curve follows a lab
  // pattern's air scatter, but where peaks overlap everywhere it rides on them.
  const flat = unstaged.map((p) => (p.id === BKG_ID ? { ...p, value: bkg0, initialValue: bkg0 } : bkgShapeParams.some((b) => b.id === p.id) ? { ...p, value: 0, initialValue: 0 } : p));
  const firstParams = seed && cost(valuesOf(flat)) < cost(valuesOf(unstaged)) ? flat : unstaged;
  const first = extras.length === 0 ? refine({ ...problem, parameters: firstParams }, { maxIterations }) : (() => {
    // An impurity's lines can soak up misfit wherever they land, so its cell
    // has local minima a few line widths apart. Converge the rest with the
    // impurity cells held, scan each expansion in quarter-width steps, then
    // free everything from the best point. (Mn₃Ga 600 K: MnO's minimum is at
    // +0.25 %, its thermal expansion from the room-temperature CIF.)
    const held = refine({ ...problem, parameters: firstParams.map((p) => (strainParams.includes(p) ? { ...p, fixed: true } : p)) }, { maxIterations });
    const values: Record<string, number> = { ...held.parameters };
    // The peak width as a relative d shift, at the middle of the pattern.
    const xMid = [...x].sort((a, b) => a - b)[x.length >> 1]!;
    const fwhmNow = values[FWHM_ID] ?? fwhm0;
    const tofNow = tofAt(values);
    const relWidth = tofNow ? tofFwhmAt(dMid, tofNow) / (tof!.difC * dMid)
      : pattern.xUnit === "twoTheta" ? (fwhmNow * Math.PI) / 180 / (2 * Math.tan((xMid * Math.PI) / 360))
      : fwhmNow / Math.abs(xMid);
    const step = Math.min(Math.max(relWidth / 4, 2e-4), 0.005);
    for (const sp of strainParams) {
      let best = { eps: 0, c: cost(values) };
      for (let eps = sp.min!; eps <= sp.max! + 1e-12; eps += step) {
        const c = cost({ ...values, [sp.id]: eps });
        if (c < best.c) best = { eps, c };
      }
      values[sp.id] = best.eps;
    }
    return refine({ ...problem, parameters: firstParams.map((p) => ({ ...p, value: values[p.id] ?? p.value })) }, { maxIterations });
  })();
  // Then the zero and the asymmetry, from the converged point; kept only if
  // the fit improves.
  const second = hasStaged
    ? refine({ ...problem, parameters: allParams.map((p) => ({ ...p, value: p.id === ASYM_ID ? ASYM_START : staged.has(p.id) ? 0 : first.parameters[p.id] ?? p.value })) }, { maxIterations })
    : null;
  const result = second && (second.agreement.rWeighted ?? Infinity) < (first.agreement.rWeighted ?? Infinity) ? second : first;

  const merged: Record<string, number> = {};
  for (const p of cellParameters) merged[p.id] = result.parameters[p.id] ?? p.value;
  const cellValues: Record<string, number> = {};
  for (const p of freeCell) cellValues[p.id] = result.parameters[p.id] ?? p.value;
  const cell = applyParameters(structure, cellBindings, resolveTies(cellParameters, merged)).model.cell;

  const tofProfile = tofAt(result.parameters);
  return {
    cellValues,
    cell,
    fwhm: tofProfile ? tofFwhmAt(dMid, tofProfile) : result.parameters[FWHM_ID] ?? fwhm0,
    ...(tofProfile ? { tofProfile } : {}),
    ...(shape === "pseudoVoigt" ? { eta: result.parameters[ETA_ID] ?? eta } : {}),
    ...(result.parameters[FWHM_U_ID] !== undefined ? { fwhmU: result.parameters[FWHM_U_ID] } : {}),
    ...(result.parameters[ZERO_ID] ? { zero: result.parameters[ZERO_ID] } : {}),
    ...(result.parameters[ASYM_ID] ? { axial: { sl: result.parameters[ASYM_ID], hl: result.parameters[ASYM_ID] } } : {}),
    extraCells: extraAt(result.parameters).map((ph) => ph.cell),
    extraWidthScales: extraAt(result.parameters).map((ph) => ph.widthScale ?? 1),
    background: result.parameters[BKG_ID] ?? bkg0,
    backgroundCurve: ((b) => (typeof b === "number" ? x.map(() => b) : b))(backgroundAt(result.parameters)),
    rWeighted: result.agreement.rWeighted ?? NaN,
    refined: true,
  };
}
