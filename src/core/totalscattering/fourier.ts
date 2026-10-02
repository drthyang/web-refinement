/**
 * Q-space → real-space bridge for reduced total-scattering data
 * (PDF_MPDF_ROADMAP §4, `totalscattering/fourier.ts`): ONE exact linear
 * operator from F(Q) = Q·[S(Q) − 1] to the reduced PDF G(r), from which the
 * transformed VALUES, their pointwise UNCERTAINTIES and their full COVARIANCE
 * are all derived — so the three can never disagree about the quadrature.
 *
 * ## The transform
 *
 * The reduced structure function and the reduced PDF are a sine-transform
 * pair (Egami & Billinge 2012; Farrow et al. 2007; Juhás et al. 2013):
 *
 *   G(r) = (2/π) ∫_{Qmin}^{Qmax} F(Q) · M(Q) · sin(Q·r) dQ,     F(Q) = Q·[S(Q) − 1]
 *
 * with M(Q) ≡ 1 (the PDFgetX3/PDFgui convention, and what the real-space model
 * in `core/pdf/termination.ts` band-limits to) or the Lorch (1969) modification
 * M(Q) = sin(πQ/Qmax)/(πQ/Qmax), which trades the termination ripple for
 * resolution.
 *
 * **Quadrature.** Composite trapezoid rule on the MEASURED nodes
 * Q_0 < … < Q_{n−1} inside the window (non-uniform grids allowed), with weights
 * w_0 = (Q_1 − Q_0)/2, w_k = (Q_{k+1} − Q_{k−1})/2, w_{n−1} = (Q_{n−1} − Q_{n−2})/2:
 *
 *   G(r) = Σ_k c_k F_k sin(Q_k r)  [+ G_low(r)],     c_k = (2/π)·w_k·M(Q_k)
 *
 * — the rule of pystog's `Transformer` (`numpy.trapezoid`) and of RMCProfile's
 * StoG, which the golden tests reproduce to ~1e-13 (stogGolden / pystogGolden).
 * A rectangle rule (FFT-style Riemann sum) differs only by ½ΔQ times the two
 * endpoint terms.
 *
 * **Omitted low-Q region** (`lowQ: "linear"`, StoG/pystog's
 * `OmittedXrangeCorrection`, attributed there to J. Carpenter). Data start at
 * Q_0 > 0, so the window misses ∫_0^{Q_0}. Assuming S(Q) rises LINEARLY from
 * S(0) = 0 to the first measured S_0 — S_lin(Q) = S_0·Q/Q_0, i.e. the
 * compressibility limit S(0) ≈ 0 of condensed matter, and wrong if there is
 * small-angle scattering — the missing piece integrates in closed form:
 *
 *   G_low(r) = (2/π)·[ (S_0/Q_0)·I_2(r) − I_1(r) ],    I_n(r) = ∫_0^{Q_0} Qⁿ M(Q) sin(Qr) dQ
 *
 * (`lowQIntegrals`). Off by default: PDFgetX3-reduced data never carry it, and
 * the fitted model assumes nothing about the region.
 *
 * ## Uncertainty propagation — exact, not linearized
 *
 * The operator is LINEAR in the data, so for independent per-point
 * uncertainties σ_F,k (σ_F = Q·σ_S, Q being an exact abscissa) the law of
 * propagation of uncertainty for a linear multivariate model, U_G = J U_F Jᵀ
 * (JCGM 102:2011, GUM Supplement 2), is exact rather than a first-order
 * approximation:
 *
 *   Cov[G(r), G(r′)] = Σ_k σ_F,k² · φ_k(r) · φ_k(r′),     φ_k(r) = ∂G(r)/∂F_k = c_k sin(Q_k r)
 *
 * and σ_G(r)² is its diagonal. With `lowQ: "linear"` node 0's column gains
 * (2/π)·I_2(r)/Q_0² (S_0 = F_0/Q_0 + 1 enters G_low linearly): the extrapolation
 * is built from a measured point, so it carries that point's error — the
 * pystog reference omits this term (documented in its golden test).
 *
 * The product-to-sum identity sin a · sin b = ½[cos(a − b) − cos(a + b)] splits
 * the sinusoidal part into
 *
 *   Cov = ½ [ P(r − r′) − P(r + r′) ],     P(x) = Σ_k c_k² σ_F,k² cos(Q_k x)
 *
 * — a TOEPLITZ term, the noise autocorrelation (the cosine transform of the
 * noise power spectrum c_k²σ_k², a discrete Wiener–Khinchin pair), minus a
 * HANKEL term, the odd reflection at r = 0 that pins σ_G(0) = 0. On a uniform r
 * grid both are O(n) vectors, so the n×n covariance costs O(n_Q·n) cosines
 * instead of O(n_Q·n²). Consequences the tests pin (fourier.test.ts):
 *
 *  - σ_G(0) = 0 and σ_G ∝ r for r ≪ π/Qmax (sin Qr ≈ Qr);
 *  - far from the origin σ_G² → ½·P(0), the sin² average;
 *  - WHITE F(Q) noise on Q_k = kΔQ from 0, sampled on the Nyquist grid
 *    r_j = jπ/Qmax, is EXACTLY uncorrelated (DST-I orthogonality);
 *  - WHITE S(Q) noise (σ_F ∝ Q) is not: adjacent Nyquist points correlate at
 *    −6/π² ≈ −0.61 (continuum limit, see `grErrors.ts`). "Nyquist points are
 *    independent" is a statement about the noise SPECTRUM, not the grid alone.
 *
 * This is the STATISTICAL error of the reduced data only. Systematic errors of
 * the reduction (background, normalization, Compton/Placzek) are not in σ_S.
 */

