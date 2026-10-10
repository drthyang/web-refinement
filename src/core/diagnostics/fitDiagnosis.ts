/**
 * Why a Rietveld fit is not good: the residual read the way a crystallographer
 * reads a difference curve, cause by cause, each with the share of χ² it
 * carries and what to do about it.
 *
 *  - Background: misfit between the peaks (where the calculated pattern is
 *    background alone) is the background function's.
 *  - Peak positions: a residual with ± lobes of one sign across the pattern
 *    (obs on the same side of every calc peak) is a position error — zero
 *    shift, cell, or sample displacement.
 *  - Asymmetry: ± lobes concentrated at low angle (constant wavelength) are
 *    axial-divergence asymmetry the symmetric profile cannot follow.
 *  - Peak width/shape: ± lobes of both signs spread over the pattern are a
 *    width or shape mismatch — the Caglioti terms, the Lorentzian X/Y. A gross
 *    width mismatch is measured directly: the half-maximum widths of observed
 *    and calculated isolated lines. Until the widths match, an observed peak's
 *    flanks lie where the model has no peak, so "between the peaks" excludes
 *    them (fluorapatite: an instrument file's 0.05° lines against the
 *    sample's 0.09° read as a background misfit).
 *  - Intensity falling off with angle wrongly: ln(I_obs/I_calc) linear in
 *    s² = 1/(4d²) is a Wilson-type slope — the ADPs off by ΔB = −slope/2, or an
 *    absorption/roughness correction missing.
 *  - Texture: ln(I_obs/I_calc) correlated with cos² of the angle between the
 *    reflection's normal and one low-index direction is preferred orientation
 *    along it (March–Dollase).
 *  - What is left in intensity is the structure: positions, ADPs, occupancies.
 *
 * Built on the Validation view's statistics (powderValidation.ts: Durbin–
 * Watson, χ² by d shell, the background-subtracted Rwp′) and the Rietveld
 * partition's χ² attribution per reflection (obsCalc.ts).
 */

import type { UnitCell } from "@/core/crystal/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import { misfitSignature, powderValidation, type PowderValidation } from "@/core/diagnostics/powderValidation";

export interface FitDiagnosisInput {
  readonly x: readonly number[];
  readonly yObs: readonly number[];
  readonly yCalc: readonly number[];
  readonly yBackground?: readonly number[];
  readonly sigma: readonly number[];
  readonly include: readonly boolean[];
  readonly nParams: number;
  /** d (Å) of every point. */
  readonly d: readonly number[];
  /** The Rietveld partition with χ² attribution (powderReflectionObsCalc with `misfit`). */
  readonly reflections: readonly ReflectionObsCalc[];
  /** Each phase's cell, by phase index (primary first), for the texture test. */
  readonly cells: readonly UnitCell[];
  /** Constant-wavelength 2θ data: asymmetry is read at low angle. */
  readonly twoTheta: boolean;
  /** The position of a reflection at d on the pattern's axis. */
  readonly xOf: (d: number) => number;
}

export type CauseId = "background" | "peak-width" | "peak-tails" | "peak-position" | "asymmetry" | "peak-shape" | "intensity-falloff" | "texture" | "structure";

export interface FitCause {
  readonly id: CauseId;
  /** Fraction of the fit's χ² this cause carries (approximate; causes can overlap). */
  readonly share: number;
  readonly evidence: string;
  /** What to do, in the app's terms. */
  readonly action: string;
}

export interface WorstReflection {
  readonly hkl: string;
  readonly phase?: string;
  readonly d: number;
  readonly x: number;
  readonly share: number;
  readonly signature: "shape" | "under" | "over";
  /** > 0: the observed peak sits to the high-x side of the calculated one (or its tail does). */
  readonly lobe: number;
  readonly mean: number;
}

/** Observed over calculated FWHM of isolated lines: the median, and at low and high x. */
export interface WidthRatio {
  readonly median: number;
  readonly low: number;
  readonly high: number;
  readonly lines: number;
  /**
   * The lines' Lorentzian fraction η, read from their shape (height × FWHM ÷
   * area: 0.94 for a Gaussian, 0.64 for a Lorentzian), observed and calculated
   * (medians over the lines isolated enough to integrate).
   */
  readonly etaObs?: number;
  readonly etaCalc?: number;
  readonly shapeLines?: number;
}

