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

export function neutronScatteringLength(element: string): number {
  const b = NEUTRON_B[element];
  if (b === undefined) {
    throw new Error(`No neutron scattering length for element "${element}"`);
  }
  return b;
}

export const neutronTable: ScatteringTable = {
  factor(element: string): number {
    return neutronScatteringLength(element);
  },
  has(element: string): boolean {
    return element in NEUTRON_B;
  },
};
