/**
 * Site-symmetry constraints for anisotropic displacement parameters.
 *
 * A symmetric displacement tensor U on a special position must be invariant
 * under every operation in the site's stabilizer: U = R U Rᵀ. Vectorizing the
 * six independent tensor components [U11,U22,U33,U12,U13,U23] gives a linear
 * system whose null space is the set of allowed ADP modes.
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import { applyOperation } from "@/core/crystal/symmetry";
import { solveLinearSystem } from "@/core/math/linalg";
import type { Vec3 } from "@/core/math/types";

export type UAniso = readonly [number, number, number, number, number, number];

const COMPONENTS = [
  [0, 0],
  [1, 1],
  [2, 2],
  [0, 1],
  [0, 2],
  [1, 2],
] as const;

function siteIsFixed(op: SymmetryOperation, pos: Vec3, tol = 1e-3): boolean {
  const p = applyOperation(op, pos);
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(p[i]! - pos[i]!);
    d -= Math.floor(d);
    d = Math.min(d, 1 - d);
    if (d > tol) return false;
  }
  return true;
}

function vecToTensor(u: UAniso): number[][] {
  return [
    [u[0], u[3], u[4]],
    [u[3], u[1], u[5]],
    [u[4], u[5], u[2]],
  ];
}

function tensorToVec(t: readonly (readonly number[])[]): [number, number, number, number, number, number] {
  return [t[0]![0]!, t[1]![1]!, t[2]![2]!, t[0]![1]!, t[0]![2]!, t[1]![2]!];
}

function transformU(op: SymmetryOperation, u: UAniso): [number, number, number, number, number, number] {
  const r = op.rotation;
  const t = vecToTensor(u);
  const out = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) acc += r[i]![a]! * t[a]![b]! * r[j]![b]!;
      }
      out[i]![j] = acc;
    }
  }
  return tensorToVec(out);
}

function nullSpace(rows: number[][], nCols: number, tol = 1e-8): number[][] {
  const mat = rows.map((r) => [...r]);
  const pivotCols: number[] = [];
  let pr = 0;
  for (let col = 0; col < nCols && pr < mat.length; col++) {
    let sel = -1;
    let best = tol;
    for (let r = pr; r < mat.length; r++) {
      const v = Math.abs(mat[r]![col]!);
      if (v > best) { best = v; sel = r; }
    }
    if (sel === -1) continue;
    [mat[pr], mat[sel]] = [mat[sel]!, mat[pr]!];
    const pivot = mat[pr]![col]!;
    for (let c = 0; c < nCols; c++) mat[pr]![c]! /= pivot;
    for (let r = 0; r < mat.length; r++) {
      if (r === pr) continue;
      const f = mat[r]![col]!;
      if (Math.abs(f) <= tol) continue;
      for (let c = 0; c < nCols; c++) mat[r]![c]! -= f * mat[pr]![c]!;
    }
    pivotCols.push(col);
    pr++;
  }

  const freeCols = Array.from({ length: nCols }, (_, i) => i).filter((c) => !pivotCols.includes(c));
  const basis: number[][] = [];
  for (const free of freeCols) {
    const v = new Array<number>(nCols).fill(0);
    v[free] = 1;
    for (let i = 0; i < pivotCols.length; i++) v[pivotCols[i]!] = -mat[i]![free]!;
    basis.push(normalizeMode(v));
  }
  return basis;
}

function normalizeMode(v: readonly number[]): number[] {
  let lead = 0;
  for (const x of v) if (Math.abs(x) > Math.abs(lead)) lead = x;
  if (Math.abs(lead) < 1e-12) return [...v];
  return v.map((x) => x / lead);
}

function modeName(mode: UAniso): string {
  return COMPONENTS
    .map(([a, b], i) => ({ name: `U${a + 1}${b + 1}`, value: mode[i]! }))
    .filter((o) => Math.abs(o.value) > 1e-8)
    .map((o, idx) => {
      const mag = Math.abs(o.value);
      const coeff = Math.abs(mag - 1) < 1e-8 ? "" : Number.isInteger(mag) ? String(mag) : mag.toFixed(2);
      const sign = o.value < 0 ? "-" : idx === 0 ? "" : "+";
      return `${sign}${coeff}${o.name}`;
    })
    .join("");
}

function coefficientsForModes(modes: readonly UAniso[], u: UAniso): number[] {
  const n = modes.length;
  if (n === 0) return [];
  const normal = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const rhs = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 6; c++) rhs[i]! += modes[i]![c]! * u[c]!;
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let c = 0; c < 6; c++) dot += modes[i]![c]! * modes[j]![c]!;
      normal[i]![j] = dot;
      normal[j]![i] = dot;
    }
  }
  try {
    return solveLinearSystem(normal, rhs);
  } catch {
    return modes.map((mode) => {
      let num = 0;
      let den = 0;
      for (let c = 0; c < 6; c++) {
        num += mode[c]! * u[c]!;
        den += mode[c]! * mode[c]!;
      }
      return den > 0 ? num / den : 0;
    });
  }
}

export interface AllowedAnisotropicAdp {
  readonly modes: readonly {
    readonly label: string;
    readonly basis: UAniso;
    readonly coefficient: number;
    readonly diagonal: boolean;
  }[];
  readonly dimension: number;
}

export function allowedAnisotropicAdpModes(
  operations: readonly SymmetryOperation[],
  position: Vec3,
  initial: UAniso,
): AllowedAnisotropicAdp {
  const rows: number[][] = [];
  for (const op of operations) {
    if (!siteIsFixed(op, position)) continue;
    const isIdentity =
      op.rotation[0]![0] === 1 && op.rotation[1]![1] === 1 && op.rotation[2]![2] === 1 &&
      op.rotation[0]![1] === 0 && op.rotation[0]![2] === 0 && op.rotation[1]![0] === 0 &&
      op.rotation[1]![2] === 0 && op.rotation[2]![0] === 0 && op.rotation[2]![1] === 0;
    if (isIdentity) continue;
    const opRows = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    for (let c = 0; c < 6; c++) {
      const unit = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
      unit[c] = 1;
      const transformed = transformU(op, unit);
      for (let j = 0; j < 6; j++) opRows[j]![c] = transformed[j]! - unit[j]!;
    }
    rows.push(...opRows);
  }

  const rawModes = rows.length === 0
    ? [
        [1, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 1],
      ]
    : nullSpace(rows, 6);
  const modes = rawModes.map((m) => [
    m[0] ?? 0,
    m[1] ?? 0,
    m[2] ?? 0,
    m[3] ?? 0,
    m[4] ?? 0,
    m[5] ?? 0,
  ] as UAniso);
  const coeffs = coefficientsForModes(modes, initial);
  return {
    dimension: modes.length,
    modes: modes.map((basis, i) => ({
      label: modeName(basis) || `U mode ${i + 1}`,
      basis,
      coefficient: coeffs[i] ?? 0,
      diagonal: Math.abs(basis[3]) < 1e-8 && Math.abs(basis[4]) < 1e-8 && Math.abs(basis[5]) < 1e-8,
    })),
  };
}
