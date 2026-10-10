/**
 * The cell / space-group check at the start of a refinement: do the cell and
 * the space group account for the pattern? A sanity check, not a gate — it
 * catches gross problems (a wrong cell, a missing phase) before the structure
 * is refined. Two questions, each answered from the data rather than from an
 * agreement factor:
 *
 *  1. **Does every observed peak index?** A peak no reflection of the cell can
 *     place means a wrong cell (or lattice) or a missing phase.
 *  2. **Are the systematic absences real?** A reflection the space group forbids
 *     that shows intensity MAY mean the group is too symmetric — a centring or
 *     a glide the crystal does not have. Before the structure is refined this
 *     is a flag to record, not a verdict: profile misfit and an impurity's line
 *     read the same way, and the space group is reviewed last, on the refined
 *     residual (diagnostics/symmetryReview.ts), once everything else is refined.
 *
 * A low Le Bail wR alone cannot answer either: free intensities fit a wrong
 * group happily. So the check refines the cell by a Le Bail fit (free
 * intensities, `leBailCellPrefit`), extracts the pattern with the ALLOWED
 * reflections only, and reads what is left over. The leftover, after a slowly
 * varying baseline is removed, is signal the model's reflection list cannot
 * place:
 *
 *  - each forbidden family is tested at its own position. It is *violated* when
 *    the leftover there reaches `significance` σ, and *untestable* when it sits
 *    within a peak width of an allowed reflection (or of an extra phase's), where
 *    intensity cannot be told apart;
 *  - each leftover peak reaching `significance` σ that is near NO reflection at
 *    all is *unindexed*.
 *
 * Limits, stated in the result: a cell that is too LARGE (a supercell) indexes
 * any pattern, so this check cannot catch one; a group with FEWER absences than
 * the crystal's shows no violation (its extra reflections are simply weak).
 *
 * The Le Bail fit uses one pseudo-Voigt width at constant wavelength. On
 * time-of-flight data it uses back-to-back-exponential peaks whose widths grow
 * with d, as real TOF resolution does: one width cannot span a TOF pattern, and
 * a Gaussian leaves the asymmetric tails as false peaks. Known impurity phases
 * are fitted too, each with a refined expansion factor (|ε| ≤ 3 %) and width
 * factor, so their lines are modelled at the sample's temperature and with
 * their own broadening rather than left over.
 *
 * The check reads only d ≥ `dMin` (0.7 Å by default). Below that, reflections
 * crowd too closely to index a peak or test an absence, and the diagnostic
 * low-order lines all lie above it. It also keeps the Le Bail fit fast: the
 * reflection count grows as 1/d³.
 */

import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { PeakShape } from "@/core/diffraction/profile";
import type { FitRange } from "@/core/workflow/powder";
import { generateReflections } from "@/core/diffraction/reflections";
import { cwWidth, dRange, dToX, leBailExtract, tofFwhmAt, type Caglioti, type LeBailTofProfile, type TofCalibration } from "@/core/workflow/leBail";
import { leBailCellPrefit } from "@/core/workflow/leBailPrefit";

export interface CellSymmetryCheckOptions {
  readonly shape?: PeakShape;
  readonly eta?: number;
  /** Required for a time-of-flight pattern. */
  readonly tof?: TofCalibration;
  /** Starting TOF peak coefficients, e.g. from the instrument file. */
  readonly tofProfile?: LeBailTofProfile;
  /** Constant wavelength: the instrument's resolution curve, from its file (leBail.ts). */
  readonly caglioti?: Caglioti;
  readonly fitRange?: FitRange;
  /** Smallest d-spacing (Å) the check reads. Default 0.7. */
  readonly dMin?: number;
  /** Other phases known to be present: fitted alongside, and their reflections
   *  count as indexing a peak. */
  readonly extraPhases?: readonly StructureModel[];
  /** Leftover height, in σ, that counts as observed intensity. Default 5. */
  readonly significance?: number;
  /**
   * Model-error floor as a fraction of the calculated peak height nearby (the
   * tallest within one peak width): σ² = σ_count² + (f·y_peak)². The Le Bail
   * profile cannot match every peak's real shape, and on high-count data a 1 %
   * shape mismatch is many counting σ — without a floor, the shoulders of
   * strong peaks read as extra peaks. Default 0.05.
   */
  readonly modelError?: number;
  /** How close a leftover peak must be to a reflection to count as indexed, in peak widths. Default 1. */
  readonly tolerance?: number;
  /**
   * Separation below which a forbidden reflection cannot be told from an
   * allowed one, in peak widths. Default 1.5. It must clear the ±½-width test
   * window by a margin, or a strong allowed peak's tail would read as a violation.
   */
  readonly overlap?: number;
}

