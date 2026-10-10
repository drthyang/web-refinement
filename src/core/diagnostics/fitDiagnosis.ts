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
 *    width or shape mismatch — the Caglioti terms, the Lorentzian X/Y.
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

export type CauseId = "background" | "peak-position" | "asymmetry" | "peak-shape" | "intensity-falloff" | "texture" | "structure";

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

export interface FitDiagnosis {
  readonly validation: PowderValidation;
  readonly betweenPeaks?: { readonly share: number; readonly chi2PerPoint: number; readonly points: number };
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

  // ── background: χ² where the model is background alone ───────────────────
  let betweenPeaks: FitDiagnosis["betweenPeaks"];
  if (input.yBackground) {
    let chi = 0, n = 0, nAll = 0;
    input.x.forEach((_, i) => {
      if (!input.include[i]) return;
      nAll++;
      const peak = input.yCalc[i]! - input.yBackground![i]!;
      if (peak > 0.5 * input.sigma[i]!) return;
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
  const explainedIntensity = causes.filter((c) => c.id === "intensity-falloff" || c.id === "texture").reduce((s, c) => s + c.share, 0);
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
  return { validation, ...(betweenPeaks ? { betweenPeaks } : {}), worst, ...(wilson ? { wilson } : {}), ...(texture ? { texture } : {}), causes, reading };
}
