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
import type { StructureModel, SymmetryOperation, DisplacementParameters } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import type { ScatteringTable } from "@/core/scattering/types";
import { add, expι, modulusSquared, scale, ZERO } from "@/core/math/complex";
import { applyOperation } from "@/core/crystal/symmetry";
import { adpForOperation, rotateUAniso } from "@/core/crystal/adp";
import { wrapFractional } from "@/core/math/vec3";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { neutronTable } from "@/core/scattering/neutron";
import { xrayTable } from "@/core/scattering/xray";
import type { UnitCell } from "@/core/crystal/types";

/** The 6-component CIF anisotropic tensor [U11,U22,U33,U12,U13,U23]. */
type UAniso6 = readonly [number, number, number, number, number, number];

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
    // Isotropic Debye–Waller is rotation-invariant and hoists out of the orbit
    // loop; an anisotropic tensor is NOT — each image sees U′ = R·U·Rᵀ, so its
    // factor is evaluated per operation below.
    const isoDw = site.adp.kind === "isotropic" ? debyeWaller(site.adp.bIso, s) : null;

    // Sum over the DISTINCT equivalent positions (the site's orbit), each once.
    // Summing over all space-group operations instead over-counts a special
    // position by its site-symmetry order — and since different sites have
    // different site symmetries (e.g. Nb/Se on 3m vs Ga on -43m in GaNb4Se8),
    // that corrupts the *relative* structure factors, not just an overall scale.
    for (const op of distinctSiteOps(model.spaceGroup.operations, site.position)) {
      const dw = isoDw ?? anisotropicDebyeWaller(model.cell, rotateUAniso((site.adp as { uAniso: UAniso6 }).uAniso, op.rotation), h, k, l);
      const p = applyOperation(op, site.position);
      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      f = add(f, scale(expι(phase), site.occupancy * b * dw));
    }
  }
  return f;
}

/**
 * One symmetry-equivalent atom of the unit cell: a site replicated to each
 * DISTINCT position of its orbit, carrying the site's scattering properties.
 * This is exactly the (site, distinct-op) expansion `nuclearStructureFactor`
 * sums over — factored out so an off-core consumer (the WebGPU structure-factor
 * kernel) marshals the identical atom list rather than re-deriving the orbit.
 */
export interface ExpandedAtom {
  readonly position: Vec3;
  readonly occupancy: number;
  readonly element: string;
  readonly isotope?: number;
  readonly adp: DisplacementParameters;
}

/** Where an expanded atom came from: which asymmetric-unit site, through which
 *  operation. A parameter bound to a SITE moves every orbit atom, but each
 *  image's derivative transforms by its operation's rotation (positions:
 *  d pos/dv = R·axis; ADPs: dU = R·uBasis·Rᵀ) — the analytic PDF gradient pass
 *  (pdf/gradients.ts) needs this to route site derivatives to pair atoms. */
export interface ExpandedAtomProvenance {
  /** Index of the originating site in `model.sites`. */
  readonly siteIndex: number;
  /** Fractional rotation R of the generating operation (translation drops out
   *  of every derivative). */
  readonly rotation: SymmetryOperation["rotation"];
}

/** Expand a structure's asymmetric unit over each site's distinct orbit. Each
 *  image carries the site's ADP AS SEEN BY ITS OPERATION — an anisotropic
 *  tensor rotates with the orbit (U′ = R·U·Rᵀ), so real-space displacement
 *  projections and per-atom Debye–Waller factors are correct off the
 *  asymmetric unit. The provenance array is index-aligned with the atoms. */
export function expandStructureAtomsWithProvenance(
  model: StructureModel,
): { atoms: ExpandedAtom[]; provenance: ExpandedAtomProvenance[] } {
  const atoms: ExpandedAtom[] = [];
  const provenance: ExpandedAtomProvenance[] = [];
  for (let s = 0; s < model.sites.length; s++) {
    const site = model.sites[s]!;
    for (const op of distinctSiteOps(model.spaceGroup.operations, site.position)) {
      atoms.push({
        position: applyOperation(op, site.position),
        occupancy: site.occupancy,
        element: site.element,
        ...(site.isotope !== undefined ? { isotope: site.isotope } : {}),
        adp: adpForOperation(site.adp, op.rotation),
      });
      provenance.push({ siteIndex: s, rotation: op.rotation });
    }
  }
  return { atoms, provenance };
}

/** The plain orbit expansion — delegates to the provenance variant so the two
 *  can never disagree on atom ordering. */
export function expandStructureAtoms(model: StructureModel): ExpandedAtom[] {
  return expandStructureAtomsWithProvenance(model).atoms;
}

/**
 * The nuclear structure factor together with its PER-SITE decomposition —
 * the shared ingredient of the analytic occupancy and B_iso derivatives
 * (roadmap F1.1):  F = Σ_j occ_j·b_j·DW_j·(Σ_ops e^{iφ}), so
 *   ∂F/∂occ_j = unitSite_j            (occupancy excluded from unitSite)
 *   ∂F/∂B_j   = −s²·occ_j·unitSite_j  (isotropic sites only)
 * and ∂|F|²/∂p = 2·Re(conj(F)·∂F/∂p). Costs the same as one F evaluation.
 */
export function nuclearStructureFactorPartials(
  model: StructureModel,
  radiation: Radiation,
  h: number,
  k: number,
  l: number,
  table: ScatteringTable = scatteringTableFor(radiation),
): {
  f: Complex;
  s: number;
  perSite: { label: string; unitSite: Complex; occupancy: number; isotropic: boolean }[];
} {
  const d = dSpacing(model.cell, h, k, l);
  const s = d === Infinity ? 0 : 1 / (2 * d);
  let f = ZERO;
  const perSite: { label: string; unitSite: Complex; occupancy: number; isotropic: boolean }[] = [];
  for (const site of model.sites) {
    const b = table.factor(site.element, s, site.isotope);
    // Per-image Debye–Waller: isotropic hoists; anisotropic rotates with each
    // orbit operation (U′ = R·U·Rᵀ), so it multiplies inside the phase sum.
    const isoDw = site.adp.kind === "isotropic" ? debyeWaller(site.adp.bIso, s) : null;
    let sum = ZERO;
    for (const op of distinctSiteOps(model.spaceGroup.operations, site.position)) {
      const p = applyOperation(op, site.position);
      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      // Isotropic factors out of the sum (bit-identical to the hoisted form);
      // anisotropic multiplies inside, per image.
      sum = isoDw !== null
        ? add(sum, expι(phase))
        : add(sum, scale(expι(phase), anisotropicDebyeWaller(model.cell, rotateUAniso((site.adp as { uAniso: UAniso6 }).uAniso, op.rotation), h, k, l)));
    }
    const unitSite = scale(sum, b * (isoDw ?? 1));
    perSite.push({ label: site.label, unitSite, occupancy: site.occupancy, isotropic: site.adp.kind === "isotropic" });
    f = add(f, scale(unitSite, site.occupancy));
  }
  return { f, s, perSite };
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
