/**
 * Magnetic pair distribution function (mPDF) — the Frandsen spin-pair kernel
 * (PDF_MPDF_ROADMAP §4, phase P4).
 *
 * Normalized mPDF (Frandsen, Yang & Billinge 2014, Acta Cryst A70 3, Eq. 8;
 * ported from `diffpy.mpdf`'s `calculatemPDF`):
 *
 *   f(r) = (3/2N) Σ_{i≠j} [ A_ij·δ(r − r_ij)/r + B_ij·(r/r_ij³)·Θ(r_ij − r) ]
 *          − 4π r ρ₀ m̄_net²                      (net-moment term; ≡ 0 for AFM)
 *
 * with, per ordered pair (x̂ along the bond, ŷ the transverse part of m_i):
 *   A_ij = (m_i·ŷ)(m_j·ŷ)/|ŷ|²   (transverse spin correlation, the δ peaks)
 *   B_ij = 2(m_i·x̂)(m_j·x̂) − A_ij (the continuous r/r³ baseline)
 *
 * The moments m are Cartesian μ_B vectors; the (2/3)·g²S(S+1) of the reference
 * implementation is carried classically as the moment bilinears themselves plus
 * the 3/2 prefactor, so f(r) here equals `calculatemPDF(sxyz=m, gfactors=1,
 * K1=(2/3)(γr₀/2)²)`. Peaks are broadened by a Gaussian of width `psigma`
 * (thermal motion), damped by the instrument exp(−(Qdamp·r)²/2), and optionally
 * by a short-range-order envelope exp(−r/ξ).
 *
 * Unnormalized mPDF (Frandsen & Billinge 2015, Acta Cryst A71 325; the quantity
 * actually present in a G(r) reduced with the magnetic form factor left in):
 *
 *   d(r) = ordScale · (γr₀/2)²/(2π) · [f ⊛ S](r)  +  paraScale · (−K₂/π)·S′(r)
 *
 * where S(r) is the real-space shape of the squared ⟨j0⟩ form factor (the
 * self-convolution of its cosine transform) and the S′ term is the broad
 * paramagnetic self-scattering hump near r = 0, K₂ = (2/3)(γr₀/2)²⟨m²⟩.
 * Units: (γr₀/2)² is kept in the literature's 10⁻²⁴ cm² (barn), so d(r) matches
 * `diffpy.mpdf.calculateDr` 1:1; multiply by {@link BARN_TO_FM2} to combine
 * with fm-based nuclear scattering lengths.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { orthogonalizationMatrix, reciprocalMetricTensor, fractionalToCartesian, cellVolume } from "@/core/crystal/unitCell";
import { mulVec } from "@/core/math/mat3";
import { magneticFormFactorJ0 } from "@/core/scattering/magnetic";

/** (γ·r₀/2)² — γ = 1.913, r₀ = 0.281794·10⁻¹² cm — in 10⁻²⁴ cm² (barn). */
export const MPDF_PREFACTOR = (1.913 * 0.281794 / 2) ** 2;

/** 1 barn = 100 fm², for mixing d(r) with fm-based ⟨b⟩² normalizations. */
export const BARN_TO_FM2 = 100;

/** Grid extension (Å) past the data window so edge pairs/baseline are right —
 *  diffpy.mpdf's `extendedrmax` default. */
export const MPDF_GRID_EXTENSION = 4;

/** One spin of the magnetic box: fractional position + Cartesian moment (μ_B). */
export interface MpdfSpin {
  readonly position: Vec3;
  readonly moment: Vec3;
}

/** One ordered spin pair within reach: distance, bond direction, spin indices. */
export interface SpinPair {
  readonly rij: number;
  readonly nHat: Vec3;
  readonly i: number;
  readonly j: number;
}

export interface MpdfProfile {
  /** Gaussian broadening σ (Å) of the magnetic pair peaks (thermal motion). */
  readonly psigma: number;
  /** Instrument Q-resolution damping (Å⁻¹); 0 disables. */
  readonly qdamp?: number;
  /** Short-range-order correlation length ξ (Å): exp(−r/ξ) envelope on the
   *  pair terms AND the net-moment line. 0/absent = infinite (no damping). */
  readonly corrLength?: number;
  /** Overall scale of f(r). Default 1. */
  readonly ordScale?: number;
}

/** Uniform grid 0 … rMax + {@link MPDF_GRID_EXTENSION}, matching `rStep`. */
export function mpdfExtendedGrid(rMax: number, rStep: number): Float64Array {
  const n = Math.max(2, Math.round((rMax + MPDF_GRID_EXTENSION) / rStep) + 1);
  const grid = new Float64Array(n);
  for (let k = 0; k < n; k++) grid[k] = k * rStep;
  return grid;
}