export interface FitDiagnosis {
  readonly validation: PowderValidation;
  readonly betweenPeaks?: { readonly share: number; readonly chi2PerPoint: number; readonly points: number };
  readonly width?: WidthRatio;
  readonly worst: readonly WorstReflection[];
  /** ln(I_obs/I_calc) against s² = 1/(4d²): ΔB = −slope/2 (Å²). */
  readonly wilson?: { readonly deltaB: number; readonly r: number; readonly n: number };
  readonly texture?: { readonly axis: readonly [number, number, number]; readonly r: number; readonly n: number; readonly enhancedAlongAxis: boolean };
  readonly causes: readonly FitCause[];
  readonly reading: string;
}

const hklText = (r: { h: number; k: number; l: number }): string => `${r.h} ${r.k} ${r.l}`;

/** The reciprocal metric tensor G* of a cell. */
export function reciprocalMetric(cell: UnitCell): number[][] {
  const rad = Math.PI / 180;
  const ca = Math.cos(cell.alpha * rad), cb = Math.cos(cell.beta * rad), cg = Math.cos(cell.gamma * rad);
  const g = [
    [cell.a * cell.a, cell.a * cell.b * cg, cell.a * cell.c * cb],
    [cell.a * cell.b * cg, cell.b * cell.b, cell.b * cell.c * ca],
    [cell.a * cell.c * cb, cell.b * cell.c * ca, cell.c * cell.c],
  ];
  const det = g[0]![0]! * (g[1]![1]! * g[2]![2]! - g[1]![2]! * g[2]![1]!) - g[0]![1]! * (g[1]![0]! * g[2]![2]! - g[1]![2]! * g[2]![0]!) + g[0]![2]! * (g[1]![0]! * g[2]![1]! - g[1]![1]! * g[2]![0]!);
  const inv = (r: number, c: number): number => {
    const m = g.filter((_, i) => i !== c).map((row) => row.filter((_, j) => j !== r));
    const minor = m[0]![0]! * m[1]![1]! - m[0]![1]! * m[1]![0]!;
    return ((r + c) % 2 === 0 ? 1 : -1) * minor / det;
  };
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => inv(r, c)));
}

/** cos of the angle between two reciprocal-lattice vectors. */
function cosBetween(gs: number[][], h: readonly number[], k: readonly number[]): number {
  const dot = (u: readonly number[], v: readonly number[]): number => u.reduce((s, ui, i) => s + ui * gs[i]!.reduce((t, gij, j) => t + gij * v[j]!, 0), 0);
  const n = Math.sqrt(dot(h, h) * dot(k, k));
  return n > 0 ? dot(h, k) / n : 0;
}

