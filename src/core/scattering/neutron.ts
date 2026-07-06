/**
 * Bound coherent neutron scattering lengths b (fm).
 *
 * Values from standard neutron data tables (Sears, 1992). The three elements
 * present in the GSAS-II validation data (Mn, O, Ga) match the values GSAS-II
 * prints in its .lst output (in units of 10⁻¹² cm = fm): Mn −3.73, O 5.80,
 * Ga 7.29.
 */

import type { ScatteringTable } from "@/core/scattering/types";

/** Element symbol → bound coherent scattering length (fm). */
export const NEUTRON_B: Readonly<Record<string, number>> = {
  H: -3.739,
  D: 6.671,
  Li: -1.9,
  C: 6.646,
  N: 9.36,
  O: 5.803,
  F: 5.654,
  Na: 3.63,
  Mg: 5.375,
  Al: 3.449,
  Si: 4.1491,
  P: 5.13,
  S: 2.847,
  Cl: 9.577,
  K: 3.67,
  Ca: 4.7,
  Ti: -3.438,
  V: -0.3824,
  Cr: 3.635,
  Mn: -3.73,
  Fe: 9.45,
  Co: 2.49,
  Ni: 10.3,
  Cu: 7.718,
  Zn: 5.68,
  Ga: 7.288,
  Ge: 8.185,
  As: 6.58,
  Se: 7.97,
  Sr: 7.02,
  Y: 7.75,
  Zr: 7.16,
  Nb: 7.054,
  Mo: 6.715,
  Ba: 5.07,
  La: 8.24,
  Ce: 4.84,
  Nd: 7.69,
  Sm: 0.8,
  Eu: 7.22,
  Tb: 7.38,
  Dy: 16.9,
  Ho: 8.01,
  Er: 7.79,
  Tm: 7.07,
  Yb: 12.43,
  W: 4.86,
  Pt: 9.6,
  Au: 7.9,
  Pb: 9.405,
  Bi: 8.532,
};

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
