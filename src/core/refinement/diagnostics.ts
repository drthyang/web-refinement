/**
 * Refinement-quality diagnostics beyond a single R/wR number.
 *
 * The **normal probability plot** (Abrahams & Keve, *Acta Cryst.* A27 (1971)
 * 157) is the gold-standard statistical check: order the weighted residuals
 * δᵢ = (obs − calc)/σ and plot them against the expected quantiles of a standard
 * normal. A correct model with correctly-estimated σ gives a straight line of
 * **slope 1 and intercept 0**. Departures diagnose *both* model error and
 * mis-estimated uncertainties (weights) — considerably more information than wR.
 */

/**
 * Inverse standard-normal CDF (probit), Acklam's rational approximation
 * (|error| < 1.15e-9). Maps a probability in (0,1) to a z-score.
 */
export function invNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

export interface NormalProbabilityPlot {
  /** (expected z-quantile, observed ordered δ) pairs, downsampled for display. */
  readonly points: { readonly expected: number; readonly observed: number }[];
  /** Best-fit line observed = slope·expected + intercept (from ALL residuals). */
  readonly slope: number;
  readonly intercept: number;
  /** Number of residuals used. */
  readonly n: number;
}

/**
 * Normal probability plot of the weighted residuals `deltas` = (obs − calc)/σ.
 * Points are downsampled to at most `maxPoints` for rendering, but the slope and
 * intercept are fit from every residual. Ideal fit → slope 1, intercept 0.
 */
export function normalProbabilityPlot(deltas: readonly number[], maxPoints = 400): NormalProbabilityPlot {
  const sorted = deltas.filter((d) => Number.isFinite(d)).sort((x, y) => x - y);
  const n = sorted.length;
  if (n === 0) return { points: [], slope: 0, intercept: 0, n: 0 };

  // Regression of observed δ on the expected quantile, over all points.
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const expected = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const e = invNormalCdf((i + 0.5) / n);
    expected[i] = e;
    const o = sorted[i]!;
    sx += e; sy += o; sxx += e * e; sxy += e * o;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;

  // Downsample for the scatter (evenly across the ordered residuals).
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const points: { expected: number; observed: number }[] = [];
  for (let i = 0; i < n; i += step) points.push({ expected: expected[i]!, observed: sorted[i]! });
  if ((n - 1) % step !== 0) points.push({ expected: expected[n - 1]!, observed: sorted[n - 1]! });
  return { points, slope, intercept, n };
}

/** Weighted residuals δ = (obs − calc)/σ from parallel arrays (σ from sigmas or √obs). */
export function weightedResiduals(
  obs: readonly number[],
  calc: readonly number[],
  sigmas?: readonly number[],
): number[] {
  const n = Math.min(obs.length, calc.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = sigmas?.[i] ?? (obs[i]! > 0 ? Math.sqrt(obs[i]!) : 1);
    if (s > 0) out.push((obs[i]! - calc[i]!) / s);
  }
  return out;
}
