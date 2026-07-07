/**
 * Allowed magnetic moment directions on a site under a (magnetic) space group.
 *
 * A moment m (axial vector, crystal-axis components) is allowed only if it is
 * invariant under the site's magnetic stabilizer: for every operation g that
 * fixes the site, θ_g · det(R_g) · R_g · m = m. Stacking these gives a linear
 * system whose null space is the space of allowed moments. Its dimension is the
 * number of free moment parameters — the "proper constraints" for refinement.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { determinant } from "@/core/math/mat3";
import { applyOperation } from "@/core/crystal/symmetry";

function siteIsFixed(op: SymmetryOperation, pos: Vec3, tol = 1e-3): boolean {
  const p = applyOperation(op, pos);
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(p[i]! - pos[i]!);
    d -= Math.floor(d); // wrap into [0,1) — op may shift by >1 cell (coord > 0.5)
    d = Math.min(d, 1 - d);
    if (d > tol) return false;
  }
  return true;
}

/** Real null space of a matrix (rows × 3) with tolerance; returns basis Vec3s. */
function nullSpace3(rows: number[][], tol = 1e-6): Vec3[] {
  const mat = rows.map((r) => [...r]);
  const pivotCols: number[] = [];
  let pr = 0;
  for (let col = 0; col < 3 && pr < mat.length; col++) {
    let sel = -1;
    let best = tol;
    for (let r = pr; r < mat.length; r++) {
      if (Math.abs(mat[r]![col]!) > best) { best = Math.abs(mat[r]![col]!); sel = r; }
    }
    if (sel === -1) continue;
    [mat[pr], mat[sel]] = [mat[sel]!, mat[pr]!];
    const pivot = mat[pr]![col]!;
    for (let c = 0; c < 3; c++) mat[pr]![c]! /= pivot;
    for (let r = 0; r < mat.length; r++) {
      if (r !== pr && Math.abs(mat[r]![col]!) > tol) {
        const f = mat[r]![col]!;
        for (let c = 0; c < 3; c++) mat[r]![c]! -= f * mat[pr]![c]!;
      }
    }
    pivotCols.push(col);
    pr++;
  }
  const freeCols = [0, 1, 2].filter((c) => !pivotCols.includes(c));
  const basis: Vec3[] = [];
  for (const free of freeCols) {
    const v: [number, number, number] = [0, 0, 0];
    v[free] = 1;
    for (let i = 0; i < pivotCols.length; i++) {
      const pc = pivotCols[i]!;
      v[pc] = -mat[i]![free]!;
    }
    basis.push(v);
  }
  return basis;
}

export interface AllowedMoments {
  /** Basis of the allowed-moment subspace (crystal-axis components). */
  readonly basis: Vec3[];
  /** Dimension: 0 (site non-magnetic), 1, 2, or 3. */
  readonly dimension: number;
}

/**
 * Compute the allowed moment directions for a site at `position` under the given
 * magnetic operations. Returns a basis (possibly empty) of the invariant
 * subspace.
 */
export function allowedMomentDirections(
  operations: readonly SymmetryOperation[],
  position: Vec3,
): AllowedMoments {
  const rows: number[][] = [];
  for (const op of operations) {
    if (!siteIsFixed(op, position)) continue;
    const R: Mat3 = op.rotation;
    const factor = determinant(R) * (op.timeReversal ?? 1);
    // Constraint matrix: (factor·R − I).
    for (let i = 0; i < 3; i++) {
      const row = [factor * R[i]![0], factor * R[i]![1], factor * R[i]![2]];
      row[i]! -= 1;
      rows.push(row);
    }
  }
  if (rows.length === 0) {
    // No stabilizer constraints beyond identity: all three components free.
    return { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], dimension: 3 };
  }
  const basis = nullSpace3(rows);
  return { basis, dimension: basis.length };
}
