/**
 * PDFfit2-style real-space forward model: a structure → calculated reduced PDF
 * `G_calc(r)` (PDF_MPDF_ROADMAP §4, phase P1).
 *
 * Master form (Farrow 2007 Eq. 4; Proffen & Billinge 1999):
 *
 *   G(r) = (1/N) Σ_i Σ_{j≠i} (b_i b_j / ⟨b⟩²) · (1/r_ij) · 𝒩(r; r_ij, σ_ij)
 *          − 4π r ρ₀
 *
 * with 𝒩 a unit-area Gaussian, the sum over one cell's atoms i and all periodic
 * images j within r_max. Per-peak width couples the ADP projection to correlated
 * motion and Q-resolution broadening (PDFgui guide §5.4):
 *
 *   σ_ij = σ′_ij · sqrt(1 − δ1/r_ij − δ2/r_ij² + Qbroad²·r_ij²)    (σ′² from ADP)
 *
 * and near-neighbour sharpening σ_ij ← sratio·σ_ij for r_ij < rcut. The whole PDF
 * is damped by the Q-resolution envelope exp(−(r·Qdamp)²/2) and scaled by `scale`.
 *
 * NOT yet applied: the finite-Qmax sinc termination convolution (phase P3) — so
 * this reproduces peak positions, widths, and relative heights, but not the
 * between-peak termination ripple. `delta1`/`delta2` and `sratio`/`rcut` are two
 * mutually-exclusive correlated-motion models — do not use both.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import type { PdfScatteringType } from "@/core/diffraction/types";
import { compositionWeights, numberDensity } from "@/core/totalscattering/weights";
import { enumeratePairs, type PdfPair } from "@/core/pdf/pairEnumerator";

export interface PdfModelParams {
  readonly scatteringType: PdfScatteringType;
  /** Overall PDF scale (dscale · pscale). */
  readonly scale: number;
  /** Q-resolution damping Qdamp (Å⁻¹); 0 disables the envelope. */
  readonly qdamp: number;
  /** r-dependent peak broadening Qbroad (Å⁻¹); 0 disables. */
  readonly qbroad: number;
  /** 1/r correlated-motion sharpening δ1 (Å). */
  readonly delta1: number;
  /** 1/r² correlated-motion sharpening δ2 (Å²). */
  readonly delta2: number;
  /** Near-neighbour sharpening ratio (≤1); applied for r < rcut. Default 1. */
  readonly sratio?: number;
  /** Cutoff radius (Å) for the sratio sharpening. Default 0 (disabled). */
  readonly rcut?: number;
  /**
   * Spherical-particle diameter (Å) for the PDFfit2 nanoparticle envelope:
   * G(r) is multiplied by the sphere characteristic function
   * f(x) = 1 − 3x/2 + x³/2 (x = r/d, 0 for r ≥ d). 0/absent disables (bulk).
   */
  readonly spdiameter?: number;
}

/** Sphere characteristic function γ₀(r/d) — the small-angle envelope of a
 *  spherical particle of diameter d (Guinier; PDFfit2 `spdiameter`). */
export function sphereEnvelope(r: number, diameter: number): number {
  if (!(diameter > 0)) return 1;
  const x = r / diameter;
  if (x >= 1) return 0;
  return 1 - 1.5 * x + 0.5 * x * x * x;
}

const GAUSS_WINDOW = 5; // accumulate each Gaussian over ±5σ
const SIGMA_FLOOR = 1e-4; // Å, guards against a zero-width peak

/**
 * How far (Å) beyond the last grid point pairs are enumerated, so peak tails
 * from just outside the window still land on the grid. A caller precomputing a
 * pair list for {@link computeGofR} must enumerate to `rGrid[last] + this`.
 */
export const PAIR_REACH_MARGIN = 1.0;

/**
 * Compute `G_calc(r)` on the ascending, uniformly-spaced grid `rGrid`.
 * `atoms` is one unit cell (e.g. from `expandStructureAtoms`).
 *
 * `pairs` optionally supplies a precomputed pair list (from `enumeratePairs`
 * over the SAME cell/atoms, reaching at least `rGrid[last] + 1 Å`) so a caller
 * evaluating many envelope-only parameter sets (scale, Qdamp, δ1/δ2 — the bulk
 * of a Jacobian) can skip the periodic-image enumeration. Passing the pairs a
 * fresh enumeration would produce is bit-identical to omitting them.
 */
export function computeGofR(
  cell: UnitCell,
  atoms: readonly ExpandedAtom[],
  rGrid: ArrayLike<number>,
  params: PdfModelParams,
  pairs?: readonly PdfPair[],
): Float64Array {
  const n = rGrid.length;
  const g = new Float64Array(n);
  if (n === 0 || atoms.length === 0) return g;

  const r0 = rGrid[0]!;
  const step = n > 1 ? rGrid[1]! - rGrid[0]! : 1;
  const rMaxGrid = rGrid[n - 1]!;

  const weights = compositionWeights(atoms, params.scatteringType);
  const rho0 = numberDensity(weights.nEff, cell);
  const norm = 1 / (weights.bAvg * weights.bAvg * weights.nEff);

  const sratio = params.sratio ?? 1;
  const rcut = params.rcut ?? 0;

  // Enumerate a little beyond the grid so peak tails just outside still land.
  const pairList = pairs ?? enumeratePairs(cell, atoms, rMaxGrid + PAIR_REACH_MARGIN);

  const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
  for (const pair of pairList) {
    const r = pair.rij;
    let sig2 = pair.msd * (1 - params.delta1 / r - params.delta2 / (r * r) + params.qbroad * params.qbroad * r * r);
    if (!(sig2 > 0)) sig2 = pair.msd > 0 ? pair.msd : SIGMA_FLOOR * SIGMA_FLOOR;
    let sigma = Math.sqrt(sig2);
    if (rcut > 0 && r < rcut) sigma *= sratio;
    if (sigma < SIGMA_FLOOR) sigma = SIGMA_FLOOR;

    const amp = (weights.perAtom[pair.i]! * weights.perAtom[pair.j]!) * norm / r;
    const invTwoSig2 = 1 / (2 * sigma * sigma);
    const peak = amp * INV_SQRT_2PI / sigma;

    const lo = Math.max(0, Math.ceil((r - GAUSS_WINDOW * sigma - r0) / step));
    const hi = Math.min(n - 1, Math.floor((r + GAUSS_WINDOW * sigma - r0) / step));
    for (let k = lo; k <= hi; k++) {
      const dr = r0 + k * step - r;
      g[k] = g[k]! + peak * Math.exp(-dr * dr * invTwoSig2);
    }
  }

  // Average-density baseline, particle/Q-resolution envelopes, overall scale.
  const fourPiRho0 = 4 * Math.PI * rho0;
  const spd = params.spdiameter ?? 0;
  for (let k = 0; k < n; k++) {
    const r = rGrid[k]!;
    let val = g[k]! - fourPiRho0 * r;
    if (spd > 0) val *= sphereEnvelope(r, spd);
    if (params.qdamp > 0) val *= Math.exp(-0.5 * (r * params.qdamp) * (r * params.qdamp));
    g[k] = params.scale * val;
  }
  return g;
}

/** Build a uniform r-grid [rMin, rMax] with step Δr (inclusive of rMax). */
export function makeRGrid(rMin: number, rMax: number, rStep: number): Float64Array {
  const n = Math.max(0, Math.round((rMax - rMin) / rStep) + 1);
  const grid = new Float64Array(n);
  for (let k = 0; k < n; k++) grid[k] = rMin + k * rStep;
  return grid;
}
