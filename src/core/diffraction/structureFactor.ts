/**
 * Nuclear structure-factor calculation.
 *
 *   F_N(hkl) = Σ_j occ_j · b_j(s) · T_j · exp[2πi(h·x_j + k·y_j + l·z_j)]
 *
 * where the sum runs over all symmetry-equivalent atoms in the unit cell, b_j
 * is the scattering factor (neutron length or X-ray form factor), and T_j is
 * the isotropic or anisotropic Debye-Waller factor.
 */

import type { Complex, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import type { ScatteringTable } from "@/core/scattering/types";
import { add, expι, modulusSquared, scale, ZERO } from "@/core/math/complex";
import { applyOperation } from "@/core/crystal/symmetry";
import { wrapFractional } from "@/core/math/vec3";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { neutronTable } from "@/core/scattering/neutron";
import { xrayTable } from "@/core/scattering/xray";
import type { UnitCell } from "@/core/crystal/types";

const TWO_PI = 2 * Math.PI;

export function scatteringTableFor(radiation: Radiation): ScatteringTable {
  return radiation.kind === "xray" ? xrayTable : neutronTable;
}

function almostEqualMod1(a: Vec3, b: Vec3, tol = 1e-3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > tol) return false;
  }
  return true;
}

/**
 * The subset of space-group operations that generate a site's DISTINCT orbit
 * (one coset representative per equivalent position) — cached. We cache the
 * *operations*, not the resulting positions, and re-apply them to the current
 * position in the sum. This is deliberate: which ops are distinct is a property
 * of the site symmetry (stable under the symmetry-adapted position modes and the
 * finite-difference perturbations used to build the Jacobian), whereas the
 * positions must move with the parameter — caching positions would silently zero
 * out the coordinate gradient. Keyed by the operation-list identity (stable
 * across a calc/refinement) then a coarse position key.
 */
const cosetCache = new WeakMap<readonly SymmetryOperation[], Map<string, SymmetryOperation[]>>();
function distinctSiteOps(ops: readonly SymmetryOperation[], pos: Vec3): readonly SymmetryOperation[] {
  let byPos = cosetCache.get(ops);
  if (!byPos) {
    byPos = new Map();
    cosetCache.set(ops, byPos);
  }
  const key = `${Math.round(pos[0] * 1e4)},${Math.round(pos[1] * 1e4)},${Math.round(pos[2] * 1e4)}`;
  let reps = byPos.get(key);
  if (!reps) {
    reps = [];
    const seen: Vec3[] = [];
    for (const op of ops) {
      const p = wrapFractional(applyOperation(op, pos));
      if (!seen.some((q) => almostEqualMod1(q, p))) {
        seen.push(p);
        reps.push(op);
      }
    }
    byPos.set(key, reps);
  }
  return reps;
}

/** Isotropic Debye-Waller factor exp(−B_iso · s²), s = sinθ/λ = 1/(2d). */
export function debyeWaller(bIso: number, s: number): number {
  return Math.exp(-bIso * s * s);
}

/**
 * Anisotropic Debye-Waller factor
 *   T = exp(−2π²(U11 h²a*² + U22 k²b*² + U33 l²c*² + 2U12 hk a*b* + 2U13 hl a*c* + 2U23 kl b*c*))
 * with reciprocal lengths a*=√G*11 etc. from the reciprocal metric tensor.
 */
export function anisotropicDebyeWaller(
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

    // Sum over the DISTINCT equivalent positions (the site's orbit), each once.
    // Summing over all space-group operations instead over-counts a special
    // position by its site-symmetry order — and since different sites have
    // different site symmetries (e.g. Nb/Se on 3m vs Ga on -43m in GaNb4Se8),
    // that corrupts the *relative* structure factors, not just an overall scale.
    for (const op of distinctSiteOps(model.spaceGroup.operations, site.position)) {
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