import type { ReciprocalSpaceData } from "@/core/diffraction/types";

/** Modification function M(Q) applied to F(Q) before the transform. */
export type ModificationFunction = "none" | "lorch";

/** Treatment of the unmeasured 0 → Q_0 region (see module header). */
export type LowQExtrapolation = "none" | "linear";

export interface SineTransformOptions {
  /** Lower window bound (Å⁻¹); nodes with Q < qmin are excluded. Default: first node. */
  readonly qmin?: number;
  /** Upper window bound (Å⁻¹); nodes with Q > qmax are excluded. Default: last node. */
  readonly qmax?: number;
  /** Default "none" (PDFgetX3/PDFgui convention; matches the model's termination). */
  readonly modification?: ModificationFunction;
  /** Default "none". */
  readonly lowQ?: LowQExtrapolation;
}

/**
 * The discretized operator over one Q window. Coefficients are independent of
 * r and of the data, so one operator serves value, σ and covariance alike.
 * Data arrays passed alongside it are aligned with the FULL input `q` (the
 * window offset `first` is applied internally).
 */
export interface SineTransformOperator {
  /** Window nodes Q_k (Å⁻¹). */
  readonly q: Float64Array;
  /** c_k = (2/π)·w_k·M(Q_k): G(r) = Σ c_k F_k sin(Q_k r) [+ G_low]. */
  readonly coef: Float64Array;
  /** Index of q[0] in the input arrays. */
  readonly first: number;
  /** First and last integrated node (Å⁻¹); the Lorch Qmax is `qmax`. */
  readonly qmin: number;
  readonly qmax: number;
  readonly modification: ModificationFunction;
  readonly lowQ: LowQExtrapolation;
}

const TWO_OVER_PI = 2 / Math.PI;

/** F(Q) = Q·[S(Q) − 1]: the reduced structure function from S(Q). */
export function fOfQFromSOfQ(q: ArrayLike<number>, s: ArrayLike<number>): Float64Array {
  const f = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) f[i] = q[i]! * (s[i]! - 1);
  return f;
}

