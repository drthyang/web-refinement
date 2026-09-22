/**
 * Representation (irrep) analysis for a commensurate magnetic structure — the
 * "irrep" route (Jana2020 / BasIreps style), complementing the magnetic-space-
 * group (Shubnikov / coordinate) route in magneticGroups.ts.
 *
 * The magnetic representation Γ_mag on the magnetic atoms is the permutation
 * representation (with the k-phase) ⊗ the axial-vector representation. Its
 * character over the little group G_k of the wavevector k is
 *   χ_mag(g) = χ_axial(R_g) · Σ_{atoms l fixed by g mod lattice} e^{2πi k·L_l(g)},
 * where a magnetic moment is an **axial** vector so χ_axial(R) = det(R)·tr(R),
 * and L_l(g) is the lattice translation carrying atom l back to its own
 * sublattice under g. "Lattice" is the parent's true lattice: in a centred
 * cell the atoms are counted modulo the centring translations (one per
 * primitive cell), an operation fixes an atom when the image differs by any
 * lattice vector, centring part included, and L_l(g) is that vector back to
 * the image of the operation's rotation-class representative
 * (`centringOffsets`) so a centring translation carries its phase e^{2πi k·t}.
 * Decomposing χ_mag into the irreps of G_k with
 * n_i = (1/|G_k|) Σ_g χ_mag(g)·χ_i(g)* gives which irreps carry the order and
 * their multiplicities (the number of basis modes to refine per irrep).
 *
 * This module provides the character and the decomposition formula (both tested).
 * The **irrep character tables of G_k** for arbitrary point groups (and the
 * projective small representations for non-symmorphic groups at BZ-boundary k)
 * are the remaining piece — see docs/MAGNETIC_SYMMETRY.md.
 *
 * References: Bertaut, *Acta Cryst.* A24 (1968) 217; Rodríguez-Carvajal & Bourée,
 * BasIreps (*EPJ Web Conf.* 22, 2012); Bradley & Cracknell (1972).
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { applyOperation, centringOffsets, centringTranslations, equivalentPositions, isLatticeVector, snapLatticeVector } from "@/core/crystal/symmetry";

/**
 * Character of the axial-vector (magnetic moment) representation for a rotation
 * R: χ_axial(R) = det(R)·tr(R). E → +3, 2-fold → −1, mirror → −1, inversion → +3
 * (an axial vector is even under inversion, unlike a polar vector).
 */
export function axialCharacter(R: Mat3): number {
  const det =
    R[0]![0]! * (R[1]![1]! * R[2]![2]! - R[1]![2]! * R[2]![1]!) -
    R[0]![1]! * (R[1]![0]! * R[2]![2]! - R[1]![2]! * R[2]![0]!) +
    R[0]![2]! * (R[1]![0]! * R[2]![1]! - R[1]![1]! * R[2]![0]!);
  const tr = R[0]![0]! + R[1]![1]! + R[2]![2]!;
  return det * tr;
}

/** χ_mag(g) for one little-group operation (complex). */
export interface RepCharacterTerm {
  readonly op: SymmetryOperation;
  readonly re: number;
  readonly im: number;
}

/** Periodic (mod-1) coincidence of two fractional positions. */
function samePosition(a: Vec3, b: Vec3, tol = 1e-3): boolean {
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (Math.min(d, 1 - d) > tol) return false;
  }
  return true;
}

/** Distinct magnetic atoms in one cell: the orbit of the given sites. */
function magneticAtoms(structure: StructureModel, siteLabels: readonly string[]): Vec3[] {
  const atoms: Vec3[] = [];
  const ops = structure.spaceGroup.operations.length
    ? structure.spaceGroup.operations
    : [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Mat3, translation: [0, 0, 0] as Vec3, xyz: "x,y,z" }];
  const centrings = centringTranslations(ops);
  for (const label of siteLabels) {
    const site = structure.sites.find((s) => s.label === label);
    if (!site) continue;
    // Periodic-distance dedup (shared with site-multiplicity), then merge
    // across labels so co-located (disordered) sites count once — and count
    // atoms related by a centring translation once (one per primitive cell).
    for (const p of equivalentPositions(ops, site.position)) {
      if (atoms.some((q) => samePosition(q, p))) continue;
      if (atoms.some((q) => isLatticeVector([p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!], centrings))) continue;
      atoms.push(p);
    }
  }
  return atoms;
}

/**
 * Magnetic representation character χ_mag(g) over the little-group operations
 * `littleGroupOps` (= littleGroup(parentOps, k)) for the magnetic sites.
 */
export function magneticRepresentationCharacter(
  structure: StructureModel,
  k: Vec3,
  siteLabels: readonly string[],
  littleGroupOps: readonly SymmetryOperation[],
): RepCharacterTerm[] {
  const atoms = magneticAtoms(structure, siteLabels);
  const centrings = centringTranslations(littleGroupOps);
  const offsets = centringOffsets(littleGroupOps);
  return littleGroupOps.map((g, gi) => {
    const chi = axialCharacter(g.rotation);
    const c = offsets[gi]!;
    let re = 0;
    let im = 0;
    for (const r of atoms) {
      const image = applyOperation(g, r); // R·r + τ
      const d: Vec3 = [image[0] - r[0], image[1] - r[1], image[2] - r[2]];
      if (isLatticeVector(d, centrings)) {
        // Atom returns to its own sublattice by the lattice vector L (centring
        // part of g removed) → diagonal, with k-phase.
        const Ls = snapLatticeVector(d);
        const phase = 2 * Math.PI * (k[0] * (Ls[0] - c[0]!) + k[1] * (Ls[1] - c[1]!) + k[2] * (Ls[2] - c[2]!));
        re += Math.cos(phase);
        im += Math.sin(phase);
      }
    }
    return { op: g, re: chi * re, im: chi * im };
  });
}

/**
 * Multiplicity of an irrep in a reducible character by the standard formula
 * n = (1/|G|) Σ_g χ(g)·χ_irrep(g)*. `reducible` and `irrep` are parallel arrays
 * (same operation order). The imaginary part cancels for a valid decomposition;
 * the (rounded) real part is returned.
 */
export function irrepMultiplicity(
  reducible: readonly { re: number; im: number }[],
  irrep: readonly { re: number; im: number }[],
): number {
  const g = Math.min(reducible.length, irrep.length);
  if (g === 0) return 0;
  let re = 0;
  for (let i = 0; i < g; i++) {
    // χ(g)·conj(χ_irrep(g)) = (a+bi)(c−di) → real part ac + bd
    re += reducible[i]!.re * irrep[i]!.re + reducible[i]!.im * irrep[i]!.im;
  }
  return re / g;
}

/** χ_mag(E) = 3·(number of magnetic atoms in the cell) — the total rep dimension. */
export function magneticRepresentationDimension(structure: StructureModel, siteLabels: readonly string[]): number {
  return 3 * magneticAtoms(structure, siteLabels).length;
}
