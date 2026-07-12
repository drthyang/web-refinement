/**
 * Crystallographic point-group determination from a set of symmetry operations.
 *
 * The *geometric crystal class* of a group is fixed by the multiset of its
 * operation TYPES — how many identities, 2/3/4/6-fold rotations, inversions,
 * mirrors, and rotoinversions it contains — independent of orientation. That
 * multiset is a signature that uniquely names one of the 32 crystallographic
 * point groups. This module classifies:
 *   - a whole space group's rotation parts → the crystal's point group / class;
 *   - a site's stabilizer → the site symmetry (used by `siteSymmetry.ts`).
 *
 * The 32-group signature table is DERIVED, not hand-typed: each group is closed
 * from generators (`expandGenerators`) and its signature computed, so a typo in
 * the generators shows up as a wrong group order or a signature collision — both
 * asserted in `pointGroup.test.ts`.
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { expandGenerators } from "@/core/crystal/spaceGroups";
import { determinant } from "@/core/math/mat3";

/**
 * ITA operation type: +n is an n-fold proper rotation; −1 is inversion, −2 a
 * mirror (m), and −3/−4/−6 the rotoinversions. Determined by (det, trace) of the
 * rotation matrix (integer-valued in the crystal basis).
 */
export type OperationType = 1 | 2 | 3 | 4 | 6 | -1 | -2 | -3 | -4 | -6;

const PROPER: Record<number, OperationType> = { 3: 1, 2: 6, 1: 4, 0: 3, [-1]: 2 };
const IMPROPER: Record<number, OperationType> = { [-3]: -1, 1: -2, 0: -3, [-1]: -4, [-2]: -6 };

/** The ITA type (signed fold) of a single symmetry operation. */
export function operationType(op: SymmetryOperation): OperationType {
  const r = op.rotation;
  const det = determinant(r);
  const trace = r[0]![0]! + r[1]![1]! + r[2]![2]!;
  const t = Math.round(trace);
  const type = det > 0 ? PROPER[t] : IMPROPER[t];
  if (type === undefined) throw new Error(`Non-crystallographic operation (det ${det}, trace ${trace}).`);
  return type;
}

const TYPE_ORDER: OperationType[] = [1, 2, 3, 4, 6, -1, -2, -3, -4, -6];

/** Canonical signature string: the sorted count of each operation type. */
export function pointGroupSignature(ops: readonly SymmetryOperation[]): string {
  const counts = new Map<OperationType, number>();
  for (const op of ops) counts.set(operationType(op), (counts.get(operationType(op)) ?? 0) + 1);
  return TYPE_ORDER.map((t) => `${t}:${counts.get(t) ?? 0}`).join(",");
}

/**
 * The 32 crystallographic point groups, each by its Hermann–Mauguin symbol and a
 * generating set (rotation-only, orientation is irrelevant to the signature).
 * Exported so the test can assert every one closes to its known order.
 */