/** σ_F = Q·σ_S — exact (Q is the abscissa, not a measured quantity). */
export function sigmaFFromSigmaS(q: ArrayLike<number>, sigmaS: ArrayLike<number>): Float64Array {
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i]! * sigmaS[i]!;
  return out;
}

/** Lorch (1969) modification M(Q) = sin(πQ/Qmax)/(πQ/Qmax), M(0) = 1, M(Qmax) = 0. */
export function lorchModification(q: number, qmax: number): number {
  const x = (Math.PI * q) / qmax;
  return Math.abs(x) < 1e-8 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

/** Composite trapezoid weights on (possibly non-uniform) ascending nodes. */
export function trapezoidWeights(q: ArrayLike<number>): Float64Array {
  const n = q.length;
  const w = new Float64Array(n);
  if (n < 2) return w;
  w[0] = 0.5 * (q[1]! - q[0]!);
  w[n - 1] = 0.5 * (q[n - 1]! - q[n - 2]!);
  for (let k = 1; k < n - 1; k++) w[k] = 0.5 * (q[k + 1]! - q[k - 1]!);
  return w;
}

/**
 * Build the operator over the nodes of `q` inside [qmin, qmax]. Throws on a
 * non-ascending grid or fewer than two nodes in the window — a transform of
 * that would be silently meaningless.
 */
export function sineTransformOperator(q: ArrayLike<number>, opts: SineTransformOptions = {}): SineTransformOperator {
  const lo = opts.qmin ?? -Infinity;
  const hi = opts.qmax ?? Infinity;
  let first = -1;
  let last = -1;
  for (let i = 0; i < q.length; i++) {
    if (i > 0 && !(q[i]! > q[i - 1]!)) throw new RangeError(`Q grid must be strictly ascending (Q[${i}] = ${q[i]} ≤ Q[${i - 1}] = ${q[i - 1]})`);
    if (q[i]! >= lo && q[i]! <= hi) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last - first < 1) throw new RangeError(`fewer than two Q nodes inside [${lo}, ${hi}] Å⁻¹`);
  const nodes = Float64Array.from({ length: last - first + 1 }, (_, k) => q[first + k]!);
  const modification = opts.modification ?? "none";
  const qmax = nodes[nodes.length - 1]!;
  const w = trapezoidWeights(nodes);
  const coef = new Float64Array(nodes.length);
  for (let k = 0; k < nodes.length; k++) {
    const m = modification === "lorch" ? lorchModification(nodes[k]!, qmax) : 1;
    coef[k] = TWO_OVER_PI * w[k]! * m;
  }
  return { q: nodes, coef, first, qmin: nodes[0]!, qmax, modification, lowQ: opts.lowQ ?? "none" };
}

// ---------------------------------------------------------------------------
// Omitted low-Q region: closed-form I_1, I_2
// ---------------------------------------------------------------------------

/**
 * ∫_0^{Q0} Q cos(kQ) dQ = [kQ0 sin(kQ0) + cos(kQ0) − 1]/k². The closed form is
 * an O(1) difference for an O(x²) result near k = 0 (x = kQ0), so below |x| = 1
 * it is summed as Q0²·Σ_l (−1)^l x^{2l}/((2l)!·(2l + 2)) instead.
 */
function qCosIntegral(k: number, q0: number): number {
  const x = k * q0;
  if (Math.abs(x) < 1) {
    let acc = 0;
    let t = 1; // (−1)^l x^{2l}/(2l)!
    for (let l = 0; l < 40; l++) {
      const term = t / (2 * l + 2);
      acc += term;
      if (Math.abs(term) <= 1e-18 * Math.abs(acc)) break;
      t *= -(x * x) / ((2 * l + 1) * (2 * l + 2));
    }
    return q0 * q0 * acc;
  }
  return (x * Math.sin(x) + Math.cos(x) - 1) / (k * k);
}

/** ∫_0^{Q0} cos(kQ) dQ = sin(kQ0)/k, → Q0 at k = 0. */
function cosIntegral(k: number, q0: number): number {
  const x = k * q0;
  if (Math.abs(x) < 1e-6) return q0 * (1 - (x * x) / 6);
  return Math.sin(x) / k;
}

/**
 * I_n(r) = ∫_0^{Q0} Qⁿ M(Q) sin(Qr) dQ for n = 1, 2 — the two integrals the
 * linear low-Q extrapolation needs. Closed forms, with V = Q0·r: for M ≡ 1
 *
 *   I_1 = (sin V − V cos V)/r²,   I_2 = [2V sin V − (V² − 2) cos V − 2]/r³
 *
 * and for Lorch, M = sin(AQ)/(AQ), A = π/Qmax, via
 * sin(AQ)·sin(rQ) = ½[cos((r−A)Q) − cos((r+A)Q)]:
 *
 *   I_1 = [C_0(r−A) − C_0(r+A)]/(2A),   I_2 = [C_1(r−A) − C_1(r+A)]/(2A)
 *
 * with C_0(k) = ∫_0^{Q0} cos kQ dQ, C_1(k) = ∫_0^{Q0} Q cos kQ dQ — the
 * expressions of pystog's `_low_x_correction`, with the removable singularity
 * at r = A handled. Both closed forms CANCEL at small V (the plain one is a
 * difference of O(1) terms for an O(V⁴) result; the Lorch one a difference of
 * nearly equal C(±A) when r ≪ A — measured 1.6e-11 and 3e-9 relative), so for
 * V < 2 the integrand is expanded instead (`lowQSeries`).
 */
export function lowQIntegrals(r: number, q0: number, modification: ModificationFunction, qmax: number): { i1: number; i2: number } {
  if (q0 <= 0 || r === 0) return { i1: 0, i2: 0 };
  const a = modification === "lorch" ? Math.PI / qmax : 0;
  const v = q0 * r;
  if (Math.abs(v) < 2) return { i1: lowQSeries(1, r, q0, a), i2: lowQSeries(2, r, q0, a) };
  if (modification === "lorch") {
    return {
      i1: (cosIntegral(r - a, q0) - cosIntegral(r + a, q0)) / (2 * a),
      i2: (qCosIntegral(r - a, q0) - qCosIntegral(r + a, q0)) / (2 * a),
    };
  }
  const s = Math.sin(v);
  const c = Math.cos(v);
  return {
    i1: (s - v * c) / (r * r),
    i2: (2 * v * s - (v * v - 2) * c - 2) / (r * r * r),
  };
}

/**
 * Power series of I_n(r) for small x = Q0·r, expanding sin(Qr) and the Lorch
 * sinc(AQ) (a = A·Q0; a = 0 is M ≡ 1):
 *
 *   I_n = Q0^{n+1} Σ_m (−1)^m x^{2m+1}/(2m+1)! · ν(n + 2m + 1),
 *   ν(p) = ∫_0^1 t^p sinc(a t) dt = Σ_l (−1)^l a^{2l} / ((2l+1)!·(p + 2l + 1)).
 *
 * Both alternate with terms that fall factorially for x < 2 and a ≤ π (the
 * largest term is O(1), so no cancellation); summed until a term no longer
 * changes the total.
 */
function lowQSeries(n: 1 | 2, r: number, q0: number, A: number): number {
  const x = q0 * r;
  const a2 = A * q0 * (A * q0);
  const nu = (p: number): number => {
    let acc = 0;
    let t = 1; // (−1)^l a^{2l}/(2l+1)!
    for (let l = 0; l < 60; l++) {
      const term = t / (p + 2 * l + 1);
      acc += term;
      if (Math.abs(term) <= 1e-18 * Math.abs(acc)) break;
      t *= -a2 / ((2 * l + 2) * (2 * l + 3));
    }
    return acc;
  };
  let acc = 0;
  let t = x; // (−1)^m x^{2m+1}/(2m+1)!
  for (let m = 0; m < 60; m++) {
    const term = t * nu(n + 2 * m + 1);
    acc += term;
    if (Math.abs(term) <= 1e-18 * Math.abs(acc)) break;
    t *= -(x * x) / ((2 * m + 2) * (2 * m + 3));
  }
  return q0 ** (n + 1) * acc;
}

// ---------------------------------------------------------------------------
// Value, σ, covariance — one accumulation per r, shared by all three
// ---------------------------------------------------------------------------

/**
 * The low-Q term at r split into its two parts: G_low = e·F_0 + b, where
 * e = ∂G_low/∂F_0 = (2/π)·I_2/Q_0² and b = (2/π)·(I_2/Q_0 − I_1).
 */
function lowQTerm(op: SineTransformOperator, r: number): { e: number; b: number } {
  if (op.lowQ !== "linear") return { e: 0, b: 0 };
  const q0 = op.q[0]!;
  const { i1, i2 } = lowQIntegrals(r, q0, op.modification, op.qmax);
  return { e: (TWO_OVER_PI * i2) / (q0 * q0), b: TWO_OVER_PI * (i2 / q0 - i1) };
}

/**
 * G(r) and σ_G(r)² at one r — the single accumulation every public entry point
 * goes through, so `sineTransform`'s σ and the covariance diagonal are the
 * same floating-point numbers. `f`/`sigmaF` are aligned with the operator's
 * input grid; either may be null.
 */
function accumulateAt(
  op: SineTransformOperator,
  f: ArrayLike<number> | null,
  sigmaF: ArrayLike<number> | null,
  r: number,
): { g: number; variance: number } {
  const { q, coef, first } = op;
  const low = lowQTerm(op, r);
  let g = 0;
  let variance = 0;
  for (let k = 0; k < q.length; k++) {
    const s = Math.sin(q[k]! * r);
    let phi = coef[k]! * s;
    if (k === 0) phi += low.e;
    if (f) g += phi * f[first + k]!;
    if (sigmaF) {
      const u = phi * sigmaF[first + k]!;
      variance += u * u;
    }
  }
  if (f) g += low.b;
  return { g, variance };
}

/**
 * G(r) on `r` — and σ_G(r) when `sigmaF` (σ of F, aligned with the operator's
 * input grid) is given. O(n_Q·n_r), one sine per (Q, r) pair shared by both.
 */
export function sineTransform(
  op: SineTransformOperator,
  f: ArrayLike<number>,
  r: ArrayLike<number>,
  sigmaF?: ArrayLike<number>,
): { g: Float64Array; sigma?: Float64Array } {
  const g = new Float64Array(r.length);
  const sigma = sigmaF ? new Float64Array(r.length) : undefined;
  for (let j = 0; j < r.length; j++) {
    const a = accumulateAt(op, f, sigmaF ?? null, r[j]!);
    g[j] = a.g;
    if (sigma) sigma[j] = Math.sqrt(a.variance);
  }
  return sigma ? { g, sigma } : { g };
}

/** σ_G(r) alone (no data values needed — the operator is linear). */
export function sineTransformSigma(op: SineTransformOperator, sigmaF: ArrayLike<number>, r: ArrayLike<number>): Float64Array {
  const out = new Float64Array(r.length);
  for (let j = 0; j < r.length; j++) out[j] = Math.sqrt(accumulateAt(op, null, sigmaF, r[j]!).variance);
  return out;
}

/**
 * Noise autocorrelation P(x) = Σ_k c_k² σ_F,k² cos(Q_k x) of the sinusoidal
 * part — the Toeplitz kernel of the covariance (see module header).
 */
export function noiseAutocorrelation(op: SineTransformOperator, sigmaF: ArrayLike<number>, x: ArrayLike<number>): Float64Array {
  const { q, coef, first } = op;
  const a = new Float64Array(q.length);
  for (let k = 0; k < q.length; k++) {
    const u = coef[k]! * sigmaF[first + k]!;
    a[k] = u * u;
  }
  const out = new Float64Array(x.length);
  for (let j = 0; j < x.length; j++) {
    let acc = 0;
    for (let k = 0; k < q.length; k++) acc += a[k]! * Math.cos(q[k]! * x[j]!);
    out[j] = acc;
  }
  return out;
}

/** r_i = r_0 + i·h within 1e-7·h for every i, or null. */
export function uniformGridStep(r: ArrayLike<number>): number | null {
  const n = r.length;
  if (n < 2) return null;
  const h = (r[n - 1]! - r[0]!) / (n - 1);
  if (!(h > 0)) return null;
  for (let i = 1; i < n; i++) if (Math.abs(r[i]! - (r[0]! + i * h)) > 1e-7 * h) return null;
  return h;
}

/**
 * The full covariance matrix Cov[G(r_i), G(r_j)] (row-major n×n, symmetric) of
 * the transformed G(r), propagated exactly from independent σ_F,k.
 *
 * Uniform r grid: C_ij = ½[T_{|i−j|} − H_{i+j}] with T_d = P(d·h) and
 * H_s = P(2r_0 + s·h) — O(n_Q·n) cosines + O(n²) assembly. Non-uniform grid:
 * the direct sum Σ_k a_k sin(Q_k r_i) sin(Q_k r_j), O(n_Q·n²). Either way the
 * low-Q column correction (node 0, `lowQ: "linear"`) is added as a rank-two
 * update, and the DIAGONAL is taken from the shared per-r accumulation, so
 * √diag(C) equals `sineTransformSigma` exactly.
 */
export function sineTransformCovariance(op: SineTransformOperator, sigmaF: ArrayLike<number>, r: ArrayLike<number>): Float64Array {
  const n = r.length;
  const entry = covarianceEntries(op, sigmaF, r);
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    c[i * n + i] = entry(i, i);
    for (let j = i + 1; j < n; j++) {
      const v = entry(i, j);
      c[i * n + j] = v;
      c[j * n + i] = v;
    }
  }
  return c;
}

