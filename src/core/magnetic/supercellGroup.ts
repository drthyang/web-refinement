/**
 * The magnetic space group of an explicit magnetic supercell.
 *
 * A commensurate k ≠ 0 model is written to mCIF in its magnetic supercell —
 * the smallest cell in which the moment field is periodic. Listing every atom
 * of that cell in P1 loses the symmetry the refinement used and leaves the
 * reader with no asymmetric unit. This module recovers the Shubnikov group of
 * the expanded structure directly from the structure itself: every candidate
 * operation — a parent space-group operation re-expressed in the supercell
 * basis, combined with each lattice translation of the parent that lies inside
 * the supercell, with and without time reversal — is kept when it maps every
 * atom onto an atom of the same kind carrying the transformed moment. The
 * moment transform is the viewer's own θ·det(R)·R·m (`displayMoment`), so an
 * mCIF written from the result re-expands to exactly the arrangement on screen.
 *
 * Parent translations that flip every moment become ANTI-translations
 * (time-reversed centering translations: a black-and-white lattice, BNS type
 * IV); translations that change the moments in any other way (a k = ⅓
 * sinusoid, say) are simply not symmetry operations of the supercell and are
 * left out, so the group is always exactly the symmetry the atoms have.
 *
 * The result is split the way magCIF wants it: coset representatives modulo
 * the centering translations, the centering translations themselves (identity
 * first, anti-translations marked −1), and the orbit representatives — the
 * supercell's asymmetric unit — with their multiplicities.
 */

import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { determinant, inverse, mulMat, IDENTITY3 } from "@/core/math/mat3";
import { applyOperation, formatOperationXyz, operationKey } from "@/core/crystal/symmetry";
import type { MagneticSupercellExpansion, SupercellAtom } from "@/core/crystal/cellExpansion";

export interface MagneticCellGroup {
  /** Every operation of the group modulo the supercell's own lattice translations, θ-signed; identity first. */
  readonly operations: SymmetryOperation[];
  /** Coset representatives modulo the centering translations (the mCIF operation loop). */
  readonly representatives: SymmetryOperation[];
  /** Centering translations of the magnetic cell, identity first: pure (+1) and anti (−1). */
  readonly centerings: SymmetryOperation[];
  /** Orbit representatives: the supercell's asymmetric unit, in input order. */
  readonly asymmetricUnit: SupercellAtom[];
  /** Orbit size of each asymmetric-unit atom within the supercell. */
  readonly multiplicities: number[];
  /** True when a pure translation carries time reversal (black-and-white lattice, BNS type IV). */
  readonly hasAntiTranslations: boolean;
}

const POSITION_TOL = 1e-3;
const MOMENT_TOL = 2e-3;

function wrap01(v: number): number {
  const w = ((v % 1) + 1) % 1;
  return w > 1 - 1e-9 ? 0 : w;
}

function wrapVec(v: Vec3): Vec3 {
  return [wrap01(v[0]!), wrap01(v[1]!), wrap01(v[2]!)];
}

function coincide(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > POSITION_TOL) return false;
  }
  return true;
}

/** The viewer's axial moment transform: θ · det(R) · R · m (crystal-axis components). */
function transformMoment(R: Mat3, theta: number, m: Vec3): Vec3 {
  const w = theta * determinant(R);
  return [
    w * (R[0]![0]! * m[0]! + R[0]![1]! * m[1]! + R[0]![2]! * m[2]!),
    w * (R[1]![0]! * m[0]! + R[1]![1]! * m[1]! + R[1]![2]! * m[2]!),
    w * (R[2]![0]! * m[0]! + R[2]![1]! * m[1]! + R[2]![2]! * m[2]!),
  ];
}

/** Two expanded atoms are "the same kind" when they descend from the same parent site. */
function sameKind(a: SupercellAtom, b: SupercellAtom): boolean {
  if (a.parentLabel !== undefined && b.parentLabel !== undefined) return a.parentLabel === b.parentLabel;
  return a.site.element === b.site.element && Math.abs(a.site.occupancy - b.site.occupancy) < 1e-6;
}

const ZERO: Vec3 = [0, 0, 0];

function isIdentityRotation(R: Mat3): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (R[i]![j] !== (i === j ? 1 : 0)) return false;
  return true;
}

function sameRotation(a: Mat3, b: Mat3): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (a[i]![j] !== b[i]![j]) return false;
  return true;
}

