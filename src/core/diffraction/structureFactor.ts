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
import { dSpacing } from "@/core/crystal/unitCell";
import { neutronTable } from "@/core/scattering/neutron";
import { xrayTable } from "@/core/scattering/xray";

const TWO_PI = 2 * Math.PI;

export function scatteringTableFor(radiation: Radiation): ScatteringTable {
  return radiation.kind === "xray" ? xrayTable : neutronTable;
}

/** Debye-Waller factor exp(−B_iso · s²), s = sinθ/λ = 1/(2d). */
function debyeWaller(bIso: number, s: number): number {
  return Math.exp(-bIso * s * s);
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
    const bIso = site.adp.kind === "isotropic" ? site.adp.bIso : 0;
    const dw = debyeWaller(bIso, s);
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