/**
 * Covariance ENTRY accessor (i, j) → Cov[G(r_i), G(r_j)] — the same numbers as
 * {@link sineTransformCovariance} without storing the n×n matrix, for
 * streaming reductions over a whole fit window (a 2700-point window would be a
 * 58 MB matrix). Uniform grids precompute only the O(n) Toeplitz/Hankel
 * vectors; a non-uniform grid precomputes the sine table and sums per entry.
 */
export function covarianceEntries(op: SineTransformOperator, sigmaF: ArrayLike<number>, r: ArrayLike<number>): (i: number, j: number) => number {
  const n = r.length;
  const { q, coef, first } = op;
  const diag = Float64Array.from({ length: n }, (_, i) => accumulateAt(op, null, sigmaF, r[i]!).variance);

  // Node 0's column is c_0 sin(Q_0 r) + e(r) under the low-Q extrapolation; the
  // sinusoidal part is in the main term, so add σ_0²·[e eᵀ + c_0(s eᵀ + e sᵀ)].
  const low = op.lowQ === "linear";
  const s0 = sigmaF[first]! * sigmaF[first]!;
  const e = low ? Float64Array.from({ length: n }, (_, i) => lowQTerm(op, r[i]!).e) : null;
  const sn = low ? Float64Array.from({ length: n }, (_, i) => Math.sin(q[0]! * r[i]!)) : null;
  const lowPart = (i: number, j: number): number =>
    e && sn ? s0 * (e[i]! * e[j]! + coef[0]! * (sn[i]! * e[j]! + e[i]! * sn[j]!)) : 0;

  const h = uniformGridStep(r);
  if (h !== null) {
    const t = noiseAutocorrelation(op, sigmaF, Float64Array.from({ length: n }, (_, d) => d * h));
    const hk = noiseAutocorrelation(op, sigmaF, Float64Array.from({ length: Math.max(0, 2 * n - 1) }, (_, s) => 2 * r[0]! + s * h));
    return (i, j) => (i === j ? diag[i]! : 0.5 * (t[Math.abs(i - j)]! - hk[i + j]!) + lowPart(i, j));
  }
  const a = new Float64Array(q.length);
  for (let k = 0; k < q.length; k++) {
    const u = coef[k]! * sigmaF[first + k]!;
    a[k] = u * u;
  }
  const nq = q.length;
  const sines = new Float64Array(nq * n);
  for (let j = 0; j < n; j++) for (let k = 0; k < nq; k++) sines[j * nq + k] = Math.sin(q[k]! * r[j]!);
  return (i, j) => {
    if (i === j) return diag[i]!;
    let acc = 0;
    for (let k = 0; k < nq; k++) acc += a[k]! * sines[i * nq + k]! * sines[j * nq + k]!;
    return acc + lowPart(i, j);
  };
}