/**
 * Enumerate every ordered spin pair within `rMax` over periodic images of the
 * box cell — the spin-pair sibling of `pdf/pairEnumerator.enumeratePairs`,
 * additionally carrying the bond unit vector the transverse projection needs.
 * Geometry only (no moments), so a caller may cache the list across every
 * moment/scale/envelope evaluation of a Jacobian.
 */
export function enumerateSpinPairs(cell: UnitCell, positions: readonly Vec3[], rMax: number): SpinPair[] {
  const M = orthogonalizationMatrix(cell);
  const cart: Vec3[] = positions.map((p) => fractionalToCartesian(cell, p));
  const aVec: Vec3 = [M[0][0], M[1][0], M[2][0]];
  const bVec: Vec3 = [M[0][1], M[1][1], M[2][1]];
  const cVec: Vec3 = [M[0][2], M[1][2], M[2][2]];
  const bodyDiag = Math.hypot(
    aVec[0] + bVec[0] + cVec[0],
    aVec[1] + bVec[1] + cVec[1],
    aVec[2] + bVec[2] + cVec[2],
  );
  // Reciprocal-basis image bound — see enumeratePairs for why the axis-length
  // bound under-enumerates oblique cells.
  const reach = rMax + bodyDiag;
  const gStar = reciprocalMetricTensor(cell);
  const n1 = Math.ceil(reach * Math.sqrt(Math.max(gStar[0][0], 0)));
  const n2 = Math.ceil(reach * Math.sqrt(Math.max(gStar[1][1], 0)));
  const n3 = Math.ceil(reach * Math.sqrt(Math.max(gStar[2][2], 0)));

  const pairs: SpinPair[] = [];
  const rMaxSq = rMax * rMax;
  for (let t1 = -n1; t1 <= n1; t1++) {
    for (let t2 = -n2; t2 <= n2; t2++) {
      for (let t3 = -n3; t3 <= n3; t3++) {
        const T = mulVec(M, [t1, t2, t3]);
        for (let i = 0; i < positions.length; i++) {
          const ci = cart[i]!;
          for (let j = 0; j < positions.length; j++) {
            const cj = cart[j]!;
            const dx = cj[0] + T[0] - ci[0];
            const dy = cj[1] + T[1] - ci[1];
            const dz = cj[2] + T[2] - ci[2];
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 <= 1e-10 || r2 > rMaxSq) continue;
            const rij = Math.sqrt(r2);
            pairs.push({ rij, nHat: [dx / rij, dy / rij, dz / rij], i, j });
          }
        }
      }
    }
  }
  return pairs;
}

function dotv(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Occupancy-free average |m|² over the spins (μ_B²) — the para-term weight. */
export function averageMomentSq(spins: readonly MpdfSpin[]): number {
  if (spins.length === 0) return 0;
  let s = 0;
  for (const spin of spins) s += dotv(spin.moment, spin.moment);
  return s / spins.length;
}

/** |Σ m_i|/N — the net ordered moment per spin (μ_B); 0 for a compensated AFM. */
export function netMomentPerSpin(spins: readonly MpdfSpin[]): number {
  if (spins.length === 0) return 0;
  const sum: [number, number, number] = [0, 0, 0];
  for (const spin of spins) {
    sum[0] += spin.moment[0];
    sum[1] += spin.moment[1];
    sum[2] += spin.moment[2];
  }
  return Math.hypot(sum[0], sum[1], sum[2]) / spins.length;
}

/** Gaussian kernel matching the reference: x ∈ [−3, 3) step `rStep`, unit-area
 *  density values. */
function gaussKernel(rStep: number, psigma: number): Float64Array {
  const n = Math.ceil((6 - 1e-9) / rStep);
  const y = new Float64Array(n);
  const norm = 1 / (Math.sqrt(2 * Math.PI) * psigma);
  for (let k = 0; k < n; k++) {
    const x = -3 + k * rStep;
    y[k] = norm * Math.exp(-(x * x) / (2 * psigma * psigma));
  }
  return y;
}

/** Direct full convolution (numpy `convolve(a, b, 'full')`). */
function convolveFull(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]! + ai * b[j]!;
  }
  return out;
}

/**
 * Normalized mPDF f(r) on the ascending uniform grid `rGrid` (start it at 0 and
 * extend past the window of interest — {@link mpdfExtendedGrid}). `pairs`
 * optionally supplies the cached geometry from {@link enumerateSpinPairs} over
 * the same cell/positions reaching `rGrid[last] + step/2`; passing the list a
 * fresh enumeration would produce is bit-identical to omitting it.
 */
