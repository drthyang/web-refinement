/**
 * Symmetry constraints on the unit cell for refinement.
 *
 * Lattice parameters are not independent: the space-group symmetry fixes which
 * of a,b,c,α,β,γ are free and which are tied. Refinement parameters must be
 * symmetry-reduced — refining c on a cubic cell is unphysical.
 *
 * The constraints are derived **from the CIF's symmetry operations**, not from a
 * space-group-number lookup: the metric tensor G must be invariant under every
 * symmetry rotation R (RᵀGR = G, because the operation preserves distances). The
 * null space of that condition over the six independent components of G gives
 * exactly the independent lattice parameters and how the rest are tied. An
 * IT-number / cell-metric classification is used only as a fallback when a
 * structure carries no rotations (e.g. a bare fixture).
 */

import type { StructureModel, UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { Mat3 } from "@/core/math/types";
import { mulMat, transpose } from "@/core/math/mat3";

export type CrystalSystem =
  | "triclinic" | "monoclinic" | "orthorhombic" | "tetragonal"
  | "trigonal" | "rhombohedral" | "hexagonal" | "cubic";

/** One independent cell parameter and the cell fields it constrains. */
export interface CellParamSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: "cellLength" | "cellAngle";
  readonly value: number;
  /** Cell fields driven by this parameter, e.g. ["a","b","c"] for cubic a. */
  readonly targets: readonly (keyof UnitCell)[];
}

// ── Metric-tensor invariance ────────────────────────────────────────────────
// G is symmetric; represent it by the 6-vector [G00,G11,G22,G01,G02,G12].
// Index → cell meaning: 0,1,2 = a²,b²,c²; 3 = ab·cosγ (γ); 4 = ac·cosβ (β);
// 5 = bc·cosα (α).

function symToVec(m: Mat3): number[] {
  return [m[0][0], m[1][1], m[2][2], m[0][1], m[0][2], m[1][2]];
}

// (row, col) pairs (symmetric) for each of the 6 basis matrices.
const SYM_CELLS: readonly [number, number][] = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]];

/** The k-th basis symmetric matrix (k in 0..5). */
function basisSym(k: number): Mat3 {
  const [i, j] = SYM_CELLS[k]!;
  const at = (r: number, c: number): number => ((r === i && c === j) || (r === j && c === i) ? 1 : 0);
  return [
    [at(0, 0), at(0, 1), at(0, 2)],
    [at(1, 0), at(1, 1), at(1, 2)],
    [at(2, 0), at(2, 1), at(2, 2)],
  ];
}

function isIdentity(r: Mat3): boolean {
  return r[0][0] === 1 && r[1][1] === 1 && r[2][2] === 1 &&
    r[0][1] === 0 && r[0][2] === 0 && r[1][0] === 0 &&
    r[1][2] === 0 && r[2][0] === 0 && r[2][1] === 0;
}

function uniqueRotations(sg: SpaceGroup): Mat3[] {
  const seen = new Map<string, Mat3>();
  for (const op of sg.operations) {
    const key = op.rotation.map((row) => row.map((v) => Math.round(v)).join(",")).join(";");
    if (!seen.has(key)) seen.set(key, op.rotation);
  }
  return [...seen.values()];
}

/** Real null space of `rows` (m × n) — basis vectors (each length n). */
function realNullSpace(rows: number[][], n: number, tol = 1e-9): number[][] {
  const mat = rows.map((r) => [...r]);
  const pivotCols: number[] = [];
  let pr = 0;
  for (let col = 0; col < n && pr < mat.length; col++) {
    let sel = -1, best = tol;
    for (let r = pr; r < mat.length; r++) {
      if (Math.abs(mat[r]![col]!) > best) { best = Math.abs(mat[r]![col]!); sel = r; }
    }
    if (sel === -1) continue;
    [mat[pr], mat[sel]] = [mat[sel]!, mat[pr]!];
    const piv = mat[pr]![col]!;
    for (let c = 0; c < n; c++) mat[pr]![c]! /= piv;
    for (let r = 0; r < mat.length; r++) {
      if (r !== pr && Math.abs(mat[r]![col]!) > tol) {
        const f = mat[r]![col]!;
        for (let c = 0; c < n; c++) mat[r]![c]! -= f * mat[pr]![c]!;
      }
    }
    pivotCols.push(col);
    pr++;
  }
  const free = [...Array(n).keys()].filter((c) => !pivotCols.includes(c));
  return free.map((f) => {
    const v = new Array<number>(n).fill(0);
    v[f] = 1;
    pivotCols.forEach((pc, i) => { v[pc] = -mat[i]![f]!; });
    return v;
  });
}