/** Weighted Pearson correlation and slope of y on x. */
function regress(x: readonly number[], y: readonly number[], w: readonly number[]): { slope: number; r: number } {
  const sw = w.reduce((s, v) => s + v, 0);
  if (!(sw > 0)) return { slope: 0, r: 0 };
  const mx = x.reduce((s, v, i) => s + w[i]! * v, 0) / sw;
  const my = y.reduce((s, v, i) => s + w[i]! * v, 0) / sw;
  let sxx = 0, syy = 0, sxy = 0;
  x.forEach((xi, i) => {
    sxx += w[i]! * (xi - mx) ** 2;
    syy += w[i]! * (y[i]! - my) ** 2;
    sxy += w[i]! * (xi - mx) * (y[i]! - my);
  });
  return { slope: sxx > 0 ? sxy / sxx : 0, r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
}

const AXES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

export function diagnoseFit(input: FitDiagnosisInput): FitDiagnosis {
  const validation = powderValidation({
    x: input.x, yObs: input.yObs, yCalc: input.yCalc,
    ...(input.yBackground ? { yBackground: input.yBackground } : {}),
    sigma: input.sigma, include: input.include, nParams: input.nParams, d: input.d, shellCount: 6,
  });
  const total = validation.chi2;
  const causes: FitCause[] = [];

  // ── peak widths: observed against calculated, on isolated lines ─────────
  const widths = input.yBackground ? lineWidths(input) : [];
  const width = widthRatio(widths);
  // Where the observed lines reach. A point is the background's alone only if
  // even a Lorentzian line of the observed width (or the calculated, if
  // broader) would put less than half a σ there: long tails are a shape misfit,
  // not a background one.
  const reach = widths.length >= 3 ? lineReach(input, interpolator(widths.map((w) => [w.x, Math.max(w.obs, w.calc)] as const))) : null;

  // ── background: χ² where the model is background alone ───────────────────
  let betweenPeaks: FitDiagnosis["betweenPeaks"];
  if (input.yBackground) {
    let chi = 0, n = 0, nAll = 0;
    input.x.forEach((_, i) => {
      if (!input.include[i]) return;
      nAll++;
      const peak = input.yCalc[i]! - input.yBackground![i]!;
      if (peak > 0.5 * input.sigma[i]!) return;
      if (reach && reach.envelope[i]! > 0.5 * input.sigma[i]!) return;
      const dl = (input.yObs[i]! - input.yCalc[i]!) / input.sigma[i]!;
      chi += dl * dl;
      n++;
    });
    if (n > 0 && total > 0) {
      betweenPeaks = { share: chi / total, chi2PerPoint: chi / n, points: n };
      if (betweenPeaks.chi2PerPoint > 2 && betweenPeaks.share > 0.15) {
        causes.push({
          id: "background",
          share: betweenPeaks.share,
          evidence: `between the peaks (${n} of ${nAll} points) the residual carries ${(100 * betweenPeaks.share).toFixed(0)}% of χ² at ${betweenPeaks.chi2PerPoint.toFixed(1)} per point (noise alone gives 1)`,
          action: "The background function misses: more terms or another basis (set_background), then refine the background alone.",
        });
      }
    }
  }

  // ── the reflections that carry the χ² ────────────────────────────────────
  const nuclear = input.reflections.filter((r) => r.kind === "nuclear" && r.chi2 !== undefined);
  const xs = input.x.filter((_, i) => input.include[i]);
  const xLo = Math.min(...xs), xHi = Math.max(...xs);
  const third = (x: number): 0 | 1 | 2 => (x < xLo + (xHi - xLo) / 3 ? 0 : x < xLo + (2 * (xHi - xLo)) / 3 ? 1 : 2);
  const rows = nuclear.map((r) => {
    const signature = misfitSignature(r.misfitMean ?? 0, r.misfitLobe ?? 0);
    return { r, x: input.xOf(r.d), share: total > 0 ? (r.chi2 ?? 0) / total : 0, signature, lobe: r.misfitLobe ?? 0, mean: r.misfitMean ?? 0 };
  }).filter((row) => Number.isFinite(row.x));
  const worst: WorstReflection[] = [...rows].sort((a, b) => b.share - a.share).slice(0, 10).map((row) => ({
    hkl: hklText(row.r), ...(row.r.phaseLabel ? { phase: row.r.phaseLabel } : {}), d: row.r.d, x: row.x, share: row.share, signature: row.signature, lobe: row.lobe, mean: row.mean,
  }));

  // A gross width mismatch first: until the widths match, every other reading
  // of the peaks (positions, asymmetry, intensities) is read through it.
  let widthShare = 0;
  if (width && (width.median > WIDTH_OFF || width.median < 1 / WIDTH_OFF)) {
    const peakShare = rows.reduce((sum, row) => sum + row.share, 0);
    widthShare = peakShare * Math.min(1, Math.abs(Math.log(width.median)) / Math.log(1.5));
    const broader = width.median > 1;
    const trend = Math.abs(Math.log(width.high / width.low)) > Math.log(1.25)
      ? ` (${width.low.toFixed(2)}× in the lower third, ${width.high.toFixed(2)}× in the upper)`
      : "";
    causes.push({
      id: "peak-width",
      share: widthShare,
      evidence: `the observed lines are ${width.median.toFixed(2)}× ${broader ? "broader" : "narrower"} than calculated at half maximum (median of ${width.lines} isolated lines${trend})`,
      action: broader
        ? `The calculated peaks are too narrow: free the Caglioti W, then U and V, with the scale and background${width.high > 1.25 * width.low ? "; the excess grows with angle, so U (and the Lorentzian Y, strain) matter most" : width.low > 1.25 * width.high ? "; the excess is largest at low angle — W and the Lorentzian X (size)" : ""}. Then the Lorentzian X and Y if the tails are long.`
        : "The calculated peaks are too broad: free the Caglioti W, then U and V; hold the Lorentzian X and Y at the instrument's values if they are free.",
    });
  }

  // The line shape: observed lines more (or less) Lorentzian than calculated.
  // A Gaussian fitted to pseudo-Voigt lines widens its core to reach their
  // tails, so the observed lines are then narrower at half maximum.
  // Read only once the widths roughly agree: with lines much narrower than the
  // data, a Kα₂ or an asymmetric tail inside the integration window weighs
  // differently in the two shapes.
  let tailShare = 0;
  if (width && widthsComparable(width) && width.etaObs !== undefined && width.etaCalc !== undefined && reach && Math.abs(width.etaObs - width.etaCalc) > ETA_OFF) {
    let chi = 0;
    input.x.forEach((_, i) => {
      if (!input.include[i] || !(reach.envelope[i]! > 0.5 * input.sigma[i]!)) return;
      const dl = (input.yObs[i]! - input.yCalc[i]!) / input.sigma[i]!;
      chi += dl * dl;
    });
    tailShare = total > 0 ? (chi / total) * Math.min(1, Math.abs(width.etaObs - width.etaCalc) / 0.3) : 0;
    const more = width.etaObs > width.etaCalc;
    causes.push({
      id: "peak-tails",
      share: tailShare,
      evidence: `the observed lines are ${more ? "more" : "less"} Lorentzian than calculated: η ≈ ${shown(width.etaObs)} against ${shown(width.etaCalc)} from their shape (median of ${width.shapeLines} isolated lines)${more && width.median < 0.95 ? `; they are ${width.median.toFixed(2)}× as broad as calculated at half maximum, a Gaussian core widened to reach their tails` : ""}`,
      action: more
        ? "A Lorentzian component is missing: free the Lorentzian X (size, 1/cosθ) and Y (strain, tanθ) with the Caglioti terms; a negative X or Y is unphysical, hold it at 0."
        : "The calculated lines are too Lorentzian: the Lorentzian X or Y (or a fixed η) is too large — refine them with the Caglioti terms, or hold them at the instrument's values.",
    });
  }

  // Shape misfits (± lobes): position, asymmetry, or width.
  const shape = rows.filter((row) => row.signature === "shape");
  const shapeShare = shape.reduce((s, row) => s + row.share, 0);
  if (shapeShare > 0.15) {
    const byThird = [0, 1, 2].map((t) => shape.filter((row) => third(row.x) === t));
    const shareOf = (list: typeof shape): number => list.reduce((s, row) => s + row.share, 0);
    const signBalance = (list: typeof shape): number => {
      const pos = list.filter((row) => row.lobe > 0).reduce((s, row) => s + row.share, 0);
      const all = shareOf(list);
      return all > 0 ? (2 * pos - all) / all : 0; // +1 all high-side, −1 all low-side
    };
    const low = byThird[0]!;
    const lowShare = shareOf(low);
    const balance = signBalance(shape);
    if (input.twoTheta && lowShare > 0.5 * shapeShare && Math.abs(signBalance(low)) > 0.5) {
      causes.push({
        id: "asymmetry",
        share: lowShare,
        evidence: `${(100 * lowShare / shapeShare).toFixed(0)}% of the peak-shape misfit is in the lowest third of the pattern, with the residual on one side of the peaks (${signBalance(low) < 0 ? "low-angle tails" : "high-angle side"})`,
        action: "Axial-divergence asymmetry the symmetric profile cannot follow: add the asymmetry correction (set_corrections asymmetry) and refine S/L and H/L with the profile.",
      });
    } else if (Math.abs(balance) > 0.6) {
      causes.push({
        id: "peak-position",
        share: shapeShare,
        evidence: `the residual sits on the ${balance > 0 ? "high" : "low"}-x side of the peaks across the pattern (${(100 * Math.abs(balance)).toFixed(0)}% one-sided)`,
        action: "A peak-position error: free the zero shift with the cell (constant shift), or sample displacement (set_corrections displacement; Δ2θ ∝ cosθ) on flat-plate data — not both with the zero.",
      });
    } else {
      causes.push({
        id: "peak-shape",
        share: shapeShare,
        evidence: `± residual lobes on both sides of peaks across the pattern carry ${(100 * shapeShare).toFixed(0)}% of χ²`,
        action: "A width or shape mismatch: free the Caglioti U, V, W together, then the Lorentzian X (size) and Y (strain); anisotropic broadening if some hkl are broader (Microstructure).",
      });
    }
  }

  // ── intensity: the fall-off with angle, then texture ─────────────────────
  const strong = nuclear.filter((r) => r.iCalc > 0 && r.iObs > 0);
  const top = Math.max(0, ...strong.map((r) => r.iCalc));
  const usable = strong.filter((r) => r.iCalc > 0.01 * top);
  let wilson: FitDiagnosis["wilson"];
  let texture: FitDiagnosis["texture"];
  const intensityShare = rows.filter((row) => row.signature !== "shape").reduce((s, row) => s + row.share, 0);
  if (usable.length >= 10) {
    const s2 = usable.map((r) => 1 / (4 * r.d * r.d));
    const y = usable.map((r) => Math.log(r.iObs / r.iCalc));
    const w = usable.map((r) => Math.sqrt(r.iCalc));
    const fit = regress(s2, y, w);
    wilson = { deltaB: -fit.slope / 2, r: fit.r, n: usable.length };
    if (Math.abs(fit.r) > 0.4 && Math.abs(wilson.deltaB) > 0.15) {
      causes.push({
        id: "intensity-falloff",
        share: intensityShare * Math.min(1, fit.r * fit.r * 2),
        evidence: `ln(I_obs/I_calc) ${fit.slope < 0 ? "falls" : "rises"} with sin²θ/λ² (r = ${fit.r.toFixed(2)}, ${usable.length} reflections): the calculated intensities fall off ${fit.slope < 0 ? "too slowly" : "too fast"}, as if B were off by ${wilson.deltaB > 0 ? "+" : ""}${wilson.deltaB.toFixed(2)} Å²`,
        action: "Free the ADPs if they are held; if they are free, an absorption (Debye–Scherrer μR) or surface-roughness correction is missing (set_corrections), or the data need a different Lorentz-polarization.",
      });
    }
    // Texture: what the fall-off leaves, against each low-index direction.
    const resid = y.map((yi, i) => yi - (fit.r !== 0 ? fit.slope * (s2[i]! - s2.reduce((a, b) => a + b, 0) / s2.length) : 0));
    const byPhase = new Map<number, number[]>();
    usable.forEach((r, i) => byPhase.set(r.phaseIndex ?? 0, [...(byPhase.get(r.phaseIndex ?? 0) ?? []), i]));
    const idx = byPhase.get(0) ?? [];
    const cell = input.cells[0];
    if (cell && idx.length >= 12) {
      const gs = reciprocalMetric(cell);
      let best: FitDiagnosis["texture"];
      for (const axis of AXES) {
        const c2 = idx.map((i) => cosBetween(gs, [usable[i]!.h, usable[i]!.k, usable[i]!.l], axis) ** 2);
        const t = regress(c2, idx.map((i) => resid[i]!), idx.map((i) => w[i]!));
        if (!best || Math.abs(t.r) > Math.abs(best.r)) best = { axis, r: t.r, n: idx.length, enhancedAlongAxis: t.slope > 0 };
      }
      texture = best;
      if (best && Math.abs(best.r) > 0.5) {
        causes.push({
          id: "texture",
          share: intensityShare * Math.min(1, best.r * best.r),
          evidence: `the intensity misfit follows the angle to [${best.axis.join(" ")}]* (r = ${best.r.toFixed(2)}, ${best.n} reflections): reflections near it are ${best.enhancedAlongAxis ? "stronger" : "weaker"} than calculated`,
          action: `Preferred orientation along ${best.axis.join(" ")}: add March–Dollase (set_corrections preferredOrientation [${best.axis.join(", ")}]) and refine its ratio — after the structure, and only if the sample can be textured (a capillary rarely is).`,
        });
      }
    }
  }
  // A width mismatch shows as intensity misfit too: the partition gives a
  // too-narrow line the counts of its own core only.
  const explainedIntensity = causes.filter((c) => c.id === "intensity-falloff" || c.id === "texture").reduce((s, c) => s + c.share, 0) + widthShare + tailShare;
  if (intensityShare - explainedIntensity > 0.2) {
    causes.push({
      id: "structure",
      share: intensityShare - explainedIntensity,
      evidence: `reflections calculated too strong or too weak, with no trend in angle or direction, carry ${(100 * (intensityShare - explainedIntensity)).toFixed(0)}% of χ²`,
      action: "The structure: positions, ADPs (anisotropic if the data support it), occupancies under their ties; check bond lengths after.",
    });
  }
  causes.sort((a, b) => b.share - a.share);

  const dw = validation.durbinWatson;
  const ag = validation.agreement;
  const reading = [
    `GoF ${ag.gof.toFixed(2)} (Rwp ${(100 * ag.rwp).toFixed(2)}%, Rexp ${(100 * ag.rexp).toFixed(2)}%${ag.rwpBkg !== undefined ? `; background-subtracted Rwp′ ${(100 * ag.rwpBkg).toFixed(2)}%` : ""}).`,
    ...(dw ? [dw.correlated ? `Durbin–Watson d = ${dw.d.toFixed(2)} < ${dw.qd.toFixed(2)}: neighbouring residuals miss together — a systematic misfit, and the esds are underestimated.` : `Durbin–Watson d = ${dw.d.toFixed(2)}: residuals uncorrelated.`] : []),
    causes.length === 0
      ? "No dominant cause: the misfit is spread thin. If GoF is still well above 1, look at the worst reflections one by one."
      : `Most of the misfit: ${causes.slice(0, 3).map((c) => `${c.id} (~${(100 * c.share).toFixed(0)}% of χ²)`).join(", ")}. Address the largest first.`,
  ].join(" ");
  return { validation, ...(betweenPeaks ? { betweenPeaks } : {}), ...(width ? { width } : {}), worst, ...(wilson ? { wilson } : {}), ...(texture ? { texture } : {}), causes, reading };
}

/** Observed/calculated widths this far from 1 are a cause. */
const WIDTH_OFF = 1.25;
/** Observed and calculated Lorentzian fractions this far apart are a cause. */
const ETA_OFF = 0.15;
/** Widths close enough for the line shapes to be compared. */
export const widthsComparable = (w: WidthRatio): boolean => w.median > 0.7 && w.median < 1.4;

interface LineWidth { readonly x: number; readonly calc: number; readonly obs: number; readonly etaObs?: number; readonly etaCalc?: number }

/** η of a pseudo-Voigt line from height × FWHM ÷ area (0.939 Gaussian, 0.637 Lorentzian). */
const etaOfShape = (shapeFactor: number): number => Math.min(2, Math.max(-0.5, (0.9394 - shapeFactor) / (0.9394 - 0.6366)));
/** η as read, in [0, 1] (a Kα₂ or an FCJ tail inside the window reads past 1). */
const shown = (eta: number): string => Math.min(1, Math.max(0, eta)).toFixed(2);

/**
 * Half-maximum widths of the calculated and the observed peak at strong,
 * isolated reflections: no other reflection carrying a tenth of the line's
 * intensity within 2.5 calculated widths, and the observed line 20σ tall.
 */
function lineWidths(input: FitDiagnosisInput): LineWidth[] {
  const n = input.x.length;
  const bkg = input.yBackground!;
  const netCalc = input.yCalc.map((y, i) => y - bkg[i]!);
  const netObs = input.yObs.map((y, i) => y - bkg[i]!);
  const asc = n > 1 && input.x[n - 1]! > input.x[0]!;
  const nearest = (xi: number): number => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((input.x[mid]! < xi) === asc) lo = mid; else hi = mid; }
    return Math.abs(input.x[lo]! - xi) <= Math.abs(input.x[hi]! - xi) ? lo : hi;
  };
  const all = input.reflections
    .filter((r) => r.kind === "nuclear" && r.iCalc > 0)
    .map((r) => ({ r, x: input.xOf(r.d) }))
    .filter((e) => Number.isFinite(e.x));
  const top = Math.max(0, ...all.map((e) => e.r.iCalc));
  const out: LineWidth[] = [];
  for (const e of [...all].sort((a, b) => b.r.iCalc - a.r.iCalc).slice(0, 60)) {
    if (e.r.iCalc < 0.02 * top) break;
    const c = nearest(e.x);
    if (c <= 0 || c >= n - 1 || !input.include[c]) continue;
    // The calculated line's apex within a few points of its position.
    let apex = c;
    for (let j = Math.max(0, c - 3); j <= Math.min(n - 1, c + 3); j++) if (netCalc[j]! > netCalc[apex]!) apex = j;
    const calc = halfWidth(input.x, netCalc, apex);
    if (!Number.isFinite(calc)) continue;
    if (all.some((o) => o !== e && o.r.iCalc > 0.1 * e.r.iCalc && Math.abs(o.x - e.x) < 2.5 * calc)) continue;
    // The observed apex within one calculated width.
    let obsApex = apex;
    for (let j = 0; j < n; j++) {
      if (Math.abs(input.x[j]! - input.x[apex]!) > calc) continue;
      if (netObs[j]! > netObs[obsApex]!) obsApex = j;
    }
    if (!(netObs[obsApex]! > 20 * input.sigma[obsApex]!)) continue;
    const obs = halfWidth(input.x, netObs, obsApex);
    if (!Number.isFinite(obs)) continue;
    // The shape: height × FWHM ÷ area over ±4 widths, where no other line
    // within 5 widths carries 5 % of this one.
    const w = Math.max(calc, obs);
    const quiet = !all.some((o) => o !== e && o.r.iCalc > 0.05 * e.r.iCalc && Math.abs(o.x - e.x) < 5 * w);
    let areaObs = 0, areaCalc = 0;
    if (quiet) {
      for (let j = 1; j < n; j++) {
        if (Math.abs(input.x[j]! - input.x[apex]!) > 4 * w) continue;
        const dx = Math.abs(input.x[j]! - input.x[j - 1]!);
        areaObs += netObs[j]! * dx;
        areaCalc += netCalc[j]! * dx;
      }
    }
    const shape = quiet && areaObs > 0 && areaCalc > 0
      ? { etaObs: etaOfShape((netObs[obsApex]! * obs) / areaObs), etaCalc: etaOfShape((netCalc[apex]! * calc) / areaCalc) }
      : {};
    out.push({ x: input.x[apex]!, calc, obs, ...shape });
  }
  return out.sort((a, b) => a.x - b.x);
}

