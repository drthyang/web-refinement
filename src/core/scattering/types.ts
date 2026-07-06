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

/** Magnetic form factor ⟨j0⟩(s), normalized to 1 at s = 0. */
export interface MagneticFormFactorTable {
  j0(ionId: string, s: number): number;
  has(ionId: string): boolean;
}