/** Basis of metric tensors invariant under all the given rotations. */
function metricInvariantBasis(rotations: readonly Mat3[]): number[][] {
  const rows: number[][] = [];
  for (const R of rotations) {
    if (isIdentity(R)) continue;
    const Rt = transpose(R);
    // Column k of T = symToVec(Rᵀ·E_k·R); constraint (T − I)·g = 0.
    const T: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const col = symToVec(mulMat(Rt, mulMat(basisSym(k), R)));
      for (let i = 0; i < 6; i++) T[i]![k] = col[i]!;
    }
    for (let i = 0; i < 6; i++) {
      const row = [...T[i]!];
      row[i]! -= 1;
      rows.push(row);
    }
  }
  const basis = realNullSpace(rows, 6);
  // Normalize each basis vector by its largest-magnitude component for stable
  // relation tests below.
  return basis.map((v) => {
    const m = Math.max(...v.map((x) => Math.abs(x)), 1e-30);
    return v.map((x) => x / m);
  });
}

// ── Spec extraction ─────────────────────────────────────────────────────────

const AX: (keyof UnitCell)[] = ["a", "b", "c"];
const LEN_LABEL = ["a (Å)", "b (Å)", "c (Å)"];

function specFromMetricBasis(basis: number[][], cell: UnitCell, tol = 1e-6): CellParamSpec[] {
  const isZero = (i: number) => basis.every((v) => Math.abs(v[i]!) < tol);
  const equal = (i: number, j: number) => basis.every((v) => Math.abs(v[i]! - v[j]!) < tol);
  const prop = (i: number, j: number, f: number) => basis.every((v) => Math.abs(v[i]! - f * v[j]!) < tol);

  // Length classes via union-find on {a,b,c} = metric indices {0,1,2}.
  const parent = [0, 1, 2];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const union = (x: number, y: number) => { parent[find(x)] = find(y); };
  if (equal(0, 1)) union(0, 1);
  if (equal(1, 2)) union(1, 2);
  if (equal(0, 2)) union(0, 2);

  const specs: CellParamSpec[] = [];
  for (let rep = 0; rep < 3; rep++) {
    const members = [0, 1, 2].filter((i) => find(i) === find(rep));
    if (members[0] !== rep) continue; // emit once per class, at its lowest index
    const name = AX[rep]!;
    specs.push({ id: `cell_${name}`, label: LEN_LABEL[rep]!, kind: "cellLength", value: cell[name], targets: members.map((i) => AX[i]!) });
  }

  // Angles. Metric off-diagonals: idx3→γ, idx4→β, idx5→α. Fixed at 90 when the
  // component is 0; at 120 when it is −½ of the matching a·b diagonal (hexagonal
  // γ). Rhombohedral ties α=β=γ when the three off-diagonals move together.
  const rhombo = !isZero(3) && equal(3, 4) && equal(4, 5);
  if (rhombo) {
    specs.push({ id: "cell_alpha", label: "α (°)", kind: "cellAngle", value: cell.alpha, targets: ["alpha", "beta", "gamma"] });
    return specs;
  }
  const gammaFixed = isZero(3) || prop(3, 0, -0.5) || prop(3, 1, -0.5);
  const betaFixed = isZero(4) || prop(4, 0, -0.5) || prop(4, 2, -0.5);
  const alphaFixed = isZero(5) || prop(5, 1, -0.5) || prop(5, 2, -0.5);
  if (!alphaFixed) specs.push({ id: "cell_alpha", label: "α (°)", kind: "cellAngle", value: cell.alpha, targets: ["alpha"] });
  if (!betaFixed) specs.push({ id: "cell_beta", label: "β (°)", kind: "cellAngle", value: cell.beta, targets: ["beta"] });
  if (!gammaFixed) specs.push({ id: "cell_gamma", label: "γ (°)", kind: "cellAngle", value: cell.gamma, targets: ["gamma"] });
  return specs;
}

// ── IT-number / metric fallback (no rotations available) ────────────────────

const near = (x: number, y: number, tol = 1e-2): boolean => Math.abs(x - y) <= tol;
const eqLen = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-3 * Math.max(x, y, 1);

