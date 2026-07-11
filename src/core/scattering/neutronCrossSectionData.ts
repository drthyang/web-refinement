/**
 * Bound neutron cross-sections σ (barn) per natural element — coherent,
 * incoherent, and thermal absorption.
 *
 * Source: V. F. Sears, *Neutron News* 3, 26 (1992) / *International Tables for
 * Crystallography* Vol. C §4.4.4, as tabulated by NIST ("Neutron scattering
 * lengths and cross sections"). Values are for the **natural-abundance** element
 * (deuterium D is the ²H isotope).
 *
 *  - `coherent`   σ_coh   — bound coherent scattering cross-section (barn).
 *  - `incoherent` σ_incoh — bound incoherent scattering cross-section (barn).
 *  - `absorption` σ_a     — absorption cross-section at v = 2200 m/s
 *                           (λ = 1.798 Å, E = 25.3 meV), the thermal reference.
 *                           Scale to other wavelengths with the 1/v law
 *                           σ_a(λ) = σ_a · (λ / 1.798) — see neutronAbsorption.ts.
 *
 * 1 barn = 10⁻²⁴ cm². The scattering cross-sections are treated as
 * wavelength-independent (bound-atom approximation), which is the convention
 * used for absorption/transmission corrections; only σ_a carries the 1/v
 * wavelength dependence.
 *
 * This is a hand-curated table (canonical NIST/Sears values) covering the
 * common elements and every element in the bundled validation structures. It
 * can be extended to the full periodic table following the generator pattern in
 * scripts/gen_neutron_b.py; the lookup logic lives in neutronAbsorption.ts.
 */

export interface NeutronCrossSections {
  /** Bound coherent scattering cross-section σ_coh (barn). */
  readonly coherent: number;
  /** Bound incoherent scattering cross-section σ_incoh (barn). */
  readonly incoherent: number;
  /** Absorption cross-section at 2200 m/s (λ = 1.798 Å), σ_a (barn); 1/v law. */
  readonly absorption: number;
}