export const POINT_GROUP_GENERATORS: readonly { readonly symbol: string; readonly order: number; readonly generators: readonly string[] }[] = [
  { symbol: "1", order: 1, generators: [] },
  { symbol: "-1", order: 2, generators: ["-x,-y,-z"] },
  { symbol: "2", order: 2, generators: ["-x,-y,z"] },
  { symbol: "m", order: 2, generators: ["x,y,-z"] },
  { symbol: "2/m", order: 4, generators: ["-x,-y,z", "-x,-y,-z"] },
  { symbol: "222", order: 4, generators: ["-x,-y,z", "x,-y,-z"] },
  { symbol: "mm2", order: 4, generators: ["-x,-y,z", "x,-y,z"] },
  { symbol: "mmm", order: 8, generators: ["-x,-y,z", "x,-y,-z", "-x,-y,-z"] },
  { symbol: "4", order: 4, generators: ["-y,x,z"] },
  { symbol: "-4", order: 4, generators: ["y,-x,-z"] },
  { symbol: "4/m", order: 8, generators: ["-y,x,z", "-x,-y,-z"] },
  { symbol: "422", order: 8, generators: ["-y,x,z", "x,-y,-z"] },
  { symbol: "4mm", order: 8, generators: ["-y,x,z", "x,-y,z"] },
  { symbol: "-42m", order: 8, generators: ["y,-x,-z", "x,-y,-z"] },
  { symbol: "4/mmm", order: 16, generators: ["-y,x,z", "x,-y,-z", "-x,-y,-z"] },
  { symbol: "3", order: 3, generators: ["-y,x-y,z"] },
  { symbol: "-3", order: 6, generators: ["-y,x-y,z", "-x,-y,-z"] },
  { symbol: "32", order: 6, generators: ["-y,x-y,z", "x-y,-y,-z"] },
  { symbol: "3m", order: 6, generators: ["-y,x-y,z", "-x+y,y,z"] },
  { symbol: "-3m", order: 12, generators: ["-y,x-y,z", "x-y,-y,-z", "-x,-y,-z"] },
  { symbol: "6", order: 6, generators: ["x-y,x,z"] },
  { symbol: "-6", order: 6, generators: ["-y,x-y,-z"] },
  { symbol: "6/m", order: 12, generators: ["x-y,x,z", "-x,-y,-z"] },
  { symbol: "622", order: 12, generators: ["x-y,x,z", "x-y,-y,-z"] },
  { symbol: "6mm", order: 12, generators: ["x-y,x,z", "-x+y,y,z"] },
  { symbol: "-6m2", order: 12, generators: ["-y,x-y,-z", "x-y,-y,-z"] },
  { symbol: "6/mmm", order: 24, generators: ["x-y,x,z", "x-y,-y,-z", "-x,-y,-z"] },
  { symbol: "23", order: 12, generators: ["-x,-y,z", "x,-y,-z", "z,x,y"] },
  { symbol: "m-3", order: 24, generators: ["-x,-y,z", "x,-y,-z", "z,x,y", "-x,-y,-z"] },
  { symbol: "432", order: 24, generators: ["-y,x,z", "z,x,y"] },
  { symbol: "-43m", order: 24, generators: ["y,-x,-z", "z,x,y"] },
  { symbol: "m-3m", order: 48, generators: ["-y,x,z", "z,x,y", "-x,-y,-z"] },
];

/** Close a point group's generators into its full operation list. */
export function pointGroupFromGenerators(generators: readonly string[]): SymmetryOperation[] {
  return expandGenerators(generators.map(parseSymmetryOperation), 48);
}

// signature → symbol, built once from the derived table.
const SIGNATURE_TO_SYMBOL = new Map<string, string>();
for (const pg of POINT_GROUP_GENERATORS) {
  SIGNATURE_TO_SYMBOL.set(pointGroupSignature(pointGroupFromGenerators(pg.generators)), pg.symbol);
}

export interface PointGroupResult {
  /** Hermann–Mauguin symbol, or null if the operation set is not a recognized
   *  crystallographic point group (e.g. a partial/incomplete op list). */
  readonly symbol: string | null;
  /** Number of distinct point operations (rotation parts, mod lattice). */
  readonly order: number;
  /** The element-type signature (always defined, even when unnamed). */
  readonly signature: string;
}

/**
 * Classify a set of symmetry operations into a crystallographic point group by
 * its element-type signature. Duplicate rotation parts (operations differing
 * only by a lattice translation, e.g. screw/glide vs pure rotation) collapse to
 * one, so this works directly on a full space-group operation list.
 */
export function classifyPointGroup(ops: readonly SymmetryOperation[]): PointGroupResult {
  // Distinct rotation parts only — the point group is the group modulo translation.
  const byRot = new Map<string, SymmetryOperation>();
  for (const op of ops) {
    const r = op.rotation;
    const key = r.map((row) => row.join(",")).join(";");
    if (!byRot.has(key)) byRot.set(key, op);
  }
  const distinct = [...byRot.values()];
  const signature = pointGroupSignature(distinct);
  return { symbol: SIGNATURE_TO_SYMBOL.get(signature) ?? null, order: distinct.length, signature };
}