export function magneticCellGroup(structure: StructureModel, sup: MagneticSupercellExpansion): MagneticCellGroup {
  const n = sup.n;
  const S: Mat3 = [[n[0], 0, 0], [0, n[1], 0], [0, 0, n[2]]];
  const Sinv = inverse(S);
  const atoms = sup.atoms;
  const parentOps: readonly SymmetryOperation[] = structure.spaceGroup.operations.length > 0
    ? structure.spaceGroup.operations
    : [{ rotation: IDENTITY3, translation: ZERO, xyz: "x,y,z" }];

  const findImage = (p: Vec3, like: SupercellAtom): number => {
    for (let i = 0; i < atoms.length; i++) {
      const b = atoms[i]!;
      if (sameKind(b, like) && coincide(b.site.position, p)) return i;
    }
    return -1;
  };

  /** Does the operation map every atom onto an atom of its kind with the transformed moment? */
  const leavesInvariant = (op: SymmetryOperation): boolean => {
    const theta = op.timeReversal ?? 1;
    for (const a of atoms) {
      const j = findImage(wrapVec(applyOperation(op, a.site.position)), a);
      if (j < 0) return false;
      const want = transformMoment(op.rotation, theta, a.moment ?? ZERO);
      const have = atoms[j]!.moment ?? ZERO;
      for (let i = 0; i < 3; i++) if (Math.abs(want[i]! - have[i]!) > MOMENT_TOL) return false;
    }
    return true;
  };

  const accepted: SymmetryOperation[] = [];
  const seen = new Set<string>();
  for (const op of parentOps) {
    // Re-express the rotation in the supercell basis; an operation that does
    // not preserve the supercell lattice cannot be a symmetry of it.
    const Rp = mulMat(Sinv, mulMat(op.rotation, S));
    if (!Rp.every((row) => row.every((v) => Math.abs(v - Math.round(v)) < 1e-9))) continue;
    const R = Rp.map((row) => row.map((v) => Math.round(v))) as unknown as Mat3;
    const t0: Vec3 = [op.translation[0]! / n[0], op.translation[1]! / n[1], op.translation[2]! / n[2]];
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let l = 0; l < n[2]; l++) {
      const t = wrapVec([t0[0]! + i / n[0], t0[1]! + j / n[1], t0[2]! + l / n[2]]);
      for (const theta of [1, -1] as const) {
        const cand: SymmetryOperation = { rotation: R, translation: t, xyz: formatOperationXyz(R, t), timeReversal: theta };
        const key = `${operationKey(cand)}|${theta}`;
        if (seen.has(key)) continue;
        if (!leavesInvariant(cand)) continue;
        seen.add(key);
        accepted.push(cand);
      }
    }
  }

  // Identity first, then pure operations before anti-operations, stable otherwise.
  const rank = (o: SymmetryOperation): number =>
    (isIdentityRotation(o.rotation) && o.translation.every((v) => Math.abs(v) < 1e-9) && (o.timeReversal ?? 1) === 1 ? 0 : 1) * 2 +
    ((o.timeReversal ?? 1) === 1 ? 0 : 1);
  const operations = accepted
    .map((o, i) => ({ o, i }))
    .sort((p, q) => rank(p.o) - rank(q.o) || p.i - q.i)
    .map((x) => x.o);

  const centerings = operations.filter((o) => isIdentityRotation(o.rotation));
  const representatives: SymmetryOperation[] = [];
  for (const g of operations) {
    const covered = representatives.some((h) =>
      sameRotation(h.rotation, g.rotation) &&
      centerings.some((c) =>
        (h.timeReversal ?? 1) * (c.timeReversal ?? 1) === (g.timeReversal ?? 1) &&
        coincide(wrapVec([h.translation[0]! + c.translation[0]!, h.translation[1]! + c.translation[1]!, h.translation[2]! + c.translation[2]!]), g.translation),
      ),
    );
    if (!covered) representatives.push(g);
  }

  const covered = new Set<number>();
  const asymmetricUnit: SupercellAtom[] = [];
  const multiplicities: number[] = [];
  atoms.forEach((a, idx) => {
    if (covered.has(idx)) return;
    const orbit = new Set<number>();
    for (const op of operations) {
      const j = findImage(wrapVec(applyOperation(op, a.site.position)), a);
      if (j >= 0) orbit.add(j);
    }
    orbit.add(idx);
    for (const j of orbit) covered.add(j);
    asymmetricUnit.push(a);
    multiplicities.push(orbit.size);
  });

  return {
    operations,
    representatives,
    centerings,
    asymmetricUnit,
    multiplicities,
    hasAntiTranslations: centerings.some((c) => (c.timeReversal ?? 1) === -1),
  };
}
