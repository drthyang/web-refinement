/**
 * Bound coherent neutron scattering lengths b (fm).
 *
 * Values ({@link NEUTRON_B}) come from the generated {@link ./neutronData}
 * table (Sears, ITC Vol. C §4.4.4, full periodic table; Ti/Mn/Zn/Au pinned to
 * GSAS-II's Sears 1992 values — see that file and scripts/gen_neutron_b.py).
 * The elements in the GSAS-II validation data match the values GSAS-II prints
 * in its .lst output (fm): Mn −3.73, O 5.80, Ga 7.29 (Mn₃Ga/MnO); Sn 6.23,
 * Co 2.49, Fe 9.45 (FeCoSn). See neutronSfValidation.test.ts. This file holds
 * only the lookup logic.
 */

import type { ScatteringTable } from "@/core/scattering/types";
import { NEUTRON_B } from "@/core/scattering/neutronData";

export { NEUTRON_B };

/**
 * Bound coherent scattering length (fm), optionally for a specific isotope.
 * Only **deuterium** (H with mass number 2 → the tabulated `D`) is
 * isotope-resolved today — it is the dominant isotope case in neutron work
 * (H/D contrast), and natural H and D differ in sign and magnitude (−3.739 vs
 * +6.671 fm), so ignoring it would badly corrupt |F|². Any other `isotope`
 * falls back to the natural-abundance value (the table is keyed by element;
 * per-isotope lengths are a future addition).
 */
export function neutronScatteringLength(element: string, isotope?: number): number {
  const key = element === "H" && isotope === 2 ? "D" : element;
  const b = NEUTRON_B[key];
  if (b === undefined) {
    throw new Error(`No neutron scattering length for element "${element}"`);
  }
  return b;
}

export const neutronTable: ScatteringTable = {
  factor(element: string, _s: number, isotope?: number): number {
    return neutronScatteringLength(element, isotope);
  },
  has(element: string): boolean {
    return element in NEUTRON_B;
  },
};