/** Element symbol → bound neutron cross-sections (barn). */
export const NEUTRON_CROSS_SECTIONS: Readonly<Record<string, NeutronCrossSections>> = {
  H: { coherent: 1.7568, incoherent: 80.26, absorption: 0.3326 },
  D: { coherent: 5.592, incoherent: 2.05, absorption: 0.000519 },
  Li: { coherent: 0.454, incoherent: 0.92, absorption: 70.5 },
  Be: { coherent: 7.63, incoherent: 0.0018, absorption: 0.0076 },
  B: { coherent: 3.54, incoherent: 1.7, absorption: 767.0 },
  C: { coherent: 5.55, incoherent: 0.001, absorption: 0.0035 },
  N: { coherent: 11.01, incoherent: 0.5, absorption: 1.9 },
  O: { coherent: 4.232, incoherent: 0.0008, absorption: 0.00019 },
  F: { coherent: 4.017, incoherent: 0.0008, absorption: 0.0096 },
  Na: { coherent: 1.66, incoherent: 1.62, absorption: 0.53 },
  Mg: { coherent: 3.631, incoherent: 0.08, absorption: 0.063 },
  Al: { coherent: 1.495, incoherent: 0.0082, absorption: 0.231 },
  Si: { coherent: 2.163, incoherent: 0.004, absorption: 0.171 },
  P: { coherent: 3.307, incoherent: 0.005, absorption: 0.172 },
  S: { coherent: 1.0186, incoherent: 0.007, absorption: 0.53 },
  Cl: { coherent: 11.5257, incoherent: 5.3, absorption: 33.5 },
  K: { coherent: 1.69, incoherent: 0.27, absorption: 2.1 },
  Ca: { coherent: 2.78, incoherent: 0.05, absorption: 0.43 },
  Sc: { coherent: 19.0, incoherent: 4.5, absorption: 27.5 },
  Ti: { coherent: 1.485, incoherent: 2.87, absorption: 6.09 },
  V: { coherent: 0.0184, incoherent: 5.08, absorption: 5.08 },
  Cr: { coherent: 1.66, incoherent: 1.83, absorption: 3.05 },
  Mn: { coherent: 1.75, incoherent: 0.4, absorption: 13.3 },
  Fe: { coherent: 11.22, incoherent: 0.4, absorption: 2.56 },
  Co: { coherent: 0.779, incoherent: 4.8, absorption: 37.18 },
  Ni: { coherent: 13.3, incoherent: 5.2, absorption: 4.49 },
  Cu: { coherent: 7.485, incoherent: 0.55, absorption: 3.78 },
  Zn: { coherent: 4.054, incoherent: 0.077, absorption: 1.11 },
  Ga: { coherent: 6.675, incoherent: 0.16, absorption: 2.75 },
  Ge: { coherent: 8.42, incoherent: 0.18, absorption: 2.2 },
  As: { coherent: 5.44, incoherent: 0.06, absorption: 4.5 },
  Se: { coherent: 7.98, incoherent: 0.32, absorption: 11.7 },
  Br: { coherent: 5.8, incoherent: 0.1, absorption: 6.9 },
  Rb: { coherent: 6.32, incoherent: 0.5, absorption: 0.38 },
  Sr: { coherent: 6.19, incoherent: 0.06, absorption: 1.28 },
  Y: { coherent: 7.55, incoherent: 0.15, absorption: 1.28 },
  Zr: { coherent: 6.44, incoherent: 0.02, absorption: 0.185 },
  Nb: { coherent: 6.253, incoherent: 0.0024, absorption: 1.15 },
  Mo: { coherent: 5.67, incoherent: 0.04, absorption: 2.48 },
  Ru: { coherent: 6.21, incoherent: 0.4, absorption: 2.56 },
  Rh: { coherent: 4.34, incoherent: 0.3, absorption: 144.8 },
  Pd: { coherent: 4.39, incoherent: 0.093, absorption: 6.9 },
  Ag: { coherent: 4.407, incoherent: 0.58, absorption: 63.3 },
  Cd: { coherent: 3.04, incoherent: 3.46, absorption: 2520.0 },
  In: { coherent: 2.08, incoherent: 0.54, absorption: 193.8 },
  Sn: { coherent: 4.871, incoherent: 0.022, absorption: 0.626 },
  Sb: { coherent: 3.9, incoherent: 0.007, absorption: 4.91 },
  Te: { coherent: 4.23, incoherent: 0.09, absorption: 4.7 },
  I: { coherent: 3.5, incoherent: 0.31, absorption: 6.15 },
  Cs: { coherent: 3.69, incoherent: 0.21, absorption: 29.0 },
  Ba: { coherent: 3.23, incoherent: 0.15, absorption: 1.1 },
  La: { coherent: 8.53, incoherent: 1.13, absorption: 8.97 },
  Ce: { coherent: 2.94, incoherent: 0.001, absorption: 0.63 },
  Pr: { coherent: 2.64, incoherent: 0.015, absorption: 11.5 },
  Nd: { coherent: 7.43, incoherent: 9.2, absorption: 50.5 },
  Sm: { coherent: 0.422, incoherent: 39.0, absorption: 5922.0 },
  Eu: { coherent: 6.57, incoherent: 2.5, absorption: 4530.0 },
  Gd: { coherent: 29.3, incoherent: 151.0, absorption: 49700.0 },
  Tb: { coherent: 6.84, incoherent: 0.004, absorption: 23.4 },
  Dy: { coherent: 35.9, incoherent: 54.4, absorption: 994.0 },
  Ho: { coherent: 8.06, incoherent: 0.36, absorption: 64.7 },
  Er: { coherent: 7.63, incoherent: 1.1, absorption: 159.0 },
  Tm: { coherent: 6.28, incoherent: 0.1, absorption: 100.0 },
  Yb: { coherent: 19.42, incoherent: 4.0, absorption: 34.8 },
  Lu: { coherent: 6.53, incoherent: 0.7, absorption: 74.0 },
  Hf: { coherent: 7.6, incoherent: 2.6, absorption: 104.1 },
  Ta: { coherent: 6.0, incoherent: 0.01, absorption: 20.6 },
  W: { coherent: 2.97, incoherent: 1.63, absorption: 18.3 },
  Re: { coherent: 10.6, incoherent: 0.9, absorption: 89.7 },
  Os: { coherent: 14.4, incoherent: 0.3, absorption: 16.0 },
  Ir: { coherent: 14.1, incoherent: 0.0, absorption: 425.0 },
  Pt: { coherent: 11.58, incoherent: 0.13, absorption: 10.3 },
  Au: { coherent: 7.32, incoherent: 0.43, absorption: 98.65 },
  Hg: { coherent: 20.24, incoherent: 6.6, absorption: 372.3 },
  Tl: { coherent: 9.678, incoherent: 0.21, absorption: 3.43 },
  Pb: { coherent: 11.115, incoherent: 0.003, absorption: 0.171 },
  Bi: { coherent: 9.148, incoherent: 0.0084, absorption: 0.0338 },
  Th: { coherent: 13.36, incoherent: 0.0, absorption: 7.37 },
  U: { coherent: 8.903, incoherent: 0.005, absorption: 7.57 },
};

/**
 * Elements whose absorption has a strong resonance near thermal energies, so
 * the 1/v extrapolation σ_a(λ) = σ_a(2200) · (λ/1.798) is unreliable away from
 * 1.798 Å. For accurate work at other wavelengths these need energy-resolved
 * cross-sections; neutronAbsorption.ts surfaces a warning when one is present.
 */
export const RESONANCE_ABSORBERS: ReadonlySet<string> = new Set([
  "Cd",
  "In",
  "Sm",
  "Eu",
  "Gd",
  "Dy",
  "Er",
  "Hf",
  "Ir",
  "Rh",
]);