export function computeNormalizedMpdf(
  cell: UnitCell,
  spins: readonly MpdfSpin[],
  rGrid: ArrayLike<number>,
  profile: MpdfProfile,
  pairs?: readonly SpinPair[],
): Float64Array {
  const n = rGrid.length;
  const f = new Float64Array(n);
  if (n < 2 || spins.length === 0) return f;
  const r0 = rGrid[0]!;
  const step = rGrid[1]! - rGrid[0]!;

  const pairList = pairs ?? enumerateSpinPairs(cell, spins.map((s) => s.position), rGrid[n - 1]! + step / 2);

  // Histogram the delta weights (s1) and the baseline weights B/r³ (s2), binned
  // to the nearest grid point (bin edges at r ± step/2, the reference binning).
  let s1 = new Float64Array(n);
  let s2 = new Float64Array(n);
  for (const pair of pairList) {
    const idx = Math.floor((pair.rij - r0 + step / 2) / step);
    if (idx < 0 || idx >= n) continue;
    const mi = spins[pair.i]!.moment;
    const mj = spins[pair.j]!.moment;
    const x = pair.nHat;
    const miDotX = dotv(mi, x);
    const yHat: Vec3 = [mi[0] - miDotX * x[0], mi[1] - miDotX * x[1], mi[2] - miDotX * x[2]];
    const yd = dotv(yHat, yHat);
    const a = yd < 1e-10 ? 0 : (dotv(mi, yHat) * dotv(mj, yHat)) / yd;
    const b = 2 * miDotX * dotv(mj, x) - a;
    s1[idx] = s1[idx]! + a;
    s2[idx] = s2[idx]! + b / (pair.rij * pair.rij * pair.rij);
  }

  // Thermal (Gaussian) broadening. s1 becomes a per-Å density (no ×step — the
  // δ-term is divided by r as a density); s2 keeps its ×step so its cumulative
  // sum stays the partial pair sum. Mirrors the reference implementation.
  if (profile.psigma > 0) {
    const kernel = gaussKernel(step, profile.psigma);
    const off = Math.floor(kernel.length / 2);
    s1[0] = 0;
    s1 = convolveFull(s1, kernel).slice(off, off + n);
    const s2c = convolveFull(s2, kernel).slice(off, off + n);
    for (let k = 0; k < n; k++) s2[k] = s2c[k]! * step;
  }

  let cum = 0;
  const ss2 = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cum += s2[k]!;
    ss2[k] = cum;
  }
  const total2 = cum;

  const N = spins.length;
  const norm = 3 / (2 * N);
  const xi = profile.corrLength ?? 0;
  const netMag = netMomentPerSpin(spins);
  const rho0 = N / cellVolume(cell);
  const qdamp = profile.qdamp ?? 0;
  const ordScale = profile.ordScale ?? 1;
  for (let k = 0; k < n; k++) {
    const r = rGrid[k]! > 0 ? rGrid[k]! : 1e-4 * step;
    let v = (s1[k]! / r + r * (total2 - ss2[k]!)) * norm;
    if (xi > 0) v *= Math.exp(-r / xi);
    // Net-moment line: −4π r ρ₀ m̄² in this normalization (≡ 0 for AFM), damped
    // by the same SRO envelope so a finite-ξ ferromagnet stays consistent.
    let line = 4 * Math.PI * r * rho0 * netMag * netMag;
    if (xi > 0) line *= Math.exp(-r / xi);
    v -= line;
    if (qdamp > 0) v *= Math.exp(-0.5 * (qdamp * r) * (qdamp * r));
    f[k] = ordScale * v;
  }
  return f;
}

/** The ⟨j0⟩ form factor of `ionIds` (occupancy-equal average) on a uniform Q
 *  grid — the input to {@link formFactorEnvelope}. */
export function j0Profile(
  ionIds: readonly string[],
  qMax = 25,
  qStep = 0.01,
): { q: Float64Array; f: Float64Array } {
  const n = Math.round(qMax / qStep) + 1;
  const q = new Float64Array(n);
  const f = new Float64Array(n);
  // Average 3d ⟨j0⟩ (the reference implementation's default) when no tabulated
  // ion id is supplied — a graceful fallback, not a physics claim.
  const avg3d = (s2: number): number =>
    0.2394 * Math.exp(-26.038 * s2) + 0.4727 * Math.exp(-12.1375 * s2) + 0.3065 * Math.exp(-3.0939 * s2) - 0.01906;
  for (let k = 0; k < n; k++) {
    q[k] = k * qStep;
    const s = q[k]! / (4 * Math.PI);
    let sum = 0;
    for (const id of ionIds) sum += magneticFormFactorJ0(id, s);
    f[k] = ionIds.length > 0 ? sum / ionIds.length : avg3d(s * s);
  }
  return { q, f };
}

