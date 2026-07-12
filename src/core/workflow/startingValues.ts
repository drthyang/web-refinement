/**
 * Robust automatic starting values (roadmap F1.3): estimates that keep a
 * refinement from starting in a false basin. The background comes from the
 * data's lower envelope (see `estimateBackground`); this module adds the
 * zero-shift / peak-position sanity check.
 */

/**
 * Estimate the zero-point shift by discrete cross-correlation of the
 * net observed pattern (background-subtracted) against the calculated
 * peaks-only curve over a shift grid. Returns the best shift and the
 * correlation gain over zero shift — callers should only APPLY the shift when
 * the gain is significant and the magnitude sane (both thresholds theirs).
 *
 * Pure sanity-check mechanics: no fitting, no model change — just "do the
 * calculated peaks line up better a little to the left or right?".
 */
export function estimateZeroShift(
  xValues: readonly number[],
  netObs: readonly number[],
  yCalcPeaks: readonly number[],
  options: { readonly maxShift?: number; readonly steps?: number } = {},
): { shift: number; gain: number } {
  const n = Math.min(xValues.length, netObs.length, yCalcPeaks.length);
  if (n < 16) return { shift: 0, gain: 0 };
  const dx = (xValues[n - 1]! - xValues[0]!) / (n - 1);
  if (!(dx > 0)) return { shift: 0, gain: 0 };
  const maxShift = options.maxShift ?? Math.min(Math.abs(dx) * 50, (xValues[n - 1]! - xValues[0]!) * 0.02);
  const steps = Math.max(4, options.steps ?? 40);

  // Correlation of netObs against yCalc displaced by z (linear interpolation
  // on the uniform-ish grid; non-uniform grids are handled by index mapping).
  const corrAt = (z: number): number => {
    let s = 0;
    const offset = z / dx;
    for (let i = 0; i < n; i++) {
      const j = i - offset;
      const j0 = Math.floor(j);
      if (j0 < 0 || j0 >= n - 1) continue;
      const f = j - j0;
      const c = yCalcPeaks[j0]! * (1 - f) + yCalcPeaks[j0 + 1]! * f;
      s += Math.max(netObs[i]!, 0) * c;
    }
    return s;
  };

  const base = corrAt(0);
  let bestZ = 0;
  let bestC = base;
  for (let k = -steps; k <= steps; k++) {
    const z = (k / steps) * maxShift;
    const c = corrAt(z);
    if (c > bestC) {
      bestC = c;
      bestZ = z;
    }
  }
  return { shift: bestZ, gain: base > 0 ? bestC / base - 1 : 0 };
}
