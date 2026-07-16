/**
 * Commensurate magnetic-supercell reflection transform + nuclear/magnetic merge.
 *
 * FullProf single-crystal magnetic refinement convention (validated against the
 * Eu₃In₂Te₄ HB-3A dataset, k = (¼,0,¼)):
 *
 *  - `<name>_nuc.int` holds the nuclear Bragg reflections, indexed in the ATOMIC
 *    (nuclear) unit cell.
 *  - `<name>_mag.int` holds the magnetic satellites, ALSO indexed in the nuclear
 *    cell as the fundamental (h k l) whose true position is (h k l) + k.
 *  - Both are converted into the magnetic **supercell** — the smallest cell in
 *    which k becomes an integer reciprocal-lattice vector — and merged into one
 *    `.int`, which is then refined against the magnetic structure in that cell.
 *
 * For an axis-diagonal commensurate k = (p₁/n₁, p₂/n₂, p₃/n₃) the supercell is
 * (n₁·a, n₂·b, n₃·c) and the reciprocal transform is componentwise:
 *
 *    nuclear   (h,k,l) → (n₁·h,       n₂·k,       n₃·l)
 *    magnetic  (h,k,l) → (n₁·h + K₁,  n₂·k + K₂,  n₃·l + K₃),   Kᵢ = nᵢ·kᵢ  (integer)
 *
 * so the nuclear reflections land on supercell nodes that are multiples of nᵢ and
 * the satellites sit at the integer propagation vector K = (K₁,K₂,K₃) away.
 * Non-axis-diagonal k (a k with a general off-diagonal supercell) is out of scope
 * here — it would need a full 3×3 supercell matrix; such a k throws.
 */

import type { SingleCrystalDataset, SingleCrystalReflection } from "@/core/diffraction/types";
import type { AtomSite, StructureModel } from "@/core/crystal/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import { parseSymmetryOperation, equivalentPositions } from "@/core/crystal/symmetry";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import type { Vec3 } from "@/core/math/types";

/** The supercell multiplicity + integer propagation vector for a commensurate k. */
export interface MagneticSupercell {
  /** Cell multiplication factors (nᵢ) — the supercell is (n₁a, n₂b, n₃c). */
  readonly multiplicity: readonly [number, number, number];
  /** k expressed in the supercell: integer reciprocal-lattice vector Kᵢ = nᵢ·kᵢ. */
  readonly kInteger: readonly [number, number, number];
}

/** Smallest denominator d ∈ [1, maxDenominator] with d·x within tol of an integer. */
function denominatorOf(x: number, maxDenominator: number, tol: number): number {
  if (Math.abs(x - Math.round(x)) < tol) return 1; // already integer (incl. 0)
  for (let d = 2; d <= maxDenominator; d++) {
    if (Math.abs(d * x - Math.round(d * x)) < tol) return d;
  }
  return 0; // not commensurate within the search
}

/**
 * Resolve the magnetic supercell of a commensurate, axis-diagonal propagation
 * vector. Throws when a component is not commensurate within `maxDenominator`.
 */
export function magneticSupercell(k: Vec3, maxDenominator = 12, tol = 1e-4): MagneticSupercell {
  const mult: number[] = [];
  const kInt: number[] = [];
  for (let i = 0; i < 3; i++) {
    const n = denominatorOf(k[i]!, maxDenominator, tol);
    if (n === 0) {
      throw new Error(`magneticSupercell: k component ${k[i]} is not commensurate with a denominator ≤ ${maxDenominator}`);
    }
    mult.push(n);
    kInt.push(Math.round(n * k[i]!));
  }
  return { multiplicity: mult as [number, number, number], kInteger: kInt as [number, number, number] };
}

/** Transform one nuclear-cell reflection into the supercell (optionally + K). */
function toSupercell(r: SingleCrystalReflection, cell: MagneticSupercell, satellite: boolean): SingleCrystalReflection {
  const [n1, n2, n3] = cell.multiplicity;
  const [k1, k2, k3] = satellite ? cell.kInteger : [0, 0, 0];
  return {
    ...r,
    h: n1 * r.h + k1,
    k: n2 * r.k + k2,
    l: n3 * r.l + k3,
  };
}

