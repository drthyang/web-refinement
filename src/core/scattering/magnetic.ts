/**
 * Magnetic form factor in the dipole ⟨j0⟩ approximation:
 *   f_mag(s) ≈ ⟨j0⟩(s) = A·e^{−a·s²} + B·e^{−b·s²} + C·e^{−c·s²} + D,
 * with s = sinθ/λ (Å⁻¹). Normalized to 1 at s = 0.
 *
 * Coefficients from the standard analytical ⟨j0⟩ tables (e.g. the
 * International Tables / Brown magnetic form-factor compilation).
 */

import type { MagneticFormFactorTable } from "@/core/scattering/types";

interface J0Coeffs {
  readonly A: number;
  readonly a: number;
  readonly B: number;
  readonly b: number;
  readonly C: number;
  readonly c: number;
  readonly D: number;
}

export const J0_COEFFS: Readonly<Record<string, J0Coeffs>> = {
  "Mn2": { A: 0.422, a: 17.684, B: 0.5948, b: 6.005, C: 0.0043, c: -0.609, D: -0.0219 },
  "Mn3": { A: 0.4198, a: 14.283, B: 0.6054, b: 5.4689, C: 0.9241, c: -0.0088, D: -0.9498 },
  "Mn4": { A: 0.376, a: 12.566, B: 0.6602, b: 5.1329, C: 0.0175, c: -0.6138, D: -0.0538 },
  "Fe2": { A: 0.0263, a: 34.9597, B: 0.3668, b: 15.9435, C: 0.6188, c: 5.5935, D: -0.0119 },
  "Fe3": { A: 0.3972, a: 13.2442, B: 0.6295, b: 4.9034, C: -0.0314, c: 0.3496, D: 0.0044 },
  "Cr3": { A: 0.3583, a: 15.6543, B: 0.6855, b: 5.6779, C: -0.0454, c: 0.5296, D: 0.0016 },
  "Co2": { A: 0.4332, a: 14.3553, B: 0.5857, b: 4.6077, C: -0.0382, c: 0.1338, D: 0.0179 },
  "Ni2": { A: 0.0163, a: 35.8823, B: 0.3916, b: 13.2233, C: 0.6052, c: 4.3388, D: -0.0133 },
};

export function magneticFormFactorJ0(ionId: string, s: number): number {
  const k = J0_COEFFS[ionId];
  if (!k) {
    throw new Error(`No magnetic form factor for ion "${ionId}"`);
  }
  const s2 = s * s;
  return (
    k.A * Math.exp(-k.a * s2) +
    k.B * Math.exp(-k.b * s2) +
    k.C * Math.exp(-k.c * s2) +
    k.D
  );
}

/**
 * ⟨j2⟩ analytic coefficients for the dipole approximation:
 *   ⟨j2⟩(s) = (A·e^{−a·s²} + B·e^{−b·s²} + C·e^{−c·s²} + D)·s²,   s = sinθ/λ.
 * The s² prefactor makes ⟨j2⟩(0) = 0, so the dipole form factor is still 1 at
 * s = 0. Populate from International Tables Vol. C (same source/ions as ⟨j0⟩) —
 * this is what unlocks the g ≠ 2 (orbital) magnetic refinements (roadmap M4).
 * Ions absent here fall back to the spin-only ⟨j0⟩ in {@link magneticFormFactorDipole}.
 */
export const J2_COEFFS: Readonly<Record<string, J0Coeffs>> = {
  // e.g. "Mn2": { A: …, a: …, B: …, b: …, C: …, c: …, D: … },
};

/** ⟨j2⟩(s), or NaN when the ion has no tabulated ⟨j2⟩ coefficients. */
export function magneticFormFactorJ2(ionId: string, s: number): number {
  const k = J2_COEFFS[ionId];
  if (!k) return NaN;
  const s2 = s * s;
  return (k.A * Math.exp(-k.a * s2) + k.B * Math.exp(-k.b * s2) + k.C * Math.exp(-k.c * s2) + k.D) * s2;
}

/**
 * Dipole-approximation magnetic form factor f(s) = ⟨j0⟩ + (1 − 2/g)·⟨j2⟩ for a
 * moment with Landé factor g. Reduces to the spin-only ⟨j0⟩ when g = 2 or when
 * the ion has no tabulated ⟨j2⟩ — so it is always safe to call and improves
 * automatically as {@link J2_COEFFS} is populated.
 */
export function magneticFormFactorDipole(ionId: string, s: number, g: number): number {
  const j0 = magneticFormFactorJ0(ionId, s);
  const j2 = magneticFormFactorJ2(ionId, s);
  return Number.isNaN(j2) ? j0 : j0 + (1 - 2 / g) * j2;
}

export const magneticTable: MagneticFormFactorTable = {
  j0(ionId: string, s: number): number {
    return magneticFormFactorJ0(ionId, s);
  },
  j2(ionId: string, s: number): number {
    return magneticFormFactorJ2(ionId, s);
  },
  dipole(ionId: string, s: number, g: number): number {
    return magneticFormFactorDipole(ionId, s, g);
  },
  has(ionId: string): boolean {
    return ionId in J0_COEFFS;
  },
  hasJ2(ionId: string): boolean {
    return ionId in J2_COEFFS;
  },
};
