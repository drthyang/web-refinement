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
 * it yields the correct *set* of maximal magnetic subgroups for k = 0.
 *
 * Each candidate is additionally matched against the bundled standard table of
 * Shubnikov groups ({@link identifyMagneticGroup}): when the parent is in its
 * standard ITA setting, the candidate carries its BNS/OG numbers and symbols
 * (e.g. "Pn'ma'", BNS 62.448). When no exact match exists (non-standard
 * setting, or a little-group subset for k ≠ 0), `standard` is null and the
 * label falls back to describing which operations are primed.
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { composeOperations, operationKey } from "@/core/crystal/symmetry";
import {
  formatMagneticSymbol,
  identifyMagneticGroup,
  type MagneticGroupIdentity,
} from "./bnsOg";

export interface MagneticCandidate {
  readonly id: string;
  /** Display label: the BNS symbol when identified (e.g. "P2₁'/c'"), else a
   *  descriptive one like "type III · primed: 2₁, m". */
  readonly label: string;
  /** True for the type-I (no time-reversal) group. */
  readonly isTypeI: boolean;
  /** Number of unprimed (θ = +1) operations. */
  readonly unprimedCount: number;
  readonly operations: readonly SymmetryOperation[];
  /** Standard BNS/OG identification, or null if the operations do not match a
   *  tabulated group in its standard BNS setting. */
  readonly standard: MagneticGroupIdentity | null;
}

/** Deduplicate operations modulo lattice translation, identity first. */
export function distinctCosets(ops: readonly SymmetryOperation[]): SymmetryOperation[] {
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
export function rotationKey(op: SymmetryOperation): string {
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
    const standard = identifyMagneticGroup(candOps);
    candidates.push({
      id: `mag-cand-${signature}`,
      label: standard ? formatMagneticSymbol(standard.bnsSymbol) : primedLabel(cosetReps),
      isTypeI,
      unprimedCount,
      operations: candOps,
      standard,
    });
  }

  // Type I first, then by decreasing symmetry (more unprimed ops).
  candidates.sort((a, b) => Number(b.isTypeI) - Number(a.isTypeI) || b.unprimedCount - a.unprimedCount);
  return candidates;
}

/**
 * Transform a reciprocal-space vector (Miller-like) by an operation's rotation.
 * This codebase's convention is h' = Rᵀ·h (see `isReflectionAbsent`), so the
 * propagation vector transforms the same way. Translations do not act on k.
 *
 * Note: the strictly-geometric contragredient map of a dual-basis vector is
 * R⁻ᵀ·k (it differs from Rᵀ·k in oblique settings). This does NOT affect the
 * little group ({@link littleGroup}) or the star of k *as a set*: because the
 * group is closed under inverse and both Rᵀ and R⁻ᵀ map the reciprocal lattice
 * to itself, {R : Rᵀk ≡ k} = {R : R⁻ᵀk ≡ k}. Only if this were used to *label*
 * individual k-arms (not set membership) would R⁻ᵀ be required.
 */
export function transformK(op: SymmetryOperation, k: Vec3): Vec3 {
  const R = op.rotation;
  return [
    R[0][0] * k[0] + R[1][0] * k[1] + R[2][0] * k[2],
    R[0][1] * k[0] + R[1][1] * k[1] + R[2][1] * k[2],
    R[0][2] * k[0] + R[1][2] * k[1] + R[2][2] * k[2],
  ];
}

/** True if Rᵀ·k ≡ k modulo a reciprocal-lattice (integer) vector. */
function leavesKInvariant(op: SymmetryOperation, k: Vec3, tol: number): boolean {
  const kp = transformK(op, k);
  for (let i = 0; i < 3; i++) {
    const diff = kp[i]! - k[i]!;
    if (Math.abs(diff - Math.round(diff)) > tol) return false;
  }
  return true;
}

/**
 * The little group (group of the wavevector) G_k: the operations of the parent
 * group whose rotation leaves k invariant modulo a reciprocal-lattice vector,
 * Rᵀ·k ≡ k (mod 1). For k = 0 this is the whole parent group.
 *
 * Reference: Bradley & Cracknell, *The Mathematical Theory of Symmetry in
 * Solids* (1972), §3.7 (the group of the wavevector).
 */
export function littleGroup(
  parentOps: readonly SymmetryOperation[],
  k: Vec3,
  tol = 1e-4,
): SymmetryOperation[] {
  return parentOps.filter((op) => leavesKInvariant(op, k, tol));
}

/**
 * Candidate magnetic space groups for a **commensurate** propagation vector k:
 * enumerate the time-reversal homomorphisms θ: G_k → {±1} on the little group
 * (the same GF(2) construction as the k = 0 case, restricted to G_k). For k = 0
 * this reduces exactly to {@link generateMagneticCandidates}.
 *
 * This yields the little-group magnetic subgroups — the correct symmetry
 * starting point for a commensurate single-k structure. It does **not** perform
 * representation (irrep) analysis or enumerate the full star of k; those are
 * the M3/M4 follow-ups (see ROADMAP). BNS/OG labels are attached when the
 * little group happens to match a standard-setting group (always true for
 * k = 0 with a standard-setting parent); type-IV groups (anti-translations for
 * k ≠ 0) are not yet enumerated, so those candidates stay descriptive.
 *
 * Reference: Bertaut, *Acta Cryst.* A24 (1968) 217; Bradley & Cracknell (1972).
 */
export function generateMagneticCandidatesForK(
  parentOps: readonly SymmetryOperation[],
  k: Vec3,
): MagneticCandidate[] {
  return generateMagneticCandidates(littleGroup(parentOps, k));
}

// operationKey is re-exported for callers that key candidates by their op set.
export { operationKey };
