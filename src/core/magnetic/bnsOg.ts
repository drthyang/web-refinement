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
import type { Mat3, Vec3 } from "@/core/math/types";
import {
  composeOperations,
  formatOperationXyz,
  operationKey,
  parseMagneticSymmetryOperation,
  parseSymmetryOperation,
} from "@/core/crystal/symmetry";
import { mulMat } from "@/core/math/mat3";
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

// ---------------------------------------------------------------------------
// Setting-transformation search
//
// A subgroup of a standard-setting parent is often expressed in a
// non-standard setting (monoclinic axis along a or c, off-origin inversion
// centre, …), so its operation set misses the exact table match even though
// the group type is tabulated. The remedy is the ITA basis transformation
// (P, p): with x_old = P·x_new + p, every operation conjugates as
//
//   R' = P⁻¹·R·P,   t' = P⁻¹·(R·p + t − p)
//
// (International Tables for Crystallography Vol. A, §1.5 "Transformations of
// coordinate systems", and Vol. A1, Wondratschek & Müller, on subgroups in
// non-standard settings). Two families of basis changes are searched, each
// combined with origin shifts on the 1/4-grid:
//
//   1. the 24 proper signed axis permutations (det P = +1) — every
//      right-handed relabelling of the axes; and
//   2. the three **orthohexagonal** C-centred cells (det P = +2) composed
//      with the 24 permutations — (a, a+2b, c) and its 120°-rotated variants.
//      These are how the orthorhombic and monoclinic subgroups of a hexagonal
//      parent reach their standard settings (ITA A1): the doubled cell brings
//      a centring, so the transformed operation set is expanded with the
//      centring cosets {P⁻¹·v mod 1, v ∈ ℤ³} before matching.
//
// det P > 1 makes P⁻¹ rational: the arithmetic uses the integer adjugate
// (P⁻¹ = adj P / det P) and a transformed rotation is accepted only when
// adj·R·P is divisible by det — otherwise that basis simply does not apply.
// Every match is still **exact** — only the setting is searched, never the
// symbol guessed. Rhombohedral↔hexagonal (det 3) and monoclinic cell choices
// 2/3 remain outside the family and honestly return null.
// ---------------------------------------------------------------------------

export interface TransformedIdentification {
  readonly identity: MagneticGroupIdentity;
  /** New basis in terms of the old, ITA-style, e.g. "(b, c, a; 0, 0, 0)". */
  readonly transformation: string;
  /** True when the match needed no transformation (standard setting). */
  readonly direct: boolean;
  /** Basis-change matrix: columns = standard-setting basis vectors in the
   *  parent basis (x_old = P·x_new + P·originShift). Lets the UI draw the
   *  transformed cell. Identity when `direct`. */
  readonly P: Mat3;
  /** Origin shift in the new basis; the new cell origin sits at the parent
   *  fractional position P·originShift. Zero when `direct`. */
  readonly originShift: Vec3;
}

/** The 24 proper (det = +1) signed permutation matrices, identity first. */
function properSignedPermutations(): Mat3[] {
  const perms = [
    [0, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1], [1, 0, 2], [2, 1, 0],
  ];
  const out: Mat3[] = [];
  for (const perm of perms) {
    for (let signs = 0; signs < 8; signs++) {
      const P: number[][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      // Column j is (±1) in row perm[j]: new axis j = ±(old axis perm[j]).
      let det = 1;
      for (let j = 0; j < 3; j++) {
        const s = signs & (1 << j) ? -1 : 1;
        P[perm[j]!]![j] = s;
        det *= s;
      }
      // Sign of the permutation: even for the first three above.
      const parity = perm[0] === 0 && perm[1] === 1 ? 1 : perms.indexOf(perm) < 3 ? 1 : -1;
      if (det * parity === 1) out.push(P as unknown as Mat3);
    }
  }
  // Identity first so a standard-setting group reports `direct`.
  out.sort((a, b) => Number(isIdentityMat(b)) - Number(isIdentityMat(a)));
  return out;
}

function isIdentityMat(m: Mat3): boolean {
  return m[0]![0] === 1 && m[1]![1] === 1 && m[2]![2] === 1 &&
    m[0]![1] === 0 && m[0]![2] === 0 && m[1]![0] === 0 &&
    m[1]![2] === 0 && m[2]![0] === 0 && m[2]![1] === 0;
}

function mulVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]![0]! * v[0]! + m[0]![1]! * v[1]! + m[0]![2]! * v[2]!,
    m[1]![0]! * v[0]! + m[1]![1]! * v[1]! + m[1]![2]! * v[2]!,
    m[2]![0]! * v[0]! + m[2]![1]! * v[1]! + m[2]![2]! * v[2]!,
  ];
}

