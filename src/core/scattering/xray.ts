/**
 * X-ray atomic form factors via the four-Gaussian Cromer-Mann approximation:
 *   f(s) = Σ_{i=1..4} a_i · exp(−b_i · s²) + c,   s = sinθ/λ (Å⁻¹).
 *
 * Coefficients from International Tables for Crystallography Vol. C. The Mn, O,
 * and Ga rows match the coefficients GSAS-II prints for the validation data.
 */

import type { ScatteringTable } from "@/core/scattering/types";

export interface CromerMann {
  readonly a: readonly [number, number, number, number];
  readonly b: readonly [number, number, number, number];
  readonly c: number;
}

export const CROMER_MANN: Readonly<Record<string, CromerMann>> = {
  O: { a: [3.0485, 2.2868, 1.5463, 0.867], b: [13.2771, 5.7011, 0.3239, 32.9089], c: 0.2508 },
  Mn: { a: [11.2819, 7.3573, 3.0193, 2.2441], b: [5.3409, 0.3432, 17.8674, 83.7543], c: 1.0896 },
  Fe: { a: [11.7695, 7.3573, 3.5222, 2.3045], b: [4.7611, 0.3072, 15.3535, 76.8805], c: 1.0369 },
  Ga: { a: [15.2354, 6.7006, 4.3591, 2.9623], b: [3.0669, 0.2412, 10.7805, 61.4135], c: 1.7189 },
  Si: { a: [6.2915, 3.0353, 1.9891, 1.541], b: [2.4386, 32.3337, 0.6785, 81.6937], c: 1.1407 },
  Cu: { a: [13.338, 7.1676, 5.6158, 1.6735], b: [3.5828, 0.247, 11.3966, 64.8126], c: 1.191 },
  Al: { a: [6.4202, 1.9002, 1.5936, 1.9646], b: [3.0387, 0.7426, 31.5472, 85.0886], c: 1.1151 },
  C: { a: [2.31, 1.02, 1.5886, 0.865], b: [20.8439, 10.2075, 0.5687, 51.6512], c: 0.2156 },
  N: { a: [12.2126, 3.1322, 2.0125, 1.1663], b: [0.0057, 9.8933, 28.9975, 0.5826], c: -11.529 },
  S: { a: [6.9053, 5.2034, 1.4379, 1.5863], b: [1.4679, 22.2151, 0.2536, 56.172], c: 0.8669 },
  Ti: { a: [9.7595, 7.3558, 1.6991, 1.9021], b: [7.8508, 0.5, 35.6338, 116.105], c: 1.2807 },
  Nb: { a: [17.6142, 12.0144, 4.04183, 3.53346], b: [1.18865, 11.766, 0.204785, 69.7957], c: 3.75591 },
  Se: { a: [17.0006, 5.8196, 3.9731, 4.35436], b: [2.4098, 0.2726, 15.2372, 43.8163], c: 2.84091 },
  Te: { a: [19.9644, 19.0138, 6.14487, 2.5239], b: [4.81742, 0.420885, 28.5284, 70.8403], c: 4.352 },
};

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
