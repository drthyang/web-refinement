/**
 * Detect "extra" (candidate magnetic) peaks from a powder pattern: the positive
 * residual left after the **nuclear** model, i.e. reflections the nuclear
 * structure cannot explain. Their d-spacings feed the propagation-vector search
 * so the user never has to read peak positions off the plot by hand.
 *
 * Workflow assumption (see the magnetic panel): refine the nuclear structure
 * first — then obs − calc is dominated by magnetic scattering, not nuclear
 * misfit. This is a first-pass detector: prominence over a robust (MAD) noise
 * floor, local maxima, near-coincident merge. It is deliberately conservative
 * (positive peaks only) and returns candidates ranked by height.
 */

export interface ExtraPeak {
  /** d-spacing of the peak apex (Å). */
  readonly d: number;
  /** Residual height at the apex (obs − calc, arb. units). */
  readonly height: number;
}

export interface ExtraPeakOptions {
  /** Height threshold as a multiple of the robust noise σ (MAD-based). Default 8. */
  readonly sigma?: number;
  /** Also require height ≥ this fraction of the largest residual. Default 0.08. */
  readonly minFraction?: number;
  /** Apex must be the max over ±`window` points (rejects single-point noise). Default 2. */
  readonly window?: number;
  /** Merge maxima closer than this in d (Å), keeping the taller. Default 0.02. */
  readonly mergeD?: number;
  /**
   * Keep at most this many peaks (the tallest). A real magnetic powder pattern
   * has a handful of resolvable satellites; a large count means the nuclear fit
   * is poor (residual dominated by nuclear misfit, not magnetism). Default 40.
   */
  readonly limit?: number;
}

/** Robust noise scale from the residual: 1.4826 · median(|r − median r|). */
function madSigma(res: readonly number[]): number {
  if (res.length === 0) return 1e-9;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const med = median([...res]);
  const mad = median(res.map((v) => Math.abs(v - med)));
  return 1.4826 * mad || 1e-9;
}

/**
 * Find candidate magnetic peaks in the residual obs − calc, returned as
 * d-spacings ranked by residual height. `d` and the intensity arrays are
 * parallel (index i is the same data point); `d` need not be monotonic.
 */
export function detectExtraPeaks(
  d: readonly number[],
  yObs: readonly number[],
  yCalc: readonly number[],
  options: ExtraPeakOptions = {},
): ExtraPeak[] {
  const { sigma = 8, minFraction = 0.08, window = 2, mergeD = 0.02, limit = 40 } = options;
  const n = Math.min(d.length, yObs.length, yCalc.length);
  if (n === 0) return [];

  const res = new Array<number>(n);
  for (let i = 0; i < n; i++) res[i] = yObs[i]! - yCalc[i]!;
  const noise = madSigma(res);
  const maxRes = Math.max(0, ...res);
  const threshold = Math.max(sigma * noise, minFraction * maxRes);

  const found: ExtraPeak[] = [];
  for (let i = 0; i < n; i++) {
    if (res[i]! <= threshold) continue;
    let isApex = true;
    for (let j = Math.max(0, i - window); j <= Math.min(n - 1, i + window); j++) {
      if (res[j]! > res[i]!) { isApex = false; break; }
    }
    if (isApex && Number.isFinite(d[i]!) && d[i]! > 0) found.push({ d: d[i]!, height: res[i]! });
  }

  // Merge near-coincident apices (a flat top can trip several points).
  found.sort((a, b) => a.d - b.d);
  const merged: ExtraPeak[] = [];
  for (const p of found) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.d - p.d) < mergeD) {
      if (p.height > last.height) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }
  merged.sort((a, b) => b.height - a.height);
  return merged.slice(0, limit);
}
