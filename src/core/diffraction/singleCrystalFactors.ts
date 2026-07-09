/**
 * Single-crystal intensity corrections and F²-based agreement factors — the
 * pieces that separate an integrated-Bragg refinement from the powder path,
 * following the SHELXL conventions crystallographers publish against.
 *
 * Calculated intensity for one reflection:
 *   I_calc = k · L · P · y(ext) · |F|²
 * with k the overall scale (SHELX OSF, applied to F²), L the single-crystal
 * Lorentz factor, P the polarization factor, and y the extinction correction.
 * Unlike powder there is no multiplicity or profile — each reflection is one
 * measured integrated intensity.
 *
 * Agreement (F² refinement, SHELXL):
 *   w      = 1 / [σ²(Fo²) + (a·P)² + b·P],   P = [max(Fo²,0) + 2·Fc²]/3
 *   wR2    = √[ Σ w(Fo²−Fc²)² / Σ w(Fo²)² ]
 *   R1     = Σ ||Fo|−|Fc|| / Σ |Fo|          (on F, over a chosen Fo² cutoff)
 *   GooF S = √[ Σ w(Fo²−Fc²)² / (N−P_params) ]
 * References: Sheldrick, Acta Cryst. A64 (2008) 112; C64 (2015) 3; SHELXL manual
 * (WGHT, EXTI, and the F² least-squares definitions).
 */

import type { Radiation } from "@/core/diffraction/types";
import { braggTheta } from "@/core/crystal/unitCell";

/**
 * Single-crystal Lorentz factor for a rotating-crystal / 4-circle measurement:
 * L = 1/sin(2θ). Returns 1 for TOF Laue (no single θ) and for the forward beam.
 */
export function singleCrystalLorentz(radiation: Radiation, d: number): number {
  if (radiation.kind === "neutron-tof") return 1;
  const theta = braggTheta(d, radiation.wavelength);
  if (Number.isNaN(theta)) return 1;
  const s2t = Math.sin(2 * theta);
  return Math.abs(s2t) < 1e-6 ? 1 : 1 / s2t;
}

/** Polarization factor P (X-ray only; 1 for neutrons). Mirrors the powder LP split. */
export function polarizationFactor(radiation: Radiation, d: number): number {
  if (radiation.kind !== "xray") return 1;
  const theta = braggTheta(d, radiation.wavelength);
  if (Number.isNaN(theta)) return 1;
  const cos2T = Math.cos(2 * theta);
  const p = radiation.polarization ?? 0.5;
  return (1 - p) * cos2T * cos2T + p;
}

/**
 * Becker–Coppens / SHELXL secondary-extinction correction y applied to F²:
 *   F²_corr = F² · y,   y = [1 + 0.001·x·F²·λ³ / sin(2θ)]^(−1/2)
 * where x is the refinable EXTI parameter (0 = no extinction). Strong low-angle
 * reflections are damped, as physically observed. TOF/forward-beam → y = 1.
 * (SHELXL uses the same expression on Fc²; the ^(−1/2) form corresponds to the
 * intensity, i.e. |F|², correction.)
 */
export function extinctionFactor(x: number, fSquared: number, radiation: Radiation, d: number): number {
  if (x <= 0 || radiation.kind === "neutron-tof") return 1;
  const theta = braggTheta(d, radiation.wavelength);
  if (Number.isNaN(theta)) return 1;
  const s2t = Math.sin(2 * theta);
  if (Math.abs(s2t) < 1e-6) return 1;
  const lambda = radiation.wavelength;
  const denom = 1 + (0.001 * x * fSquared * lambda * lambda * lambda) / s2t;
  return denom > 0 ? 1 / Math.sqrt(denom) : 1;
}

/** SHELX WGHT weights w = 1/[σ²(Fo²) + (aP)² + bP], P = [max(Fo²,0)+2Fc²]/3. */
export function shelxWeights(
  foSq: readonly number[],
  fcSq: readonly number[],
  sigma: readonly number[],
  a = 0,
  b = 0,
): Float64Array {
  const w = new Float64Array(foSq.length);
  for (let i = 0; i < foSq.length; i++) {
    const P = (Math.max(foSq[i]!, 0) + 2 * fcSq[i]!) / 3;
    const s = sigma[i] ?? 0;
    const denom = s * s + (a * P) * (a * P) + b * P;
    w[i] = denom > 0 ? 1 / denom : (s > 0 ? 1 / (s * s) : 1);
  }
  return w;
}

export interface SingleCrystalAgreement {
  /** R1 = Σ||Fo|−|Fc||/Σ|Fo| over reflections with Fo² > cutoff·σ (all if cutoff ≤ 0). */
  readonly r1: number;
  /** R1 over ALL reflections (no σ cutoff), for completeness. */
  readonly r1All: number;
  /** wR2 = √[Σw(Fo²−Fc²)²/Σw(Fo²)²]. */
  readonly wr2: number;
  /** Goodness of fit S = √[Σw(Fo²−Fc²)²/(N−P)]. */
  readonly goof: number;
  /** Number of reflections passing the Fo² cutoff (the "observed" I>nσ count). */
  readonly observed: number;
  /** Total reflections used. */
  readonly total: number;
}

/**
 * SHELX-style F² agreement factors. `sigmaCutoff` (default 2) selects the
 * "observed" reflections for R1 (Fo² > cutoff·σ(Fo²)); wR2 and GooF use all.
 */
export function singleCrystalAgreement(
  foSq: readonly number[],
  fcSq: readonly number[],
  sigma: readonly number[],
  weights: Float64Array,
  nParams: number,
  sigmaCutoff = 2,
): SingleCrystalAgreement {
  let wNum = 0;
  let wDen = 0;
  let r1Num = 0;
  let r1Den = 0;
  let r1AllNum = 0;
  let r1AllDen = 0;
  let observed = 0;
  const n = foSq.length;

  for (let i = 0; i < n; i++) {
    const fo2 = foSq[i]!;
    const fc2 = fcSq[i]!;
    const w = weights[i]!;
    const diff2 = fo2 - fc2;
    wNum += w * diff2 * diff2;
    wDen += w * fo2 * fo2;

    const fo = Math.sqrt(Math.max(fo2, 0));
    const fc = Math.sqrt(Math.max(fc2, 0));
    r1AllNum += Math.abs(fo - fc);
    r1AllDen += fo;
    if (sigmaCutoff <= 0 || fo2 > sigmaCutoff * (sigma[i] ?? 0)) {
      observed++;
      r1Num += Math.abs(fo - fc);
      r1Den += fo;
    }
  }

  const dof = Math.max(n - nParams, 1);
  return {
    r1: r1Den > 0 ? r1Num / r1Den : 0,
    r1All: r1AllDen > 0 ? r1AllNum / r1AllDen : 0,
    wr2: wDen > 0 ? Math.sqrt(wNum / wDen) : 0,
    goof: Math.sqrt(wNum / dof),
    observed,
    total: n,
  };
}