/** Correlation matrix ρ_ij = C_ij/√(C_ii C_jj) from a row-major covariance (0 where a σ is 0). */
export function correlationFromCovariance(cov: ArrayLike<number>, n: number): Float64Array {
  const sd = Float64Array.from({ length: n }, (_, i) => Math.sqrt(cov[i * n + i]!));
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = sd[i]! * sd[j]!;
      out[i * n + j] = d > 0 ? cov[i * n + j]! / d : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reciprocal-space data → G(r)
// ---------------------------------------------------------------------------

/** F(Q) and σ_F (when the data carry σ) from retained reciprocal-space data. */
export function reducedStructureFunction(data: ReciprocalSpaceData): { q: readonly number[]; f: Float64Array; sigmaF?: Float64Array } {
  const f = data.kind === "sq" ? fOfQFromSOfQ(data.q, data.y) : Float64Array.from(data.y);
  if (!data.sigma) return { q: data.q, f };
  const sigmaF = data.kind === "sq" ? sigmaFFromSigmaS(data.q, data.sigma) : Float64Array.from(data.sigma);
  return { q: data.q, f, sigmaF };
}

/**
 * Transform retained S(Q)/F(Q) data onto `rGrid`: the operator, G(r) and —
 * when the data carry σ — σ_G(r).
 */
export function transformReciprocal(
  data: ReciprocalSpaceData,
  rGrid: ArrayLike<number>,
  opts: SineTransformOptions = {},
): { op: SineTransformOperator; g: Float64Array; sigma?: Float64Array; sigmaF?: Float64Array } {
  const { q, f, sigmaF } = reducedStructureFunction(data);
  const op = sineTransformOperator(q, opts);
  const res = sineTransform(op, f, rGrid, sigmaF);
  return { op, g: res.g, ...(res.sigma ? { sigma: res.sigma } : {}), ...(sigmaF ? { sigmaF } : {}) };
}

/**
 * Sine-transform F(Q) samples (ascending, need not be uniform) to G(r) on
 * `rGrid` — the plain value path (no window, no modification, no low-Q term).
 */
export function gOfRFromFOfQ(q: ArrayLike<number>, f: ArrayLike<number>, rGrid: ArrayLike<number>): Float64Array {
  if (q.length < 2) return new Float64Array(rGrid.length);
  return sineTransform(sineTransformOperator(q), f, rGrid).g;
}

/** Default real-space grid for a transformed pattern (PDFgetX3 conventions). */
export function defaultTransformGrid(rMax = 30, rStep = 0.01): number[] {
  const n = Math.round(rMax / rStep);
  return Array.from({ length: n }, (_, k) => (k + 1) * rStep);
}