function det3(m: Mat3): number {
  return (
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  );
}

/** Integer adjugate: P⁻¹ = adj(P) / det(P). */
function adjugate(m: Mat3): Mat3 {
  const c = (r1: number, c1: number, r2: number, c2: number): number =>
    m[r1]![c1]! * m[r2]![c2]! - m[r1]![c2]! * m[r2]![c1]!;
  return [
    [c(1, 1, 2, 2), -c(0, 1, 2, 2), c(0, 1, 1, 2)],
    [-c(1, 0, 2, 2), c(0, 0, 2, 2), -c(0, 0, 1, 2)],
    [c(1, 0, 2, 1), -c(0, 0, 2, 1), c(0, 0, 1, 1)],
  ];
}

interface BasisOption {
  readonly P: Mat3;
  readonly adj: Mat3;
  readonly det: number;
  /** Centring translations of the old lattice in the new cell (det vectors). */
  readonly centerings: readonly Vec3[];
}

/** {P⁻¹·v mod 1 : v ∈ ℤ³} — the centring cosets a det-P cell acquires. */
function centeringVectors(adj: Mat3, det: number): Vec3[] {
  const seen = new Map<string, Vec3>();
  const wrap = (x: number): number => {
    const r = ((x % 1) + 1) % 1;
    return Math.abs(r - 1) < 1e-9 ? 0 : r;
  };
  for (let i = 0; i < det; i++) {
    for (let j = 0; j < det; j++) {
      for (let k = 0; k < det; k++) {
        const v: Vec3 = [
          wrap((adj[0]![0]! * i + adj[0]![1]! * j + adj[0]![2]! * k) / det),
          wrap((adj[1]![0]! * i + adj[1]![1]! * j + adj[1]![2]! * k) / det),
          wrap((adj[2]![0]! * i + adj[2]![1]! * j + adj[2]![2]! * k) / det),
        ];
        seen.set(v.map((x) => x.toFixed(6)).join(","), v);
      }
    }
  }
  return [...seen.values()];
}

let basisOptionsCache: BasisOption[] | null = null;

/**
 * All searched basis changes: the 24 proper signed permutations (det 1), then
 * the three orthohexagonal cells composed with the permutations (det 2).
 */
function basisOptions(): BasisOption[] {
  if (basisOptionsCache) return basisOptionsCache;
  const perms = properSignedPermutations();
  // Columns = new basis vectors in the old (hexagonal) basis. In a γ = 120°
  // cell, a ⊥ a+2b, b ⊥ 2a+b, and (a+b) ⊥ (a−b) — the three orthohexagonal
  // settings (each right-handed, det +2, C-centring (½,½,0)-type).
  const orthohex: Mat3[] = [
    [[1, 1, 0], [0, 2, 0], [0, 0, 1]],    // (a, a+2b, c)
    [[0, -2, 0], [1, -1, 0], [0, 0, 1]],  // (b, −2a−b, c)
    [[1, -1, 0], [1, 1, 0], [0, 0, 1]],   // (a+b, −a+b, c)
  ];
  const all: Mat3[] = [...perms];
  for (const O of orthohex) for (const Q of perms) all.push(mulMat(O, Q));
  basisOptionsCache = all.map((P) => {
    const det = det3(P);
    const adj = adjugate(P);
    return { P, adj, det, centerings: det > 1 ? centeringVectors(adj, det) : [[0, 0, 0]] };
  });
  return basisOptionsCache;
}

/**
 * Basis-change part of the conjugation: R' = adj·R·P / det (must divide
 * exactly — returns null when this basis does not apply to the rotation),
 * t' = adj·t / det. Origin shifts are applied afterwards, in the new basis.
 */
function changeBasis(op: SymmetryOperation, basis: BasisOption): SymmetryOperation | null {
  const M = mulMat(mulMat(basis.adj, op.rotation), basis.P);
  const rotation: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const q = M[i]![j]! / basis.det;
      if (Math.abs(q - Math.round(q)) > 1e-9) return null;
      rotation[i]![j] = Math.round(q);
    }
  }
  const translation = mulVec3(basis.adj, op.translation).map((x) => x / basis.det) as unknown as Vec3;
  return {
    rotation: rotation as unknown as Mat3,
    translation,
    xyz: formatOperationXyz(rotation as unknown as Mat3, translation),
    ...(op.timeReversal !== undefined ? { timeReversal: op.timeReversal } : {}),
  };
}

