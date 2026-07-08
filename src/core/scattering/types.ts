/**
 * Scattering-factor interfaces. Deliberately abstract so the simplified tables
 * used first can be replaced with more complete ones without touching the
 * structure-factor calculators.
 *
 * `s = sinθ/λ = 1/(2d)` (Å⁻¹) is the standard scattering variable used by both
 * Cromer-Mann X-ray form factors and the ⟨j0⟩ magnetic approximation.
 */

/** A scattering source: given an element/site, return its factor at a given s. */
export interface ScatteringTable {
  /**
   * Coherent scattering factor.
   *  - Neutron: constant scattering length b (fm), independent of s.
   *  - X-ray: form factor f(s) in electrons.
   */
  factor(element: string, s: number, isotope?: number): number;
  /** True if `element` is present in this table. */
  has(element: string): boolean;
}

/**
 * Magnetic neutron form factor for a magnetic ion.
 *
 * The spin-only approximation uses ⟨j0⟩(s) alone (normalized to 1 at s = 0). The
 * full **dipole approximation** — needed when the moment has an orbital part
 * (Landé g ≠ 2), i.e. most magnetic refinements beyond the simplest cases —
 * adds a ⟨j2⟩ term:  f(s) ≈ ⟨j0⟩(s) + (1 − 2/g)·⟨j2⟩(s).
 * ⟨j2⟩ carries an s² prefactor, so it vanishes at s = 0 and both give f(0) = 1.
 */
export interface MagneticFormFactorTable {
  /** Spin-only form factor ⟨j0⟩(s). */
  j0(ionId: string, s: number): number;
  /** ⟨j2⟩(s) when tabulated for the ion; used by the dipole approximation. */
  j2?(ionId: string, s: number): number;
  /** Dipole form factor ⟨j0⟩ + (1 − 2/g)⟨j2⟩; falls back to ⟨j0⟩ (spin-only)
   *  when ⟨j2⟩ is not tabulated for the ion. */
  dipole?(ionId: string, s: number, g: number): number;
  /** True if the ion has a tabulated ⟨j0⟩. */
  has(ionId: string): boolean;
  /** True if the ion also has a tabulated ⟨j2⟩ (dipole approximation available). */
  hasJ2?(ionId: string): boolean;
}
