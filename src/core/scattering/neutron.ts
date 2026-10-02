/**
 * Bound coherent neutron scattering lengths b (fm).
 *
 * Values ({@link NEUTRON_B}, {@link NEUTRON_B_ISOTOPES}) come from the generated
 * {@link ./neutronData} table: Sears (1992) *Neutron News* 3(3) 26–37, as entered
 * by NIST — see that file and scripts/gen_neutron_b.py. MATERIA uses that one
 * evaluation for every element, with no per-element overrides. The elements in
 * the GSAS-II validation data print the same values in its .lst output (fm):
 * Mn −3.73, O 5.80, Ga 7.29 (Mn₃Ga/MnO); Sn 6.23, Co 2.49, Fe 9.45 (FeCoSn).
 * See neutronSfValidation.test.ts. This file holds only the lookup logic.
 */

import type { Complex } from "@/core/math/types";
import type { ScatteringTable } from "@/core/scattering/types";
import { NEUTRON_B, NEUTRON_B_ISOTOPES, type BoundCoherentLength } from "@/core/scattering/neutronData";

export { NEUTRON_B, NEUTRON_B_ISOTOPES };
export type { BoundCoherentLength };

/** Mass numbers tabulated for an element, e.g. [238, 239, 240, 242] for Pu. */
export function tabulatedIsotopes(element: string): number[] {
  const out: number[] = [];
  for (const key of Object.keys(NEUTRON_B_ISOTOPES)) {
    const m = /^(\d+)([A-Z][a-z]?)$/.exec(key);
    if (m && m[2] === element) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Bound coherent scattering length b = b′ − i·b″ (fm) exactly as Sears prints it,
 * for the natural element or, when `isotope` (a mass number) is given, for that
 * isotope. `D` is ²H, and H with isotope 2 is the same entry.
 *
 * Throws, naming the element, when nothing is tabulated: an unknown element, an
 * isotope Sears does not list, or an element with no natural-abundance value.
 * Pu and Cm are the latter — their isotopes differ widely (²³⁸Pu 14.1, ²³⁹Pu
 * 7.7, ²⁴⁰Pu 3.5 fm), so the site must name its isotope.
 */
export function boundCoherentLength(element: string, isotope?: number): BoundCoherentLength {
  if (element === "D" && (isotope === undefined || isotope === 2)) return NEUTRON_B.D!;
  if (isotope !== undefined) {
    const b = NEUTRON_B_ISOTOPES[`${isotope}${element}`];
    if (b === undefined) {
      const known = tabulatedIsotopes(element);
      throw new Error(
        `No neutron scattering length for isotope ${isotope}${element}` +
          (known.length > 0 ? ` (Sears 1992 lists ${element} ${known.join(", ")})` : ""),
      );
    }
    return b;
  }
  const b = NEUTRON_B[element];
  if (b === undefined) {
    const known = tabulatedIsotopes(element);
    if (known.length > 0) {
      throw new Error(
        `${element} has no natural-abundance neutron scattering length; set the site's isotope ` +
          `(Sears 1992 lists ${element} ${known.join(", ")})`,
      );
    }
    throw new Error(`No neutron scattering length for element "${element}"`);
  }
  return b;
}

/**
 * Neutron scattering amplitude for the crystallographic structure factor
 * F = Σ a·exp(+2πi h·x): the CONJUGATE of the printed length, a = b′ + i·b″ (fm).
 *
 * Why the conjugate: Sears' b = b′ − i·b″ belongs to the physics convention
 * (time dependence exp(−iωt), scattered amplitude ∝ Σ(−b)·exp(−iQ·r), with
 * Im(−b) > 0 by the optical theorem). The crystallographic F, with its +2πi
 * phase and X-ray f″ > 0, is the complex conjugate of that sum, so its neutron
 * term is conj(b). An absorbing nucleus therefore gets a positive imaginary
 * amplitude — the same sign as X-ray f″.
 */
export function neutronAmplitude(element: string, isotope?: number): Complex {
  const b = boundCoherentLength(element, isotope);
  return { re: b.re, im: b.im === 0 ? 0 : -b.im };
}

export const neutronTable: ScatteringTable = {
  amplitude(element: string, _s: number, isotope?: number): Complex {
    return neutronAmplitude(element, isotope);
  },
  has(element: string): boolean {
    return element in NEUTRON_B;
  },
};
