/**
 * Generation of candidate magnetic space groups from a parent (nuclear) space
 * group, for a **commensurate k = 0** structure (which covers the Mn₃Ga data).
 *
 * Theory (k = 0): a magnetic space group is defined by a homomorphism
 * θ: G → {+1, −1} assigning a time-reversal sign to each operation (θ = +1 on
 * lattice translations). θ ≡ +1 gives the type-I ("colourless") group; every
 * non-trivial θ has an index-2 kernel and gives a type-III group. So the
 * candidates are the parent group plus one per index-2 subgroup.
 *
 * Homomorphisms are found by solving, over GF(2), the linear system
 *   x_{g∘h} = x_g ⊕ x_h   (with x_identity = 0),
 * where θ_g = (−1)^{x_g}. The null space enumerates every valid θ.
 *
 * This is the honest, well-defined core of "get allowed magnetic space groups":
 * it yields the correct *set* of maximal magnetic subgroups for k = 0. It does
 * not attach standard BNS labels (that needs a lookup table / Bilbao); candidates
 * are labelled by which operations are primed.
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import { composeOperations, operationKey } from "@/core/crystal/symmetry";

export interface MagneticCandidate {
  readonly id: string;
  /** Descriptive label, e.g. "type III · primed: 2₁, m". */
  readonly label: string;
  /** True for the type-I (no time-reversal) group. */
  readonly isTypeI: boolean;
  /** Number of unprimed (θ = +1) operations. */
  readonly unprimedCount: number;
  readonly operations: readonly SymmetryOperation[];
}

/** Deduplicate operations modulo lattice translation, identity first. */
function distinctCosets(ops: readonly SymmetryOperation[]): SymmetryOperation[] {
  const seen = new Map<string, SymmetryOperation>();
  for (const op of ops) {
    const key = op.rotation.map((r) => r.map((v) => Math.round(v)).join(",")).join(";");
    if (!seen.has(key)) seen.set(key, { ...op, timeReversal: 1 });
  }
  const result = [...seen.values()];
  // Identity (rotation = I, translation = 0) first.
  result.sort((a, b) => (isIdentity(b) ? 1 : 0) - (isIdentity(a) ? 1 : 0));
  return result;
}

function isIdentity(op: SymmetryOperation): boolean {
  const r = op.rotation;
  return (
    r[0][0] === 1 && r[1][1] === 1 && r[2][2] === 1 &&
    r[0][1] === 0 && r[0][2] === 0 && r[1][0] === 0 &&
    r[1][2] === 0 && r[2][0] === 0 && r[2][1] === 0
  );
}

/** Point-group key (rotation only) for composition-table indexing. */
function rotationKey(op: SymmetryOperation): string {
  return op.rotation.map((r) => r.map((v) => Math.round(v)).join(",")).join(";");
}

/**
 * Solve A·x = 0 over GF(2). `rows` are the constraints as boolean arrays of
 * length n. Returns a basis of the null space (each a boolean array of length n).
 */
function nullSpaceGF2(rows: boolean[][], n: number): boolean[][] {
  const mat = rows.map((r) => [...r]);
  const pivotCol: number[] = [];
  let pivotRow = 0;
  const colOfPivot: Record<number, number> = {};

  for (let col = 0; col < n && pivotRow < mat.length; col++) {
    let sel = -1;
    for (let r = pivotRow; r < mat.length; r++) {
      if (mat[r]![col]) { sel = r; break; }
    }
    if (sel === -1) continue;
    [mat[pivotRow], mat[sel]] = [mat[sel]!, mat[pivotRow]!];
    for (let r = 0; r < mat.length; r++) {
      if (r !== pivotRow && mat[r]![col]) {
        for (let c = 0; c < n; c++) mat[r]![c] = mat[r]![c] !== mat[pivotRow]![c];
      }
    }
    colOfPivot[col] = pivotRow;
    pivotCol.push(col);
    pivotRow++;
  }

  const pivotSet = new Set(pivotCol);
  const freeCols = [];
  for (let c = 0; c < n; c++) if (!pivotSet.has(c)) freeCols.push(c);

  const basis: boolean[][] = [];
  for (const free of freeCols) {
    const vec = new Array<boolean>(n).fill(false);
    vec[free] = true;
    for (const pc of pivotCol) {
      const pr = colOfPivot[pc]!;
      if (mat[pr]![free]) vec[pc] = true;
    }
    basis.push(vec);
  }
  return basis;
}

