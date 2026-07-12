/**
 * Setting and origin transforms (roadmap F2.4): re-express a cell, its atoms, and
 * its symmetry operations in a different basis. Needed to bring a non-standard or
 * alternative-setting CIF into a known frame before symmetry analysis, and to
 * convert R space groups between the rhombohedral (primitive) and hexagonal
 * (triply-centred) settings.
 *
 * Convention: a change of basis (P, p) relates old and new fractional coordinates
 * by  x_old = P · x_new + p  (columns of P are the new basis vectors in the old
 * basis; p is the new origin in old coordinates). Then
 *   x_new = P⁻¹ (x_old − p)                                         [positions]
 *   W_new = P⁻¹ W P,  w_new = P⁻¹ ((W − I)·p + w)                   [operations]
 *   G_new = Pᵀ G P                                                  [cell metric]
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation, SpaceGroup, UnitCell } from "@/core/crystal/types";
import { inverse, mulMat, mulVec, transpose } from "@/core/math/mat3";
import { metricTensor } from "@/core/crystal/unitCell";
import { formatOperationXyz } from "@/core/crystal/symmetry";
import { wrapFractional } from "@/core/math/vec3";

const RAD = 180 / Math.PI;

/** Recover cell parameters (a,b,c,α,β,γ) from a metric tensor G. */
export function cellFromMetric(g: Mat3): UnitCell {
  const a = Math.sqrt(g[0]![0]!);
  const b = Math.sqrt(g[1]![1]!);
  const c = Math.sqrt(g[2]![2]!);
  const clamp = (x: number): number => Math.min(1, Math.max(-1, x));
  return {
    a, b, c,
    alpha: Math.acos(clamp(g[1]![2]! / (b * c))) * RAD,
    beta: Math.acos(clamp(g[0]![2]! / (a * c))) * RAD,
    gamma: Math.acos(clamp(g[0]![1]! / (a * b))) * RAD,
  };
}

/** Transform a cell by the change of basis P:  G_new = Pᵀ G P. */
export function transformCell(cell: UnitCell, p: Mat3): UnitCell {
  const g = metricTensor(cell);
  return cellFromMetric(mulMat(transpose(p), mulMat(g, p)));
}

/** Transform a fractional position:  x_new = P⁻¹ (x_old − origin). */
export function transformPosition(position: Vec3, p: Mat3, origin: Vec3 = [0, 0, 0]): Vec3 {
  const pInv = inverse(p);
  return wrapFractional(mulVec(pInv, [position[0] - origin[0], position[1] - origin[1], position[2] - origin[2]]));
}

const roundInt = (x: number): number => Math.round(x);
/** Round a translation component to the nearest 1/24 (covers ¼, ⅓, ⅙, …) mod 1. */
const roundFrac = (x: number): number => ((Math.round(x * 24) / 24) % 1 + 1) % 1;

/**
 * Transform a symmetry operation:  W_new = P⁻¹ W P,  w_new = P⁻¹((W−I)p + w).
 * The rotation part of a valid lattice-preserving transform is integer; it is
 * rounded to clean up floating error (and the translation to the nearest 1/24).
 */
export function transformOperation(op: SymmetryOperation, p: Mat3, origin: Vec3 = [0, 0, 0]): SymmetryOperation {
  const pInv = inverse(p);
  const w = op.rotation;
  const rot = mulMat(pInv, mulMat(w, p)).map((row) => row.map(roundInt)) as unknown as Mat3;
  // (W − I)·origin + w, then P⁻¹.
  const wmi: Vec3 = [
    (w[0]![0]! - 1) * origin[0] + w[0]![1]! * origin[1] + w[0]![2]! * origin[2] + op.translation[0],
    w[1]![0]! * origin[0] + (w[1]![1]! - 1) * origin[1] + w[1]![2]! * origin[2] + op.translation[1],
    w[2]![0]! * origin[0] + w[2]![1]! * origin[1] + (w[2]![2]! - 1) * origin[2] + op.translation[2],
  ];
  const t = mulVec(pInv, wmi).map(roundFrac) as unknown as Vec3;
  return { rotation: rot, translation: t, xyz: formatOperationXyz(rot, t) };
}

/** Transform every operation of a space group. */
export function transformSpaceGroup(sg: SpaceGroup, p: Mat3, origin: Vec3 = [0, 0, 0]): SpaceGroup {
  return { ...sg, operations: sg.operations.map((op) => transformOperation(op, p, origin)) };
}

/**
 * Re-express a whole structure in a new setting. Cell, atom positions, and the
 * space-group operations are transformed. NOTE: anisotropic ADP tensors are
 * carried unchanged — this is intended for setting normalization and symmetry
 * analysis, not for re-refining anisotropic displacements in the new frame.
 */
export function transformStructure(structure: StructureModel, p: Mat3, origin: Vec3 = [0, 0, 0]): StructureModel {
  return {
    ...structure,
    cell: transformCell(structure.cell, p),
    sites: structure.sites.map((s) => ({ ...s, position: transformPosition(s.position, p, origin) })),
    spaceGroup: transformSpaceGroup(structure.spaceGroup, p, origin),
  };
}

/**
 * Change-of-basis P from the RHOMBOHEDRAL (primitive) to the HEXAGONAL (obverse,
 * triply-centred) setting of an R space group, and its inverse. Columns of
 * `RHOMB_TO_HEX` are the hexagonal basis vectors expressed in the rhombohedral
 * basis (ITA Table 5.1.3.1, obverse).
 */
export const RHOMB_TO_HEX: Mat3 = [
  [1, 0, 1],
  [-1, 1, 1],
  [0, -1, 1],
];
export const HEX_TO_RHOMB: Mat3 = inverse(RHOMB_TO_HEX);
