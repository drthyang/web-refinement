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