/** Subscript a small integer for pretty operation labels. */
function primedLabel(ops: readonly SymmetryOperation[]): string {
  const primed = ops.filter((o) => (o.timeReversal ?? 1) === -1).map((o) => o.xyz);
  if (primed.length === 0) return "type I (no time reversal)";
  return `type III · primed: ${primed.join("  ")}`;
}

/**
 * Generate all k = 0 candidate magnetic space groups from a parent operation
 * list. Returns the type-I group and one type-III group per index-2 subgroup.
 */
export function generateMagneticCandidates(
  parentOps: readonly SymmetryOperation[],
): MagneticCandidate[] {
  const ops = distinctCosets(parentOps);
  const m = ops.length;
  const index = new Map<string, number>();
  ops.forEach((op, i) => index.set(rotationKey(op), i));

  // Composition table over rotation cosets.
  const comp: number[][] = ops.map((a) =>
    ops.map((b) => index.get(rotationKey(composeOperations(a, b))) ?? 0),
  );

  // Constraints: x_i ⊕ x_j ⊕ x_{comp} = 0, plus x_identity = 0.
  const rows: boolean[][] = [];
  const identityIdx = ops.findIndex(isIdentity);
  const idRow = new Array<boolean>(m).fill(false);
  idRow[identityIdx >= 0 ? identityIdx : 0] = true;
  rows.push(idRow);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const row = new Array<boolean>(m).fill(false);
      row[i] = !row[i];
      row[j] = !row[j];
      const c = comp[i]![j]!;
      row[c] = !row[c];
      if (row.some(Boolean)) rows.push(row);
    }
  }

  const basis = nullSpaceGF2(rows, m);

  // Enumerate all 2^dim homomorphisms from the null-space basis.
  const dim = basis.length;
  const candidates: MagneticCandidate[] = [];
  const seen = new Set<string>();
  for (let mask = 0; mask < (1 << dim); mask++) {
    const x = new Array<boolean>(m).fill(false);
    for (let b = 0; b < dim; b++) {
      if (mask & (1 << b)) {
        for (let c = 0; c < m; c++) x[c] = x[c] !== basis[b]![c];
      }
    }
    const signature = x.map((v) => (v ? "1" : "0")).join("");
    if (seen.has(signature)) continue;
    seen.add(signature);

    // Assign θ to the FULL parent operation list (each op takes the sign of its
    // rotation coset), so centring translations are preserved for the calc.
    const candOps: SymmetryOperation[] = parentOps.map((op) => {
      const coset = index.get(rotationKey(op)) ?? 0;
      return { ...op, timeReversal: (x[coset] ? -1 : 1) as 1 | -1 };
    });
    // Label from one representative per coset.
    const cosetReps: SymmetryOperation[] = ops.map((op, i) => ({ ...op, timeReversal: (x[i] ? -1 : 1) as 1 | -1 }));
    const unprimedCount = cosetReps.filter((o) => (o.timeReversal ?? 1) === 1).length;
    const isTypeI = unprimedCount === m;
    candidates.push({
      id: `mag-cand-${signature}`,
      label: primedLabel(cosetReps),
      isTypeI,
      unprimedCount,
      operations: candOps,
    });
  }

  // Type I first, then by decreasing symmetry (more unprimed ops).
  candidates.sort((a, b) => Number(b.isTypeI) - Number(a.isTypeI) || b.unprimedCount - a.unprimedCount);
  return candidates;
}

// operationKey is re-exported for callers that key candidates by their op set.
export { operationKey };
