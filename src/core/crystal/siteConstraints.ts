/**
 * Site-symmetry constraints on atomic positions for structure refinement.
 *
 * An atom on a special position cannot move freely: its coordinates are tied by
 * the site symmetry. A fractional displacement δ from the site is allowed only
 * if it is invariant under the site's stabilizer — every operation g = (R | t)
 * that maps the site onto itself (R·X + t ≡ X mod lattice). Since the site is
 * fixed, requiring the *displaced* site to transform consistently reduces to
 * (R − I)·δ = 0. Stacking those rows over the stabilizer gives a linear system
 * whose null space is the space of allowed displacements. Its dimension is the
 * number of free positional parameters for the site (3 for a general position,
 * fewer and possibly coupled — e.g. (x,x,x) — on a special position, 0 for a
 * fully fixed site like the origin).
 *
 * Same null-space method as the magnetic `allowedMomentDirections` and the cell
 * metric-invariance constraints; kept here so the powder structure-refinement
 * builder can emit symmetry-adapted position modes instead of raw x/y/z.
 */

import type { Vec3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { applyOperation } from "@/core/crystal/symmetry";

/** True if op maps `pos` back onto itself modulo the integer lattice. */
function siteIsFixed(op: SymmetryOperation, pos: Vec3, tol = 1e-3): boolean {
  const p = applyOperation(op, pos);
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(p[i]! - pos[i]!);
    d -= Math.floor(d); // wrap into [0,1) — the op may shift by >1 cell (coord > 0.5)
    d = Math.min(d, 1 - d); // nearest periodic image
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

/** Scale a displacement mode so its largest-magnitude component is +1. */
function normalizeMode(v: Vec3): Vec3 {
  let lead = 0;
  for (let i = 0; i < 3; i++) if (Math.abs(v[i]!) > Math.abs(lead)) lead = v[i]!;
  if (Math.abs(lead) < 1e-12) return v;
  return [v[0]! / lead, v[1]! / lead, v[2]! / lead];
}

export interface AllowedPositionShifts {
  /**
   * Basis of allowed fractional-displacement directions. Each vector is scaled
   * so its leading component is +1, so a parameter multiplying it is (to first
   * order) the shift of that leading coordinate.
   */
  readonly basis: Vec3[];
  /** Number of free positional parameters: 0, 1, 2, or 3. */
  readonly dimension: number;
}

/**
 * Allowed positional displacement modes for a site at `position` under the
 * given space-group operations. A general position returns the three Cartesian
 * fractional axes; a special position returns the symmetry-adapted subset
 * (possibly coupled, e.g. (x,x,x) → a single [1,1,1] mode).
 */
export function allowedPositionShifts(
  operations: readonly SymmetryOperation[],
  position: Vec3,
): AllowedPositionShifts {
  const rows: number[][] = [];
  for (const op of operations) {
    if (!siteIsFixed(op, position)) continue;
    const R = op.rotation;
    // Skip the identity: (R − I) = 0 contributes nothing.
    const isIdentity =
      R[0]![0] === 1 && R[1]![1] === 1 && R[2]![2] === 1 &&
      R[0]![1] === 0 && R[0]![2] === 0 && R[1]![0] === 0 &&
      R[1]![2] === 0 && R[2]![0] === 0 && R[2]![1] === 0;
    if (isIdentity) continue;
    for (let i = 0; i < 3; i++) {
      const row = [R[i]![0]!, R[i]![1]!, R[i]![2]!];
      row[i]! -= 1;
      rows.push(row);
    }
  }
  if (rows.length === 0) {
    return { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], dimension: 3 };
  }
  const basis = nullSpace3(rows).map(normalizeMode);
  return { basis, dimension: basis.length };
}
