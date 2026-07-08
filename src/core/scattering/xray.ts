/**
 * X-ray atomic form factors via the four-Gaussian Cromer-Mann approximation:
 *   f(s) = Σ_{i=1..4} a_i · exp(−b_i · s²) + c,   s = sinθ/λ (Å⁻¹).
 *
 * Coefficients ({@link CROMER_MANN}) come from the generated
 * {@link ./cromerMannData} table — the full set of neutral atoms from
 * International Tables Vol. C (see that file and scripts/gen_xray_ff.py). The
 * Mn, O, and Ga rows match the coefficients GSAS-II prints for the validation
 * data. This file holds only the evaluation logic.
 */

import type { ScatteringTable } from "@/core/scattering/types";
import { CROMER_MANN, type CromerMann } from "@/core/scattering/cromerMannData";

export { CROMER_MANN };
export type { CromerMann };

export function xrayFormFactor(element: string, s: number): number {
  const cm = CROMER_MANN[element];
  if (!cm) {
    throw new Error(`No Cromer-Mann coefficients for element "${element}"`);
  }
  const s2 = s * s;
  let f = cm.c;
  for (let i = 0; i < 4; i++) {
    f += cm.a[i]! * Math.exp(-cm.b[i]! * s2);
  }
  return f;
}

export const xrayTable: ScatteringTable = {
  factor(element: string, s: number): number {
    return xrayFormFactor(element, s);
  },
  has(element: string): boolean {
    return element in CROMER_MANN;
  },
};
