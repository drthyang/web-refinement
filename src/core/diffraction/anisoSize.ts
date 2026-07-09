/**
 * Anisotropic (uniaxial / spheroidal) crystallite-size broadening — the common
 * platelet and needle morphologies, where the coherently-diffracting domain is
 * larger along one crystallographic axis than perpendicular to it.
 *
 * Model. A spheroid of revolution about a unique reciprocal-lattice axis **t**
 * has, for a reflection whose scattering vector makes angle ψ with **t**, a
 * Lorentzian size coefficient that interpolates between the polar and equatorial
 * values:
 *
 *   X(hkl) = X_⊥ + (X_∥ − X_⊥)·cos²ψ ,      Γ_size(2θ) = X(hkl) / (100·cosθ)
 *
 * cosψ is computed with the reciprocal metric (so it is correct for any cell):
 *   cosψ = (h·G*·t) / (√(h·G*·h)·√(t·G*·t)),   G* the reciprocal metric tensor.
 * X_∥ (broadening ‖ the axis, i.e. reflections along t) corresponds to the
 * dimension *perpendicular* to the platelet face; X_⊥ to the in-plane dimension.
 * Setting X_∥ = X_⊥ recovers the isotropic Scherrer term, so this is a strict,
 * continuous generalisation of the isotropic size model. The two coefficients
 * convert to two crystallite dimensions through the same Scherrer relation as
 * `extractSizeStrain` (D = 18000·K·λ/(π·X)).
 *
 * The cos²ψ spheroidal interpolation is the standard first-order uniaxial size
 * model (as in GSAS-II's "uniaxial" size and FullProf's platelet/needle size);
 * a full ellipsoidal or spherical-harmonic shape is the higher-order extension.
 *
 * References:
 *  - J. I. Langford & D. Louër, Rep. Prog. Phys. 59 (1996) 131 — size broadening
 *    and crystallite shape.
 *  - P. Scherrer (1918); Scherrer constant per direction.
 *  - J. Rodríguez-Carvajal, FullProf manual — uniaxial (platelet/needle) size
 *    broadening; B. H. Toby & R. B. Von Dreele, J. Appl. Cryst. 46 (2013) 544
 *    (GSAS-II) — uniaxial size model.
 */

import type { UnitCell } from "@/core/crystal/types";
import { reciprocalMetricTensor, dSpacing, braggTheta } from "@/core/crystal/unitCell";
import type { Mat3, Vec3 } from "@/core/math/types";

/** Uniaxial size broadening state (Lorentzian coefficients, centidegrees). */
export interface UniaxialSize {
  /** Perpendicular (equatorial) Lorentzian size coefficient X_⊥. */
  readonly xPerp: number;
  /** Parallel (polar) Lorentzian size coefficient X_∥. */
  readonly xPar: number;
  /** Unique axis as reciprocal-lattice indices (e.g. [0,0,1] for a c-axis needle). */
  readonly axis: Vec3;
}

/** g*-metric inner product of two reciprocal-lattice vectors. */
function gStar(gStarTensor: Mat3, a: Vec3, b: Vec3): number {
  let s = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += a[i]! * gStarTensor[i]![j]! * b[j]!;
  return s;
}

/** cos²ψ between reflection (hkl) and the unique axis, via the reciprocal metric. */
export function cos2Psi(cell: UnitCell, h: number, k: number, l: number, axis: Vec3): number {
  const g = reciprocalMetricTensor(cell);
  const refl: Vec3 = [h, k, l];
  const num = gStar(g, refl, axis);
  const denom = gStar(g, refl, refl) * gStar(g, axis, axis);
  if (denom <= 0) return 0;
  const c = (num * num) / denom; // cos²ψ = (h·G*·t)²/((h·G*·h)(t·G*·t))
  return Math.min(Math.max(c, 0), 1);
}

/**
 * Anisotropic Lorentzian size FWHM (degrees 2θ) for one reflection. The
 * direction-dependent coefficient X(hkl) = X_⊥ + (X_∥−X_⊥)·cos²ψ replaces the
 * isotropic X; the 1/cosθ angular shape is unchanged. Use this in place of the
 * isotropic Lorentzian size term when a uniaxial model is active.
 */
export function uniaxialSizeFwhmDeg(
  h: number,
  k: number,
  l: number,
  cell: UnitCell,
  wavelength: number,
  size: UniaxialSize,
): number {
  const d = dSpacing(cell, h, k, l);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const theta = braggTheta(d, wavelength);
  if (Number.isNaN(theta)) return 0;
  const c2 = cos2Psi(cell, h, k, l, size.axis);
  const x = size.xPerp + (size.xPar - size.xPerp) * c2;
  if (x <= 0) return 0;
  return x / (100 * Math.cos(theta)); // centidegrees → degrees, 1/cosθ shape
}

/** Two crystallite dimensions (nm) from the uniaxial coefficients. */
export function uniaxialSizeDimensions(
  size: UniaxialSize,
  wavelength: number,
  scherrerK = 0.9,
): { perpendicularNm: number; parallelNm: number } {
  const D = (x: number): number => (x > 1e-9 ? (18000 * scherrerK * wavelength) / (Math.PI * x) / 10 : Infinity);
  // X_∥ broadens reflections *along* the axis, whose size dimension is ‖ the axis.
  return { perpendicularNm: D(size.xPerp), parallelNm: D(size.xPar) };
}
