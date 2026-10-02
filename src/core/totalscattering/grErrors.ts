/**
 * The statistical error of a G(r) transformed from S(Q) — diagnostics built on
 * the exact propagation in `fourier.ts` (value, σ and covariance all come from
 * that one operator; nothing here re-derives a quadrature).
 *
 * What a fitter needs to know about the G(r) error, and where it comes from:
 *
 *  - **σ_G(r)** — `sineTransformSigma`. Zero at r = 0, ∝ r below π/Qmax, then
 *    flat at √(½P(0)) (fourier.ts header).
 *  - **How correlated neighboring points are** — `stationaryNoiseCorrelation`,
 *    ρ(Δ) = P(Δ)/P(0): the Toeplitz part of Cov, exact once both points are far
 *    enough from r = 0 for the Hankel (reflection) part P(r + r′) to have
 *    decayed. Its continuum limits for a uniform Q grid starting at 0 (u = Qmax·Δ):
 *
 *        white F(Q) noise (σ_F const):            ρ(u) = sin u / u
 *        white S(Q) noise (σ_F = Q·σ_S, σ_S const): ρ(u) = 3[(u² − 2) sin u + 2u cos u] / u³
 *
 *    (from ∫_0^1 x^{2p} cos(ux) dx / ∫_0^1 x^{2p} dx with p = 0, 1). The first
 *    vanishes at every Nyquist spacing Δ = mπ/Qmax; the second does NOT —
 *    ρ(π) = −6/π² ≈ −0.61. Real σ_S(Q) usually grows with Q, so real data sit
 *    at or beyond the white-S case.
 *  - **How many independent points the window holds** — two numbers:
 *    `nyquistPointCount` = (r_max − r_min)·Qmax/π, the sampling-theorem count
 *    (Farrow et al. 2011), and `effectiveIndependentPoints`, the participation
 *    ratio N_eff = (Σλ)²/Σλ² of the CORRELATION matrix's eigenvalues λ
 *    (Bretherton et al. 1999) — computed without the eigendecomposition as
 *    n²/‖R‖_F², since Σλ = tr R = n and Σλ² = ‖R‖_F². For white F noise
 *    N_eff ≈ the Nyquist count; for white S noise it is ≈ 5/9 of it (the
 *    spectrum ∝ Q² gives (∫x²)²/∫x⁴ = 5/9) — the Q² noise weighting removes
 *    information the Nyquist count assumes is there.
 *
 * These describe the STATISTICAL error of the reduced S(Q) only (its σ column);
 * systematic reduction errors are not in it.
 */

import type { PdfPattern } from "@/core/diffraction/types";
import {
  covarianceEntries,
  noiseAutocorrelation,
  reducedStructureFunction,
  sigmaFFromSigmaS,
  sineTransformOperator,
  sineTransformSigma,
  type SineTransformOperator,
} from "@/core/totalscattering/fourier";

/** Nyquist step Δr = π/Qmax (Å): the coarsest r grid that keeps all the information in a band-limited G(r). */
export function nyquistStep(qmax: number): number {
  return Math.PI / qmax;
}

/** Sampling-theorem count of independent points on [rmin, rmax]: (rmax − rmin)·Qmax/π. */
export function nyquistPointCount(rmin: number, rmax: number, qmax: number): number {
  return (Math.max(0, rmax - rmin) * qmax) / Math.PI;
}

/** Continuum white-F(Q) correlation ρ(u) = sin u / u, u = Qmax·Δ. */
export function whiteFCorrelation(u: number): number {
  return Math.abs(u) < 1e-6 ? 1 - (u * u) / 6 : Math.sin(u) / u;
}

/**
 * Continuum white-S(Q) correlation ρ(u) = 3[(u² − 2) sin u + 2u cos u]/u³,
 * u = Qmax·Δ. The closed form is an O(1) difference for an O(1) − O(u²)
 * result, so below u = 2 it is summed as 3·Σ (−1)^m u^{2m}/((2m)!·(2m + 3)).
 */
export function whiteSCorrelation(u: number): number {
  if (Math.abs(u) < 2) {
    let acc = 0;
    let t = 1; // (−1)^m u^{2m}/(2m)!
    for (let m = 0; m < 40; m++) {
      const term = t / (2 * m + 3);
      acc += term;
      if (Math.abs(term) <= 1e-18 * Math.abs(acc)) break;
      t *= -(u * u) / ((2 * m + 1) * (2 * m + 2));
    }
    return 3 * acc;
  }
  return (3 * ((u * u - 2) * Math.sin(u) + 2 * u * Math.cos(u))) / (u * u * u);
}

/**
 * Stationary correlation ρ(Δ) = P(Δ)/P(0) between G(r) and G(r + Δ) for r far
 * from the origin (where the Hankel term of Cov has decayed).
 */
export function stationaryNoiseCorrelation(op: SineTransformOperator, sigmaF: ArrayLike<number>, deltas: ArrayLike<number>): Float64Array {
  const p0 = noiseAutocorrelation(op, sigmaF, [0])[0]!;
  const p = noiseAutocorrelation(op, sigmaF, deltas);
  return p.map((v) => (p0 > 0 ? v / p0 : 0));
}