/**
 * Each point's share of the lines: `envelope`, what Lorentzian lines of width
 * Γ(x) at every reflection's integrated intensity would put there (counts), and
 * `core`, within 1.5 widths of a reflection.
 */
function lineReach(input: FitDiagnosisInput, widthAt: (x: number) => number): { envelope: Float64Array; core: Uint8Array } {
  const n = input.x.length;
  const envelope = new Float64Array(n);
  const core = new Uint8Array(n);
  const step = n > 1 ? Math.abs(input.x[n - 1]! - input.x[0]!) / (n - 1) : 1;
  for (const r of input.reflections) {
    const x0 = input.xOf(r.d);
    if (!Number.isFinite(x0) || !(r.iCalc > 0)) continue;
    const g = widthAt(x0);
    const area = r.iCalc * step;
    const peak = (2 * area) / (Math.PI * g);
    for (let i = 0; i < n; i++) {
      const u = (2 * (input.x[i]! - x0)) / g;
      envelope[i]! += peak / (1 + u * u);
      if (Math.abs(u) < 3) core[i] = 1;
    }
  }
  return { envelope, core };
}

/** FWHM of the peak whose apex is at index `apex`, from its half-maximum crossings; NaN when not resolved. */
function halfWidth(x: readonly number[], y: readonly number[], apex: number): number {
  const half = y[apex]! / 2;
  if (!(half > 0)) return NaN;
  const cross = (dir: 1 | -1): number => {
    for (let i = apex; i + dir >= 0 && i + dir < y.length; i += dir) {
      if (y[i + dir]! < half) return x[i]! + ((x[i + dir]! - x[i]!) * (y[i]! - half)) / (y[i]! - y[i + dir]!);
      if (Math.abs(i - apex) > 400) return NaN;
    }
    return NaN;
  };
  const w = Math.abs(cross(1) - cross(-1));
  return Number.isFinite(w) && w > 0 ? w : NaN;
}

function widthRatio(widths: readonly LineWidth[]): WidthRatio | undefined {
  if (widths.length < 5) return undefined;
  const med = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const ratios = widths.map((w) => w.obs / w.calc);
  const third = Math.max(1, Math.floor(widths.length / 3));
  const shaped = widths.filter((w) => w.etaObs !== undefined && w.etaCalc !== undefined);
  return {
    median: med(ratios), low: med(ratios.slice(0, third)), high: med(ratios.slice(-third)), lines: widths.length,
    ...(shaped.length >= 3 ? { etaObs: med(shaped.map((w) => w.etaObs!)), etaCalc: med(shaped.map((w) => w.etaCalc!)), shapeLines: shaped.length } : {}),
  };
}

/** Piecewise-linear interpolation through (x, y) points sorted by x, flat beyond the ends. */
function interpolator(points: readonly (readonly [number, number])[]): (x: number) => number {
  return (x) => {
    if (x <= points[0]![0]) return points[0]![1];
    const last = points[points.length - 1]!;
    if (x >= last[0]) return last[1];
    let i = 1;
    while (points[i]![0] < x) i++;
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
  };
}