/** Crystal system from the IT number (authoritative), else the cell metric. */
export function crystalSystem(spaceGroup: SpaceGroup, cell: UnitCell): CrystalSystem {
  const n = spaceGroup.number;
  if (n !== undefined) {
    if (n >= 195) return "cubic";
    if (n >= 168) return "hexagonal";
    if (n >= 143) {
      return eqLen(cell.a, cell.b) && eqLen(cell.b, cell.c) && near(cell.alpha, cell.beta) && near(cell.beta, cell.gamma) && !near(cell.alpha, 90)
        ? "rhombohedral" : "trigonal";
    }
    if (n >= 75) return "tetragonal";
    if (n >= 16) return "orthorhombic";
    if (n >= 3) return "monoclinic";
    return "triclinic";
  }
  return crystalSystemFromMetric(cell);
}

function crystalSystemFromMetric(c: UnitCell): CrystalSystem {
  const ortho = near(c.alpha, 90) && near(c.beta, 90) && near(c.gamma, 90);
  if (eqLen(c.a, c.b) && eqLen(c.b, c.c)) {
    if (ortho) return "cubic";
    if (near(c.alpha, c.beta) && near(c.beta, c.gamma)) return "rhombohedral";
  }
  if (eqLen(c.a, c.b) && near(c.alpha, 90) && near(c.beta, 90) && near(c.gamma, 120)) return "hexagonal";
  if (eqLen(c.a, c.b) && ortho) return "tetragonal";
  if (ortho) return "orthorhombic";
  if (near(c.alpha, 90) && near(c.gamma, 90)) return "monoclinic";
  if (near(c.alpha, 90) && near(c.beta, 90)) return "monoclinic";
  return "triclinic";
}

function canonicalSpec(system: CrystalSystem, c: UnitCell): CellParamSpec[] {
  const len = (id: string, label: string, value: number, targets: (keyof UnitCell)[]): CellParamSpec => ({ id, label, kind: "cellLength", value, targets });
  const ang = (id: string, label: string, value: number, targets: (keyof UnitCell)[]): CellParamSpec => ({ id, label, kind: "cellAngle", value, targets });
  switch (system) {
    case "cubic": return [len("cell_a", "a (Å)", c.a, ["a", "b", "c"])];
    case "rhombohedral": return [len("cell_a", "a (Å)", c.a, ["a", "b", "c"]), ang("cell_alpha", "α (°)", c.alpha, ["alpha", "beta", "gamma"])];
    case "hexagonal":
    case "trigonal":
    case "tetragonal": return [len("cell_a", "a (Å)", c.a, ["a", "b"]), len("cell_c", "c (Å)", c.c, ["c"])];
    case "orthorhombic": return [len("cell_a", "a (Å)", c.a, ["a"]), len("cell_b", "b (Å)", c.b, ["b"]), len("cell_c", "c (Å)", c.c, ["c"])];
    case "monoclinic": {
      const base = [len("cell_a", "a (Å)", c.a, ["a"]), len("cell_b", "b (Å)", c.b, ["b"]), len("cell_c", "c (Å)", c.c, ["c"])];
      if (!near(c.gamma, 90)) return [...base, ang("cell_gamma", "γ (°)", c.gamma, ["gamma"])];
      if (!near(c.alpha, 90)) return [...base, ang("cell_alpha", "α (°)", c.alpha, ["alpha"])];
      return [...base, ang("cell_beta", "β (°)", c.beta, ["beta"])];
    }
    default: return [
      len("cell_a", "a (Å)", c.a, ["a"]), len("cell_b", "b (Å)", c.b, ["b"]), len("cell_c", "c (Å)", c.c, ["c"]),
      ang("cell_alpha", "α (°)", c.alpha, ["alpha"]), ang("cell_beta", "β (°)", c.beta, ["beta"]), ang("cell_gamma", "γ (°)", c.gamma, ["gamma"]),
    ];
  }
}

/**
 * Independent, symmetry-reduced cell parameters. Derived from the space-group
 * rotations when present (metric-tensor invariance); otherwise from the IT
 * number / cell metric.
 */
export function independentCellParameters(structure: StructureModel): CellParamSpec[] {
  const rotations = uniqueRotations(structure.spaceGroup);
  if (rotations.some((r) => !isIdentity(r))) {
    return specFromMetricBasis(metricInvariantBasis(rotations), structure.cell);
  }
  return canonicalSpec(crystalSystem(structure.spaceGroup, structure.cell), structure.cell);
}
