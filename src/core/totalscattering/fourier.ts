/**
 * Q-space ↔ real-space bridges for reduced total-scattering data
 * (PDF_MPDF_ROADMAP §4, `totalscattering/fourier.ts`).
 *
 * The reduced structure function F(Q) = Q·[S(Q) − 1] and the reduced PDF are a
 * sine-transform pair (Farrow 2007 Eq. 6):
 *
 *   G(r) = (2/π) ∫_{Qmin}^{Qmax} F(Q) · sin(Q·r) dQ
 *
 * This is the LAST step of data reduction — a pure transform of already
 * normalized data. It deliberately does NOT do reduction proper (background,
 * Compton/Placzek, ⟨f²⟩ normalization — the deferred PR track): feeding it a
 * raw I(Q) gives garbage, feeding it a PDFgetX3/Mantid S(Q) or F(Q) gives the
 * same G(r) those tools would write. It exists so the app's entry point stays
 * clean — drop any reduced file and land on a fittable G(r), with the data's
 * own Q-range becoming the model's Qmax termination.
 */

/** F(Q) = Q·[S(Q) − 1]: the reduced structure function from S(Q). */
export function fOfQFromSOfQ(q: readonly number[], s: readonly number[]): Float64Array {
  const f = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) f[i] = q[i]! * (s[i]! - 1);
  return f;
}

/**
 * Sine-transform F(Q) samples (ascending, need not be uniform) to G(r) on
 * `rGrid`, by trapezoidal quadrature of (2/π)∫F(Q)sin(Qr)dQ. O(nQ·nR) — a few
 * million multiply-adds for typical grids, done once at load time.
 */
export function gOfRFromFOfQ(q: readonly number[], f: ArrayLike<number>, rGrid: readonly number[]): Float64Array {
  const n = q.length;
  const g = new Float64Array(rGrid.length);
  if (n < 2) return g;
  for (let j = 0; j < rGrid.length; j++) {
    const r = rGrid[j]!;
    let acc = 0;
    let prev = f[0]! * Math.sin(q[0]! * r);
    for (let i = 1; i < n; i++) {
      const cur = f[i]! * Math.sin(q[i]! * r);
      acc += 0.5 * (prev + cur) * (q[i]! - q[i - 1]!);
      prev = cur;
    }
    g[j] = (2 / Math.PI) * acc;
  }
  return g;
}

/** Default real-space grid for a transformed pattern (PDFgetX3 conventions). */
export function defaultTransformGrid(rMax = 30, rStep = 0.01): number[] {
  const n = Math.round(rMax / rStep);
  return Array.from({ length: n }, (_, k) => (k + 1) * rStep);
}