export interface HklAt {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  /** Position on the pattern's axis. */
  readonly x: number;
}

export interface CellSymmetryCheck {
  /** Both hold: every peak indexes and no absence shows intensity. */
  readonly passed: boolean;
  readonly everyPeakIndexes: boolean;
  readonly absencesConsistent: boolean;
  /** The cell after the Le Bail fit, and the refined cell-parameter values by id. */
  readonly cell: UnitCell;
  readonly cellValues: Readonly<Record<string, number>>;
  /** The Le Bail fit: `fwhm` is at the middle of the pattern on TOF data. */
  readonly leBail: { readonly rWeighted: number; readonly fwhm: number; readonly background: number };
  /** Leftover peaks near no reflection (strongest first). */
  readonly unindexedPeaks: readonly { readonly x: number; readonly significance: number }[];
  readonly absences: {
    /** Forbidden families inside the data that could be tested. */
    readonly tested: number;
    readonly violated: readonly (HklAt & { readonly significance: number })[];
    /** Forbidden families too close to an allowed reflection to judge. */
    readonly untestable: readonly (HklAt & { readonly overlaps: string })[];
  };
  /** What this check cannot see; always worth reading with the verdict. */
  readonly limits: readonly string[];
}

const LIMITS = [
  "A cell that is too large (a supercell) indexes any pattern; this check cannot catch one.",
  "A space group with fewer absences than the crystal's shows no violation: its extra reflections are just weak.",
];

const hkl = (r: { h: number; k: number; l: number }): string => `${r.h} ${r.k} ${r.l}`;

/** Median of a sample (copies and sorts). */
function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * A slowly varying baseline under `y`: the running median over `window`
 * points, evaluated every `stride` points and interpolated. Robust to peaks.
 */
function runningMedian(y: readonly number[], window: number): number[] {
  const n = y.length;
  const half = Math.max(1, Math.floor(window / 2));
  const stride = Math.max(1, Math.floor(half / 4));
  const knots: { i: number; v: number }[] = [];
  for (let i = 0; i < n; i += stride) knots.push({ i, v: median(y.slice(Math.max(0, i - half), Math.min(n, i + half + 1))) });
  if (knots[knots.length - 1]!.i !== n - 1) knots.push({ i: n - 1, v: median(y.slice(Math.max(0, n - 1 - half), n)) });
  const out = new Array<number>(n);
  for (let j = 0; j + 1 < knots.length; j++) {
    const a = knots[j]!;
    const b = knots[j + 1]!;
    for (let i = a.i; i <= b.i; i++) out[i] = a.v + ((b.v - a.v) * (i - a.i)) / Math.max(1, b.i - a.i);
  }
  return out;
}

/**
 * Check the cell and the space group of `structure` against `pattern`.
 * `cellParameters` / `cellBindings` are the structure's cell rows (from the
 * powder spec), so the Le Bail fit keeps the lattice's symmetry.
 */
