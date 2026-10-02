/**
 * Scattering-factor interfaces. Deliberately abstract so the simplified tables
 * used first can be replaced with more complete ones without touching the
 * structure-factor calculators.
 *
 * `s = sinθ/λ = 1/(2d)` (Å⁻¹) is the standard scattering variable used by both
 * Cromer-Mann X-ray form factors and the ⟨j0⟩ magnetic approximation.
 */

import type { Complex } from "@/core/math/types";

/**
 * A scattering source: given an element/site, return its complex scattering
 * amplitude at a given s.
 *
 * The amplitude is in the CRYSTALLOGRAPHIC convention used by the structure
 * factor, F = Σ a·exp(+2πi h·x) (ITC Vol. B), in which absorption makes the
 * imaginary part positive (X-ray f″ > 0). For neutrons that is the complex
 * conjugate of the bound coherent length as Sears prints it, b = b′ − i·b″
 * (physics convention: Σ b·exp(−iQ·r)), so a = b′ + i·b″. Using b itself
 * would give I(−h) instead of I(h): powder intensities and centrosymmetric
 * structures do not notice, Bijvoet differences of a non-centrosymmetric
 * crystal flip sign.
 */
export interface ScatteringTable {
  /**
   * Coherent scattering amplitude.
   *  - Neutron: conj(b) (fm), independent of s; imaginary for absorbers
   *    (B, Cd, In, Sm, Eu, Gd, Dy, …).
   *  - X-ray: form factor f0(s) in electrons (real; no anomalous terms yet).
   */
  amplitude(element: string, s: number, isotope?: number): Complex;
  /** True if `element` is present in this table. */
  has(element: string): boolean;
}

/**
 * Magnetic neutron form factor for a magnetic ion.
 *
 * The spin-only approximation uses ⟨j0⟩(s) alone (normalized to 1 at s = 0). The
 * full **dipole approximation** — needed when the moment has an orbital part
 * (Landé g ≠ 2), i.e. most magnetic refinements beyond the simplest cases —
 * adds a ⟨j2⟩ term:  f(s) ≈ ⟨j0⟩(s) + (2/g − 1)·⟨j2⟩(s).
 * ⟨j2⟩ carries an s² prefactor, so it vanishes at s = 0 and both give f(0) = 1.
 */
export interface MagneticFormFactorTable {
  /** Spin-only form factor ⟨j0⟩(s). */
  j0(ionId: string, s: number): number;
  /** ⟨j2⟩(s) when tabulated for the ion; used by the dipole approximation. */
  j2?(ionId: string, s: number): number;
  /** Dipole form factor ⟨j0⟩ + (2/g − 1)⟨j2⟩; falls back to ⟨j0⟩ (spin-only)
   *  when ⟨j2⟩ is not tabulated for the ion. */
  dipole?(ionId: string, s: number, g: number): number;
  /** True if the ion has a tabulated ⟨j0⟩. */
  has(ionId: string): boolean;
  /** True if the ion also has a tabulated ⟨j2⟩ (dipole approximation available). */
  hasJ2?(ionId: string): boolean;
}