/**
 * Real-space envelope of the squared form factor: the cosine transform of
 * ⟨j0⟩(Q) on [−rMax, rMax], self-convolved (transform of a product = the
 * convolution of transforms). Returned on the symmetric grid `r` with the
 * self-convolution `s` on the doubled grid implied by `cv` — both consumed by
 * {@link computeUnnormalizedMpdf}. Depends only on the ion list and grids, so
 * cache it across a refinement.
 */
export function formFactorEnvelope(
  ff: { q: ArrayLike<number>; f: ArrayLike<number> },
  rMax = 5,
  rStep = 0.01,
): { rHalfWidth: number; step: number; s: Float64Array } {
  const nHalf = Math.round(rMax / rStep);
  const qStep = ff.q.length > 1 ? ff.q[1]! - ff.q[0]! : 1;
  // sr(r) = √(2/π)·Σ f(Q)cos(Qr)·ΔQ on r ∈ [−rMax, rMax] (even — mirror r > 0).
  const half = new Float64Array(nHalf + 1);
  const pref = Math.sqrt(2 / Math.PI) * qStep;
  for (let k = 0; k <= nHalf; k++) {
    const r = k * rStep;
    let acc = 0;
    for (let m = 0; m < ff.q.length; m++) acc += ff.f[m]! * Math.cos(ff.q[m]! * r);
    half[k] = pref * acc;
  }
  const sr = new Float64Array(2 * nHalf + 1);
  for (let k = 0; k <= nHalf; k++) {
    sr[nHalf + k] = half[k]!;
    sr[nHalf - k] = half[k]!;
  }
  // Self-convolution (×step): S spans [−2rMax, 2rMax] on 4·nHalf + 1 points.
  const s = convolveFull(sr, sr);
  for (let k = 0; k < s.length; k++) s[k] = s[k]! * rStep;
  return { rHalfWidth: 2 * rMax, step: rStep, s };
}

/**
 * Unnormalized mPDF d(r) on `rGrid` from the normalized `fr` on the same grid
 * (which already carries ordScale/Qdamp/ξ): the ordered term is the convolution
 * with the form-factor envelope, the paramagnetic term its derivative — see the
 * module header. `mSqAvg` is ⟨m²⟩ (μ_B²) per spin. The grid step must equal the
 * envelope's step. Result in barn·μ_B² units (× {@link BARN_TO_FM2} for fm²).
 */
export function computeUnnormalizedMpdf(
  rGrid: ArrayLike<number>,
  fr: ArrayLike<number>,
  envelope: { rHalfWidth: number; step: number; s: Float64Array },
  paraScale: number,
  mSqAvg: number,
): Float64Array {
  const n = rGrid.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  const step = rGrid[1]! - rGrid[0]!;

  // Ordered term: cv(K1/(2π)·fr, S) sliced back onto rGrid. The envelope grid
  // is symmetric about 0, so the aligned slice starts at its negative-side
  // point count.
  const K1 = (2 / 3) * MPDF_PREFACTOR;
  const scaled = new Float64Array(n);
  for (let k = 0; k < n; k++) scaled[k] = (K1 / (2 * Math.PI)) * fr[k]!;
  const conv = convolveFull(scaled, envelope.s);
  const offset = Math.round(envelope.rHalfWidth / envelope.step);
  for (let k = 0; k < n; k++) out[k] = step * conv[k + offset]!;

  // Paramagnetic self-term: −K₂/π · S′(r), with S′ by central differences on
  // the envelope grid (numpy.gradient), evaluated at each r of the grid.
  const K2 = (2 / 3) * MPDF_PREFACTOR * mSqAvg;
  const s = envelope.s;
  const grad = (idx: number): number => {
    if (idx <= 0) return (s[1]! - s[0]!) / envelope.step;
    if (idx >= s.length - 1) return (s[s.length - 1]! - s[s.length - 2]!) / envelope.step;
    return (s[idx + 1]! - s[idx - 1]!) / (2 * envelope.step);
  };
  for (let k = 0; k < n; k++) {
    const idx = offset + Math.round((rGrid[k]! - 0) / envelope.step);
    if (idx < 0 || idx >= s.length) continue; // beyond the envelope support: S′ ≡ 0
    out[k] = out[k]! + paraScale * (-(K2 / Math.PI)) * grad(idx);
  }
  return out;
}
