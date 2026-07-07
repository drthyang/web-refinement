/**
 * Agreement factors (R values) and weighting helpers.
 *
 *   R    = Σ|y_obs − y_calc| / Σ|y_obs|
 *   R_wp = sqrt( Σ w (y_obs − y_calc)² / Σ w·y_obs² )
 *   R_exp = sqrt( (N − P) / Σ w·y_obs² )
 *   GoF  = R_wp / R_exp   (χ² = GoF²)
 */

import type { AgreementFactors } from "@/core/refinement/types";

/** Weights from sigmas; falls back to unit weights where sigma is missing/zero. */
export function weightsFromSigma(sigma: readonly (number | undefined)[]): Float64Array {
  const w = new Float64Array(sigma.length);
  for (let i = 0; i < sigma.length; i++) {
    const s = sigma[i];
    w[i] = s === undefined || s <= 0 ? 1 : 1 / (s * s);
  }
  return w;
}

/**
 * Detect a repeated non-positive "sentinel" plateau marking excluded/masked
 * points (e.g. GSAS exports a constant −3 outside the fit range) and return a
 * boolean mask (true = excluded). Only triggers when one non-positive value
 * repeats many times, so scattered near-zero noise in valid data is untouched.
 */
export function excludedPointMask(yObs: readonly number[]): boolean[] {
  const counts = new Map<number, number>();
  for (const y of yObs) if (y <= 0) counts.set(y, (counts.get(y) ?? 0) + 1);
  let sentinel: number | null = null;
  let best = 4; // require ≥5 repeats to be considered a sentinel plateau
  for (const [v, c] of counts) if (c > best) { best = c; sentinel = v; }
  return yObs.map((y) => sentinel !== null && y === sentinel);
}

/** Apply an exclusion mask to a weight vector in place (masked → weight 0). */
export function applyExclusionMask(weights: Float64Array, mask: readonly boolean[]): Float64Array {
  for (let i = 0; i < weights.length; i++) if (mask[i]) weights[i] = 0;
  return weights;
}

/**
 * Mask (true = excluded) for points whose abscissa falls outside an inclusive
 * fit range [min, max]. A missing bound leaves that side unrestricted, so a
 * partially-defined range still works.
 */
export function fitRangeMask(
  xValues: readonly number[],
  range: { readonly min?: number; readonly max?: number } | undefined,
): boolean[] {
  if (!range || (range.min === undefined && range.max === undefined)) {
    return xValues.map(() => false);
  }
  const min = range.min ?? -Infinity;
  const max = range.max ?? Infinity;
  return xValues.map((x) => x < min || x > max);
}

export function computeAgreementFactors(
  yObs: Float64Array,
  yCalc: Float64Array,
  weights: Float64Array,
  nParams: number,
): AgreementFactors {
  let sumAbsObs = 0;
  let sumAbsDiff = 0;
  let sumWObs2 = 0;
  let sumWDiff2 = 0;
  const n = yObs.length;

  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (w <= 0) continue; // excluded/masked point — omit from every agreement sum
    const o = yObs[i]!;
    const c = yCalc[i]!;
    const diff = o - c;
    sumAbsObs += Math.abs(o);
    sumAbsDiff += Math.abs(diff);
    sumWObs2 += w * o * o;
    sumWDiff2 += w * diff * diff;
  }

  const rFactor = sumAbsObs > 0 ? sumAbsDiff / sumAbsObs : 0;
  const rWeighted = sumWObs2 > 0 ? Math.sqrt(sumWDiff2 / sumWObs2) : 0;
  const dof = Math.max(n - nParams, 1);
  const rExpected = sumWObs2 > 0 ? Math.sqrt(dof / sumWObs2) : 0;
  const goodnessOfFit = rExpected > 0 ? (rWeighted / rExpected) ** 2 : 0;

  return { rFactor, rWeighted, rExpected, goodnessOfFit };
}

/** Weighted sum of squared residuals, χ² = Σ w (obs − calc)². */
export function chiSquared(
  yObs: Float64Array,
  yCalc: Float64Array,
  weights: Float64Array,
): number {
  let sum = 0;
  for (let i = 0; i < yObs.length; i++) {
    const diff = yObs[i]! - yCalc[i]!;
    sum += weights[i]! * diff * diff;
  }
  return sum;
}
