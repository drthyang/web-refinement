/**
 * Nuclear structure-factor calculation.
 *
 *   F_N(hkl) = Σ_j occ_j · b_j(s) · T_j · exp[2πi(h·x_j + k·y_j + l·z_j)]
 *
 * where the sum runs over all symmetry-equivalent atoms in the unit cell, b_j
 * is the scattering factor (neutron length or X-ray form factor), and T_j is
 * the isotropic Debye-Waller factor exp(−B_iso · s²) with s = sinθ/λ = 1/(2d).
 */

import type { Complex } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import type { ScatteringTable } from "@/core/scattering/types";
import { add, expι, modulusSquared, scale, ZERO } from "@/core/math/complex";
import { applyOperation } from "@/core/crystal/symmetry";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { neutronTable } from "@/core/scattering/neutron";
import { xrayTable } from "@/core/scattering/xray";
import type { UnitCell } from "@/core/crystal/types";

const TWO_PI = 2 * Math.PI;

export function scatteringTableFor(radiation: Radiation): ScatteringTable {
  return radiation.kind === "xray" ? xrayTable : neutronTable;
}

/** Isotropic Debye-Waller factor exp(−B_iso · s²), s = sinθ/λ = 1/(2d). */
function debyeWaller(bIso: number, s: number): number {
  return Math.exp(-bIso * s * s);
}

/**
 * Anisotropic Debye-Waller factor
 *   T = exp(−2π²(U11 h²a*² + U22 k²b*² + U33 l²c*² + 2U12 hk a*b* + 2U13 hl a*c* + 2U23 kl b*c*))
 * with reciprocal lengths a*=√G*11 etc. from the reciprocal metric tensor.
 */
function anisotropicDebyeWaller(
  cell: UnitCell,
  u: readonly [number, number, number, number, number, number],
  h: number,
  k: number,
  l: number,
): number {
  const g = reciprocalMetricTensor(cell);
  const as = Math.sqrt(g[0][0]);
  const bs = Math.sqrt(g[1][1]);
  const cs = Math.sqrt(g[2][2]);
  const [u11, u22, u33, u12, u13, u23] = u;
  const exponent =
    u11 * h * h * as * as +
    u22 * k * k * bs * bs +
    u33 * l * l * cs * cs +
    2 * u12 * h * k * as * bs +
    2 * u13 * h * l * as * cs +
    2 * u23 * k * l * bs * cs;
  return Math.exp(-2 * Math.PI * Math.PI * exponent);
}

/**
 * Nuclear structure factor for one reflection. Expands the asymmetric unit over
 * all space-group operations (so occupancies/positions are per asymmetric site).
 */
export function nuclearStructureFactor(
  model: StructureModel,
  radiation: Radiation,
  h: number,
  k: number,
  l: number,
  table: ScatteringTable = scatteringTableFor(radiation),
): Complex {
  const d = dSpacing(model.cell, h, k, l);
  const s = d === Infinity ? 0 : 1 / (2 * d);

  let f = ZERO;
  for (const site of model.sites) {
    const b = table.factor(site.element, s, site.isotope);
    const dw =
      site.adp.kind === "isotropic"
        ? debyeWaller(site.adp.bIso, s)
        : anisotropicDebyeWaller(model.cell, site.adp.uAniso, h, k, l);
    const weight = site.occupancy * b * dw;

    for (const op of model.spaceGroup.operations) {
      const p = applyOperation(op, site.position);
      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      f = add(f, scale(expι(phase), weight));
    }
  }
  return f;
}

/** |F_N|². */
export function nuclearStructureFactorSquared(
  model: StructureModel,
  radiation: Radiation,
  h: number,
  k: number,
  l: number,
  table?: ScatteringTable,
): number {
  return modulusSquared(nuclearStructureFactor(model, radiation, h, k, l, table));
}
