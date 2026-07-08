/**
 * Standard BNS/OG identification of magnetic space groups.
 *
 * A magnetic group *is* its operation set, so identification is exact set
 * matching: the candidate's operations (spatial part modulo lattice
 * translations, plus the ±1 time-reversal flag) are canonicalized into a
 * signature and looked up against the bundled standard table
 * ({@link ./bnsOgTable} — generated from the ISO-MAG data, see that file's
 * header for provenance). No symbol is ever derived heuristically: if the
 * operations do not match a tabulated group *in its standard BNS setting*,
 * identification returns `null` and callers keep the descriptive
 * primed-operation label. A wrong symbol is worse than none
 * (docs/MAGNETIC_SYMMETRY.md).
 *
 * Because the table covers types I and III — exactly what the k = 0 /
 * little-group θ-enumeration produces — every candidate generated from a
 * parent group in its standard ITA setting (monoclinic b-unique cell choice 1,
 * hexagonal axes, origin choice 2) is identified. Parents in non-standard
 * settings (as CIFs sometimes are) simply come back unlabelled.
 *
 * For types I–III the OG symbol coincides with the BNS symbol; only the OG
 * *number* differs (verified at table-generation time).
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import {
  composeOperations,
  operationKey,
  parseMagneticSymmetryOperation,
  parseSymmetryOperation,
} from "@/core/crystal/symmetry";
import { MAGNETIC_GROUP_TABLE } from "./bnsOgTable";

export interface MagneticGroupIdentity {
  /** Shubnikov type: 1 (M = G, colourless) or 3 (M = D + θ(G − D)). */
  readonly magtype: 1 | 3;
  /** BNS number, e.g. "62.448". */
  readonly bnsNumber: string;
  /** BNS symbol in ASCII form, e.g. "Pn'ma'" or "P2_1'/c" (see {@link formatMagneticSymbol}). */
  readonly bnsSymbol: string;
  /** OG (Opechowski–Guccione) number, e.g. "62.8.509". */
  readonly ogNumber: string;
  /** OG symbol — equals the BNS symbol for types I–III. */
  readonly ogSymbol: string;
  /** ITA number of the parent (Fedorov) space group. */
  readonly parentNumber: number;
}

/** Canonical key of one magnetic operation: spatial coset key + time reversal. */
function magneticOpKey(op: SymmetryOperation): string {
  return `${operationKey(op)}|${op.timeReversal ?? 1}`;
}

/**
 * Canonical signature of a whole operation set: the sorted, deduplicated
 * operation keys. Duplicates (the same op given twice modulo a lattice
 * translation) collapse, so signatures compare groups, not listings.
 */
function groupSignature(ops: readonly SymmetryOperation[]): string {
  return [...new Set(ops.map(magneticOpKey))].sort().join(" ");
}

/** Turn a centring vector string like "1/2,1/2,0" into a pure-translation op. */
function centringOperation(vector: string): SymmetryOperation {
  const parts = vector.split(",");
  const xyz = ["x", "y", "z"].map((ax, i) => (parts[i] === "0" ? ax : `${ax}+${parts[i]}`)).join(",");
  return parseSymmetryOperation(xyz);
}

let lookup: Map<string, MagneticGroupIdentity> | null = null;

/** Build the signature → identity map once, on first use. */
function buildLookup(): Map<string, MagneticGroupIdentity> {
  const map = new Map<string, MagneticGroupIdentity>();
  for (const [magtype, bnsNumber, bnsSymbol, ogNumber, parentNumber, ops, centring] of MAGNETIC_GROUP_TABLE) {
    const reps = ops.split(";").map(parseMagneticSymmetryOperation);
    const shifts = centring === "" ? [] : centring.split(";").map(centringOperation);
    const full = [...reps, ...shifts.flatMap((s) => reps.map((op) => composeOperations(s, op)))];
    const identity: MagneticGroupIdentity = {
      magtype,
      bnsNumber,
      bnsSymbol,
      ogNumber,
      ogSymbol: bnsSymbol,
      parentNumber,
    };
    map.set(groupSignature(full), identity);
  }
  return map;
}

/**
 * Identify a magnetic group from its full operation list (including centring
 * cosets; missing `timeReversal` means +1). Returns the standard BNS/OG
 * numbers and symbols, or `null` when the operations do not match any type-I
 * or type-III group in its standard BNS setting.
 */
export function identifyMagneticGroup(
  ops: readonly SymmetryOperation[],
): MagneticGroupIdentity | null {
  lookup ??= buildLookup();
  return lookup.get(groupSignature(ops)) ?? null;
}

/** All tabulated type-I/III groups with the given parent space-group number. */
export function magneticGroupsForParent(parentNumber: number): MagneticGroupIdentity[] {
  return MAGNETIC_GROUP_TABLE.filter((row) => row[4] === parentNumber).map(
    ([magtype, bnsNumber, bnsSymbol, ogNumber, parent]) => ({
      magtype,
      bnsNumber,
      bnsSymbol,
      ogNumber,
      ogSymbol: bnsSymbol,
      parentNumber: parent,
    }),
  );
}

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
};

/**
 * Pretty-print an ASCII BNS/OG symbol for display: screw-axis subscripts
 * ("P2_1'/c'" → "P2₁'/c'"). Roto-inversion bars stay as leading minus signs
 * ("Fm-3m"), matching how nuclear symbols are shown elsewhere in the app.
 */
export function formatMagneticSymbol(symbol: string): string {
  return symbol.replace(/_(\d)/g, (_, d: string) => SUBSCRIPTS[d] ?? d);
}
