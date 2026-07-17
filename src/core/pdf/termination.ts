/**
 * Finite-Qmax termination for the PDF forward model (PDF_MPDF_ROADMAP P3).
 *
 * An experimental G(r) is the sine transform of S(Q) measured only up to Qmax,
 * so every feature is convolved with the termination kernel
 *
 *   K(x) = sin(Qmax·x) / (π·x)        (an ideal low-pass in Q)
 *
 * — the origin of the ripple between PDF peaks. A model fitted to such data
 * must be band-limited the same way (Farrow 2007; PDFfit2 convention), or the
 * between-peak residual is pure artifact.
 *
 * Implementation: direct discrete convolution with the exact sampled kernel on
 * a UNIFORM grid — deliberately not FFT (correctness first: no padding or
 * wrap-around pitfalls; O(N²) with a precomputed kernel is a few ms at typical
 * grid sizes; an FFT path can later replace it behind this same seam with a
 * bit-comparison gate). Two correctness details the tests pin down:
 *
 *  - **Range extension.** The convolution needs G on both sides of every output
 *    point, so the caller evaluates the model on a grid extended by
 *    {@link terminationMargin} (= 6·(2π/Qmax)) each way and slices back
 *    (`extendGridForTermination`).
 *  - **Odd reflection at r → 0.** G(r) is an odd function; for output points
 *    within the kernel's reach of the origin the convolution integral over
 *    r′ < 0 contributes −G(−r′). On a 0-aligned grid (r_k = k·h — every
 *    PDFgetX3/Mantid grid) this lands exactly on the kernel lattice and is
 *    included; on a non-aligned grid it is skipped (the bias is confined to
 *    r ≲ the margin, below any sensible fit window).
 *
 * Sanity built into the math: at grid Nyquist (Qmax ≥ π/h) the sampled kernel
 * is exactly δ_k0 and the convolution is the identity — data reduced on the
 * Nyquist grid Δr = π/Qmax carries no resolvable ripple.
 */

const TWO_PI = 2 * Math.PI;

/** Ripple margin (Å): how far the model grid must extend beyond the data each
 *  way so edge effects cannot reach the fitted window (roadmap §3.3). */
export function terminationMargin(qmax: number): number {
  return qmax > 0 ? 6 * (TWO_PI / qmax) : 0;
}

/** Whether band-limiting at `qmax` does anything on a grid of step `h`
 *  (false at/above the grid Nyquist π/h, where the kernel is exactly δ). */
export function terminationActive(qmax: number, h: number): boolean {
  return qmax > 0 && h > 0 && qmax < (Math.PI / h) * (1 - 1e-9);
}

/**
 * Band-limit `g` (samples of G on the uniform grid r_k = r0 + k·h, r0 > 0) to
 * Q ≤ qmax by direct convolution with the sampled termination kernel. Returns a
 * new array of the same length. Interior points (≥ margin from either end) are
 * exact up to the kernel's 1/x tail beyond the array; the caller supplies the
 * extension (see `extendGridForTermination`) so its fitted window is interior.
 */
export function bandLimit(g: ArrayLike<number>, r0: number, h: number, qmax: number): Float64Array {
  const n = g.length;
  const out = new Float64Array(n);
  if (n === 0 || !terminationActive(qmax, h)) {
    for (let i = 0; i < n; i++) out[i] = g[i]!;
    return out;
  }

  // r0 in units of h: needed for the odd-reflection lattice r_i + r_j = (2k0+i+j)h.
  const k0Real = r0 / h;
  const k0 = Math.round(k0Real);
  const aligned = Math.abs(k0Real - k0) < 1e-6;

  // Sampled kernel h·K(d·h) for lattice offsets d = 0 … (2n + 2k0): the direct
  // term needs |i−j| ≤ n−1; the reflection term needs i+j+2k0 ≤ 2(n−1)+2k0.
  const kernelLen = aligned ? 2 * n + 2 * k0 : n;
  const kernel = new Float64Array(kernelLen);
  kernel[0] = (h * qmax) / Math.PI;
  for (let d = 1; d < kernelLen; d++) {
    const x = d * h;
    kernel[d] = Math.sin(qmax * x) / (Math.PI * x) * h;
  }

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      acc += kernel[Math.abs(i - j)]! * g[j]!;
    }
    out[i] = acc;
  }

  // Odd reflection G(−r) = −G(r): only reaches output points within the
  // kernel's significant range of the origin. The 1/x kernel tail makes a hard
  // cut arbitrary; summing the full row for the few affected points is cheap.
  if (aligned) {
    const reach = Math.ceil(terminationMargin(qmax) / h);
    const iMax = Math.min(n, Math.max(0, reach - k0));
    for (let i = 0; i < iMax; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) {
        acc += kernel[i + j + 2 * k0]! * g[j]!;
      }
      out[i] = out[i]! - acc;
    }
  }
  return out;
}

/**
 * Build the extended uniform model grid for a terminated calculation: the data
 * grid r_k = r0 + k·h stretched by the termination margin on both sides —
 * downward never past the first positive grid point (and never past r = 0,
 * where G vanishes by oddness). `offset` slices the model result back onto the
 * data grid: `terminated.subarray(offset, offset + nData)`.
 */
export function extendGridForTermination(
  r0: number,
  h: number,
  nData: number,
  qmax: number,
): { rExt: Float64Array; offset: number } {
  const margin = terminationMargin(qmax);
  const stepsDown = Math.min(
    Math.ceil(margin / h),
    Math.max(0, Math.floor((r0 - 0.5 * h) / h)), // keep the lowest point ≥ h/2 (> 0)
  );
  const stepsUp = Math.ceil(margin / h);
  const nExt = stepsDown + nData + stepsUp;
  const rExt = new Float64Array(nExt);
  const rStart = r0 - stepsDown * h;
  for (let k = 0; k < nExt; k++) rExt[k] = rStart + k * h;
  return { rExt, offset: stepsDown };
}

/** Uniform grid step of ascending `r` values, or null when the spacing varies
 *  by more than 0.1 % (termination then does not apply — log-spaced or merged
 *  grids are not band-limitable by a lattice kernel). */
export function uniformStep(r: readonly number[] | ArrayLike<number>): number | null {
  const n = r.length;
  if (n < 2) return null;
  const h = (r[n - 1]! - r[0]!) / (n - 1);
  if (!(h > 0)) return null;
  for (let i = 1; i < n; i++) {
    if (Math.abs(r[i]! - r[i - 1]! - h) > 1e-3 * h) return null;
  }
  return h;
}