/**
 * Participation ratio N_eff = n²/‖R‖_F² of the correlation matrix R of G on
 * the points `r` (Bretherton et al. 1999) — streamed from the covariance
 * entries, O(n²) time and O(n) memory. Points with σ_G = 0 are skipped (they
 * carry no noise to be independent in).
 */
export function effectiveIndependentPoints(op: SineTransformOperator, sigmaF: ArrayLike<number>, r: ArrayLike<number>): number {
  const n = r.length;
  if (n === 0) return 0;
  const entry = covarianceEntries(op, sigmaF, r);
  const sd = Float64Array.from({ length: n }, (_, i) => Math.sqrt(entry(i, i)));
  let m = 0;
  let frob = 0;
  for (let i = 0; i < n; i++) {
    if (!(sd[i]! > 0)) continue;
    m++;
    frob += 1; // ρ_ii
    for (let j = i + 1; j < n; j++) {
      if (!(sd[j]! > 0)) continue;
      const rho = entry(i, j) / (sd[i]! * sd[j]!);
      frob += 2 * rho * rho;
    }
  }
  return frob > 0 ? (m * m) / frob : 0;
}

/**
 * σ_G(r) from S(Q) uncertainties, through the exact trapezoid operator of
 * `fourier.ts` over the whole Q range (no window, no modification). Kept for
 * callers that hold bare arrays; patterns carry their σ already.
 */
export function propagateGrSigma(q: ArrayLike<number>, sigmaS: ArrayLike<number>, r: ArrayLike<number>): Float64Array {
  return sineTransformSigma(sineTransformOperator(q), sigmaFFromSigmaS(q, sigmaS), r);
}

/** Parse a Mantid-style `# X Y E` three-column S(Q) text file. */
export function parseSqWithErrors(text: string): { q: number[]; s: number[]; sigma: number[] } {
  const q: number[] = [];
  const s: number[] = [];
  const sigma: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const t = line.split(/\s+/).map(Number);
    if (t.length >= 3 && t.every(Number.isFinite)) {
      q.push(t[0]!);
      s.push(t[1]!);
      sigma.push(t[2]!);
    }
  }
  return { q, s, sigma };
}

/** What the propagated error says about a G(r) fit window (see module header). */
export interface GrUncertaintySummary {
  /** G(r) points inside the window. */
  readonly points: number;
  /** The data's r step and the Nyquist step π/Qmax (Å); oversampling = their ratio. */
  readonly gridStep: number;
  readonly nyquistStep: number;
  readonly oversampling: number;
  /** Independent points: sampling-theorem count and correlation participation ratio. */
  readonly nyquistPoints: number;
  readonly effectivePoints: number;
  /** Stationary correlation between neighboring grid points, and at the Nyquist spacing. */
  readonly rhoNeighbor: number;
  readonly rhoNyquist: number;
  /** Median and maximum σ_G inside the window (Å⁻²). */
  readonly medianSigma: number;
  readonly maxSigma: number;
}

/**
 * Summarize the propagated G(r) error of a pattern transformed from S(Q)/F(Q)
 * with an error column, over the fit window [rmin, rmax]. Null when the
 * pattern has no retained reciprocal data with σ (a G(r) file, or S(Q)
 * without errors) or fewer than two points fall in the window.
 */
export function grUncertaintySummary(pattern: PdfPattern, window: { min: number; max: number }): GrUncertaintySummary | null {
  const rec = pattern.reciprocal;
  const tr = pattern.transform;
  if (!rec?.sigma || !tr) return null;
  const inWin = pattern.points.filter((p) => p.r >= window.min && p.r <= window.max);
  if (inWin.length < 2) return null;
  const { q, sigmaF } = reducedStructureFunction(rec);
  if (!sigmaF) return null;
  const op = sineTransformOperator(q, { qmin: tr.qmin, qmax: tr.qmax, modification: tr.modification, lowQ: tr.lowQ });
  const r = inWin.map((p) => p.r);
  const gridStep = (r[r.length - 1]! - r[0]!) / (r.length - 1);
  const dNyq = nyquistStep(op.qmax);
  const [rhoNeighbor, rhoNyquist] = stationaryNoiseCorrelation(op, sigmaF, [gridStep, dNyq]);
  const sig = sineTransformSigma(op, sigmaF, r);
  const sorted = Array.from(sig).sort((a, b) => a - b);
  return {
    points: r.length,
    gridStep,
    nyquistStep: dNyq,
    oversampling: dNyq / gridStep,
    nyquistPoints: nyquistPointCount(r[0]!, r[r.length - 1]!, op.qmax),
    effectivePoints: effectiveIndependentPoints(op, sigmaF, r),
    rhoNeighbor: rhoNeighbor!,
    rhoNyquist: rhoNyquist!,
    medianSigma: sorted[Math.floor((sorted.length - 1) / 2)]!,
    maxSigma: sorted[sorted.length - 1]!,
  };
}