export function checkCellSymmetry(
  structure: StructureModel,
  fullPattern: PowderPattern,
  cellParameters: readonly RefinementParameter[],
  cellBindings: readonly ParameterBinding[],
  options: CellSymmetryCheckOptions = {},
): CellSymmetryCheck {
  // Pseudo-Voigt for constant wavelength: a Gaussian misses the Lorentzian
  // tails, whose shoulders then read as extra peaks (GaNb₄Se₈ at 28-ID). TOF
  // peaks are back-to-back exponentials whose widths grow with d; one Gaussian
  // width left their tails as false peaks (Mn₃Ga at POWGEN).
  const shape = options.shape ?? (fullPattern.xUnit === "tof" ? "tof" : "pseudoVoigt");
  const eta = options.eta ?? 0.5;
  const threshold = options.significance ?? 5;
  const tolWidths = options.tolerance ?? 1;
  const overlapWidths = options.overlap ?? 1.5;
  /** Half-width of the window a forbidden reflection is tested in, in peak widths. */
  const testWidths = 0.5;
  const tof = options.tof;
  const dMinRead = options.dMin ?? 0.7;
  const pattern = readWindow(fullPattern, dMinRead, options.fitRange, tof);
  if (pattern.points.length < 20) {
    throw new Error(`only ${pattern.points.length} points lie at d ≥ ${dMinRead} Å inside the fit range — widen the range or lower dMin`);
  }
  const place = (d: number): number => dToX(pattern, d, tof);

  // 1. The cell, from peak positions alone (free intensities).
  const free = cellParameters.map((p) => ({ ...p, fixed: p.expression ? p.fixed : false }));
  const extraPhases = options.extraPhases ?? [];
  const pre = leBailCellPrefit(structure, pattern, free, cellBindings, {
    shape, eta,
    ...(tof ? { tof } : {}),
    ...(options.tofProfile ? { tofProfile: options.tofProfile } : {}),
    ...(options.caglioti ? { caglioti: options.caglioti } : {}),
    ...(extraPhases.length ? { extraPhases } : {}),
  });
  const cell = pre.cell;

  // 2. What the allowed reflections (and the extra phases') cannot account for.
  const lb = leBailExtract(pattern, cell, structure.spaceGroup, {
    fwhm: pre.fwhm, ...(pre.fwhmU !== undefined ? { fwhmU: pre.fwhmU } : {}), shape, eta: pre.eta ?? eta, background: pre.backgroundCurve,
    ...(options.caglioti ? { caglioti: options.caglioti } : {}),
    ...(tof ? { tof } : {}),
    ...(pre.tofProfile ? { tofProfile: pre.tofProfile } : {}),
    ...(extraPhases.length ? { extraPhases: extraPhases.map((ph, i) => ({ cell: pre.extraCells[i] ?? ph.cell, spaceGroup: ph.spaceGroup, widthScale: pre.extraWidthScales[i] ?? 1 })) } : {}),
  });
  const x = lb.x;
  const n = x.length;
  const residual = x.map((_, i) => lb.yObs[i]! - lb.yCalc[i]!);
  const step = median(x.slice(1).map((xi, i) => Math.abs(xi - x[i]!)).filter((s) => s > 0)) || 1;
  const baseline = runningMedian(residual, Math.max(15, Math.round((12 * pre.fwhm) / step)));

  // The peak width at a position: the refined TOF width at that d, or the one
  // Le Bail width (grown with TOF when the fit had no TOF peak shape).
  const xMid = median(x);
  const tofProfile = pre.tofProfile;
  const cw = cwWidth(pattern, pre.fwhm, pre.fwhmU ?? 0, options.caglioti);
  const width = (xi: number): number =>
    tofProfile && tof ? tofFwhmAt((xi - tof.zero) / tof.difC, tofProfile)
      : pattern.xUnit === "tof" && xMid > 0 ? pre.fwhm * (xi / xMid) : cw(xi);

  // A shape error is a fraction of the peak it belongs to, spread across that
  // peak — not of the calculated value at the same point, which on a steep
  // flank is small (Mn₃Ga at POWGEN left 5–10σ lobes beside its strong lines).
  // So the floor scales with the tallest calculated peak within one width.
  const net = x.map((_, i) => Math.max(lb.yCalc[i]! - pre.backgroundCurve[i]!, 0));
  const envelope = x.map((xi, i) => {
    const w = width(xi);
    let top = net[i]!;
    for (let j = i - 1; j >= 0 && Math.abs(x[j]! - xi) <= w; j--) top = Math.max(top, net[j]!);
    for (let j = i + 1; j < n && Math.abs(x[j]! - xi) <= w; j++) top = Math.max(top, net[j]!);
    return top;
  });
  const f = options.modelError ?? 0.05;
  const sigma = pattern.points.map((p, i) => {
    const counting = p.sigma ?? Math.sqrt(Math.max(p.yObs, 1));
    const model = f * envelope[i]!;
    return Math.sqrt(counting * counting + model * model) || 1;
  });
  const z = residual.map((r, i) => (r - baseline[i]!) / sigma[i]!);
  const xMin = Math.min(x[0]!, x[n - 1]!);
  const xMax = Math.max(x[0]!, x[n - 1]!);
  const inside = (xi: number): boolean => Number.isFinite(xi) && xi >= xMin && xi <= xMax;
  const nearestIndex = (xi: number): number => {
    let lo = 0;
    let hi = n - 1;
    const asc = x[n - 1]! >= x[0]!;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((x[mid]! < xi) === asc) lo = mid;
      else hi = mid;
    }
    return Math.abs(x[lo]! - xi) <= Math.abs(x[hi]! - xi) ? lo : hi;
  };
  /** Is point i the highest leftover over a whole peak width either side? */
  const isApex = (i: number): boolean => {
    const half = Math.max(2, Math.round(width(x[i]!) / step));
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (z[j]! > z[i]!) return false;
    return true;
  };
  /**
   * The leftover peak (in σ) within ±halfWidth of xi, or 0 when the largest
   * leftover there is not a peak's apex: a rising flank toward a neighbour's
   * misfit is that neighbour's intensity, not this reflection's.
   */
  const peakAt = (xi: number, halfWidth: number): number => {
    const a = nearestIndex(xi - halfWidth);
    const b = nearestIndex(xi + halfWidth);
    let at = nearestIndex(xi);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (Math.abs(x[i]! - xi) <= halfWidth && z[i]! > z[at]!) at = i;
    return isApex(at) ? z[at]! : 0;
  };

  // Every reflection position that can index a peak: allowed ones, and the extra
  // phases'. The d span is the pattern's own, not the allowed reflections' — a
  // forbidden family below the first allowed one (bcc's 100) must be tested too.
  const { dMin: dLo, dMax: dHi } = dRange(pattern, tof);
  const allowed: HklAt[] = lb.reflections.filter((r) => inside(r.center)).map((r) => ({ h: r.h, k: r.k, l: r.l, d: r.d, x: r.center }));
  if (allowed.length === 0) {
    throw new Error("the cell places no reflection inside the data's range — a wrong cell or wavelength, or no structure loaded");
  }
  // The extra phases' reflections, at their refined cells.
  const others: { x: number; label: string }[] = extraPhases.flatMap((phase, i) =>
    (lb.extraReflections[i] ?? []).filter((r) => inside(r.center)).map((r) => ({ x: r.center, label: `${phase.name || phase.id} ${hkl(r)}` })));
  const closest = <T extends { x: number }>(list: readonly T[], xi: number): T | undefined => {
    let best: T | undefined;
    for (const r of list) if (!best || Math.abs(r.x - xi) < Math.abs(best.x - xi)) best = r;
    return best;
  };

  // 3. The forbidden families, one by one.
  const allowedKeys = new Set(lb.reflections.map(hkl));
  const forbidden: HklAt[] = !(Number.isFinite(dLo) && dHi > 0)
    ? []
    : generateReflections(cell, structure.spaceGroup, dLo * 0.98, dHi * 1.02, { absences: false })
      .filter((r) => !allowedKeys.has(hkl(r)))
      .map((r) => ({ h: r.h, k: r.k, l: r.l, d: r.d, x: place(r.d) }))
      .filter((r) => inside(r.x));
  const violated: (HklAt & { significance: number })[] = [];
  const untestable: (HklAt & { overlaps: string })[] = [];
  let tested = 0;
  for (const f of forbidden) {
    const w = width(f.x);
    const near = closest(allowed, f.x);
    const nearOther = closest(others, f.x);
    if (near && Math.abs(near.x - f.x) < overlapWidths * w) {
      untestable.push({ ...f, overlaps: hkl(near) });
      continue;
    }
    if (nearOther && Math.abs(nearOther.x - f.x) < overlapWidths * w) {
      untestable.push({ ...f, overlaps: nearOther.label });
      continue;
    }
    tested++;
    const s = peakAt(f.x, testWidths * w);
    if (s >= threshold) violated.push({ ...f, significance: s });
  }

  // 4. Leftover peaks near no reflection at all.
  const everything = [...allowed.map((r) => r.x), ...forbidden.map((r) => r.x), ...others.map((o) => o.x)].sort((a, b) => a - b);
  const nearAny = (xi: number, tol: number): boolean => {
    let lo = 0;
    let hi = everything.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (everything[mid]! < xi) lo = mid + 1;
      else hi = mid;
    }
    return [everything[lo - 1], everything[lo]].some((r) => r !== undefined && Math.abs(r - xi) <= tol);
  };
  const unindexed: { x: number; significance: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (z[i]! < threshold) continue;
    // An apex over a whole peak width: a noise bump on the flank of a leftover
    // peak (an unfitted extra phase keeps its whole profile) is not a peak.
    if (!isApex(i) || nearAny(x[i]!, tolWidths * width(x[i]!))) continue;
    if (unindexed.some((p) => Math.abs(p.x - x[i]!) < width(x[i]!))) continue;
    unindexed.push({ x: x[i]!, significance: z[i]! });
  }
  unindexed.sort((a, b) => b.significance - a.significance);
  violated.sort((a, b) => b.significance - a.significance);

  const everyPeakIndexes = unindexed.length === 0;
  const absencesConsistent = violated.length === 0;
  return {
    passed: everyPeakIndexes && absencesConsistent,
    everyPeakIndexes,
    absencesConsistent,
    cell,
    cellValues: pre.cellValues,
    leBail: { rWeighted: pre.rWeighted, fwhm: pre.fwhm, background: pre.background },
    unindexedPeaks: unindexed,
    absences: { tested, violated, untestable },
    limits: [
      ...LIMITS,
      `Only d ≥ ${dMinRead} Å was read.`,
      ...(pattern.xUnit !== "tof" ? []
        : tofProfile ? ["Time of flight: back-to-back-exponential peaks with four refined width terms (σ₁², σ₂², α, β₀) stand in for the instrument's full resolution curve."]
        : ["Time of flight: one Le Bail peak width, scaled with TOF, stands in for the real resolution curve."]),
      ...(tested === 0 && forbidden.length > 0 ? ["Every forbidden reflection overlaps an allowed one here: the absences could not be tested."] : []),
    ],
  };
}

/** The part of a pattern the check reads: inside the fit range, and at d ≥ `dMin`. */
function readWindow(pattern: PowderPattern, dMin: number, fitRange: FitRange | undefined, tof: TofCalibration | undefined): PowderPattern {
  const xAt = dToX(pattern, dMin, tof);
  // Which side of `xAt` holds the larger d-spacings depends on the axis (2θ and Q fall as d grows).
  const largerDUp = dToX(pattern, dMin * 1.5, tof) > xAt;
  const points = pattern.points.filter((p) =>
    (!Number.isFinite(xAt) || (largerDUp ? p.x >= xAt : p.x <= xAt)) &&
    (fitRange?.min === undefined || p.x >= fitRange.min) &&
    (fitRange?.max === undefined || p.x <= fitRange.max));
  return { ...pattern, points };
}