/**
 * Merge a nuclear + magnetic reflection pair (both indexed in the nuclear cell)
 * into a single dataset in the magnetic supercell: nuclear reflections mapped to
 * their supercell nodes, magnetic satellites mapped to `nuclear-node + K`. The
 * nuclear block precedes the magnetic block. The result is a plain single-crystal
 * `.int`-style dataset ready for a magnetic structure refinement in the supercell.
 */
export function mergeToMagneticSupercell(
  nuclear: SingleCrystalDataset,
  magnetic: SingleCrystalDataset,
  k: Vec3,
  id = `${nuclear.id}-magcell`,
  name = `${nuclear.name} (magnetic supercell)`,
): { dataset: SingleCrystalDataset; supercell: MagneticSupercell } {
  const supercell = magneticSupercell(k);
  const reflections: SingleCrystalReflection[] = [
    ...nuclear.reflections.map((r) => toSupercell(r, supercell, false)),
    ...magnetic.reflections.map((r) => toSupercell(r, supercell, true)),
  ];
  return { dataset: { id, name, radiation: nuclear.radiation, reflections }, supercell };
}

/** One atom of the expanded supercell, traceable to its origin. */
export interface SupercellReplica {
  /** The replica's unique label in the supercell structure. */
  readonly label: string;
  /** The base-cell asymmetric-unit site this replica descends from. */
  readonly parent: string;
  /** Integer base-cell offset L = (l₁,l₂,l₃) of the replica's cell. */
  readonly offset: readonly [number, number, number];
}

export interface SupercellExpansion {
  readonly structure: StructureModel;
  readonly supercell: MagneticSupercell;
  readonly replicas: readonly SupercellReplica[];
}

/**
 * Expand a nuclear structure into the magnetic supercell of a commensurate k —
 * an EXACT geometric regrouping with no physical change: the cell is multiplied
 * by (n₁,n₂,n₃), every site's full crystallographic orbit is made explicit, and
 * each orbit atom is replicated once per base-cell offset L at position
 * ((r+L)ᵢ/nᵢ). The supercell is expressed in P1 (all atoms explicit) so the
 * structure-factor sum is literally the base-cell sum regrouped:
 * F_super(n₁h, n₂k, n₃l) = N·F_base(h,k,l) with N = n₁n₂n₃, and F_super vanishes
 * identically at satellite-only nodes (no nuclear superstructure). Positions,
 * occupancies, and ADPs are copied verbatim — the "magnetic ions exactly where
 * the nuclear structure has them" requirement of the two-phase practice, where
 * the nuclear scaffold stays frozen during the magnetic refinement.
 *
 * SCALE: with |F_super|² = N²·|F_base|², a refinement against the merged
 * supercell dataset converges to scale k_super = k_base/N². The SAME factor N
 * multiplies the magnetic structure factor (the supercell moment sum is the
 * base-cell k-Fourier sum regrouped), so the single shared nuclear+magnetic
 * scale survives the setting change unchanged in form.
 */
export function expandStructureToSupercell(structure: StructureModel, k: Vec3): SupercellExpansion {
  const supercell = magneticSupercell(k);
  const [n1, n2, n3] = supercell.multiplicity;
  const sites: AtomSite[] = [];
  const replicas: SupercellReplica[] = [];
  for (const site of structure.sites) {
    const orbit = equivalentPositions(structure.spaceGroup.operations, site.position);
    orbit.forEach((pos, oi) => {
      for (let l1 = 0; l1 < n1; l1++) for (let l2 = 0; l2 < n2; l2++) for (let l3 = 0; l3 < n3; l3++) {
        const label = `${site.label}_${oi + 1}_${l1}${l2}${l3}`;
        sites.push({
          ...site,
          label,
          position: [(pos[0]! + l1) / n1, (pos[1]! + l2) / n2, (pos[2]! + l3) / n3],
          multiplicity: 1,
        });
        replicas.push({ label, parent: site.label, offset: [l1, l2, l3] });
      }
    });
  }
  return {
    structure: {
      ...structure,
      id: `${structure.id}-super`,
      name: `${structure.name || structure.id} (magnetic supercell ${n1}×${n2}×${n3})`,
      cell: { ...structure.cell, a: structure.cell.a * n1, b: structure.cell.b * n2, c: structure.cell.c * n3 },
      spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
      sites,
    },
    supercell,
    replicas,
  };
}