/** Origin shift by p (new basis): t'' = R·p + t − p. */
function shiftOrigin(op: SymmetryOperation, p: Vec3): SymmetryOperation {
  const Rp = mulVec3(op.rotation, p);
  const translation: Vec3 = [
    Rp[0]! + op.translation[0]! - p[0]!,
    Rp[1]! + op.translation[1]! - p[1]!,
    Rp[2]! + op.translation[2]! - p[2]!,
  ];
  return { ...op, translation, xyz: formatOperationXyz(op.rotation, translation) };
}

const AXES = ["a", "b", "c"] as const;

/** Describe P by its columns ("b", "-a", "a+2b", …) plus the origin shift. */
function describeTransformation(P: Mat3, p: Vec3): string {
  const cols = [0, 1, 2].map((j) => {
    const terms: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = P[i]![j]!;
      if (v === 0) continue;
      const mag = Math.abs(v) === 1 ? "" : String(Math.abs(v));
      terms.push(`${v < 0 ? "-" : terms.length > 0 ? "+" : ""}${mag}${AXES[i]!}`);
    }
    return terms.join("") || "0";
  });
  const frac = (v: number): string => {
    const q = Math.round(v * 4) / 4;
    return q === 0 ? "0" : q === 0.25 ? "1/4" : q === 0.5 ? "1/2" : q === 0.75 ? "3/4" : String(q);
  };
  return `(${cols.join(", ")}; ${p.map(frac).join(", ")})`;
}

/** Origin-shift grids, coarse to fine: exact setting → halves → quarters. */
function* originShifts(): Generator<Vec3> {
  yield [0, 0, 0];
  const halves = [0, 0.5];
  for (const x of halves) for (const y of halves) for (const z of halves) {
    if (x !== 0 || y !== 0 || z !== 0) yield [x, y, z];
  }
  const quarters = [0, 0.25, 0.5, 0.75];
  for (const x of quarters) for (const y of quarters) for (const z of quarters) {
    if ((x * 4) % 2 === 0 && (y * 4) % 2 === 0 && (z * 4) % 2 === 0) continue; // already tried
    yield [x, y, z];
  }
}

/**
 * Identify a magnetic group in **any setting reachable by a proper axis
 * permutation or an orthohexagonal (C-centred, det-2) cell, plus a ¼-grid
 * origin shift**: conjugate the operation set by each candidate (P, p), expand
 * the centring cosets the new cell requires, and look for an exact table
 * match. Returns the identity plus the transformation that produced the match
 * (`direct` when none was needed), or null when no setting in the family
 * matches — a wrong symbol is still worse than none.
 */
export function identifyMagneticGroupAnySetting(
  ops: readonly SymmetryOperation[],
): TransformedIdentification | null {
  const direct = identifyMagneticGroup(ops);
  if (direct) {
    return {
      identity: direct,
      transformation: "(a, b, c; 0, 0, 0)",
      direct: true,
      P: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      originShift: [0, 0, 0],
    };
  }

  for (const basis of basisOptions()) {
    // Basis change first (origin shifts reuse the transformed list).
    const reps: SymmetryOperation[] = [];
    let applies = true;
    for (const op of ops) {
      const t = changeBasis(op, basis);
      if (!t) { applies = false; break; } // rotation not integral in this cell
      reps.push(t);
    }
    if (!applies) continue;
    // The det-P cell contains det-P old lattice points: expand their cosets.
    const base =
      basis.det === 1
        ? reps
        : basis.centerings.flatMap((c) =>
            reps.map((op) => ({
              ...op,
              translation: [
                op.translation[0]! + c[0]!,
                op.translation[1]! + c[1]!,
                op.translation[2]! + c[2]!,
              ] as Vec3,
            })),
          );
    for (const p of originShifts()) {
      if (p[0] === 0 && p[1] === 0 && p[2] === 0 && basis.det === 1 && isIdentityMat(basis.P)) {
        continue; // the untransformed set was already tried above
      }
      const shifted = p[0] === 0 && p[1] === 0 && p[2] === 0 ? base : base.map((op) => shiftOrigin(op, p));
      const identity = identifyMagneticGroup(shifted);
      if (identity) {
        return {
          identity,
          transformation: describeTransformation(basis.P, p),
          direct: false,
          P: basis.P,
          originShift: p,
        };
      }
    }
  }
  return null;
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