/** One modulated magnetic sublattice: a base-cell site, its moment direction, and phase. */
export interface ModulatedIon {
  /** Base-cell (parent) site label carrying the moment, e.g. "Eu1". */
  readonly site: string;
  /** Moment direction in BASE-cell crystal-axis components (any length). */
  readonly direction: Vec3;
  /** Modulation phase φ (radians) in m(L) = m₀·d̂·cos(2πk·L + φ). Default 0.
   *  For k = ¼: φ = 0 gives the node pattern (+,0,−,0); φ = π/4 the equal-moment
   *  (+,+,−,−) pattern. */
  readonly phase?: number;
}

export interface ModulatedMomentBuild {
  readonly magnetic: MagneticModel;
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
}

/**
 * Build the k-modulated moment model on an expanded supercell: ONE refinable
 * amplitude per sublattice drives every replica of its parent site through a
 * per-replica `momentBasis` = d̂ · cos(2πk·L + φ) — the careful treatment of the
 * two-phase practice, where replica moments are tied by the k-modulation rather
 * than refined independently (the parameter count stays that of the base-cell
 * description). Directions are given in base-cell crystal components; they are
 * converted to a unit-µB Cartesian direction and re-expressed in the supercell
 * basis, so the amplitude parameter reads directly in µ_B.
 *
 * The model carries no symmetry operations (the supercell is P1 with every
 * moment explicit), so the magnetic structure factor sums the replicas as-is.
 * All amplitude parameters start FIXED (free them to refine), mirroring
 * buildMagneticModel's convention.
 */
export function buildModulatedMomentModel(
  expansion: SupercellExpansion,
  k: Vec3,
  ions: readonly ModulatedIon[],
  moment0 = 1,
): ModulatedMomentBuild {
  const { structure, replicas } = expansion;
  const moments: MagneticMoment[] = [];
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const magId = `${structure.id}-mag`;

  for (const ion of ions) {
    const mine = replicas.filter((r) => r.parent === ion.site);
    if (mine.length === 0) throw new Error(`buildModulatedMomentModel: no replicas of site "${ion.site}" in the supercell`);
    // Unit-µB direction. Moment crystal components are along the NORMALIZED axes
    // (â, b̂, ĉ — moment.ts convention), which are identical for the base cell
    // and its axis-diagonal supercell, so the components carry over unchanged;
    // only the Cartesian normalisation to 1 µ_B is applied.
    const cart = crystalComponentsToCartesian(structure.cell, ion.direction);
    const mag = Math.hypot(...cart);
    if (!(mag > 0)) throw new Error(`buildModulatedMomentModel: zero direction for site "${ion.site}"`);
    const dSuper: Vec3 = [ion.direction[0]! / mag, ion.direction[1]! / mag, ion.direction[2]! / mag];
    const phase = ion.phase ?? 0;

    const id = `modAmp_${ion.site}`;
    params.push({ id, label: `${ion.site} amplitude (µB)`, kind: "momentMode", value: moment0, initialValue: moment0, min: -12, max: 12, fixed: true });
    for (const r of mine) {
      const [l1, l2, l3] = r.offset;
      const c = Math.cos(2 * Math.PI * (k[0]! * l1 + k[1]! * l2 + k[2]! * l3) + phase);
      moments.push({ siteLabel: r.label, frame: "crystallographic", components: [0, 0, 0] });
      bindings.push({
        parameterId: id,
        kind: "momentMode",
        targetId: magId,
        targetKey: r.label,
        momentBasis: [dSuper[0]! * c, dSuper[1]! * c, dSuper[2]! * c],
      });
    }
  }

  return {
    magnetic: { id: magId, structureId: structure.id, propagation: [[0, 0, 0]], moments },
    params,
    bindings,
  };
}
