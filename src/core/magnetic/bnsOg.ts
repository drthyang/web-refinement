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

/** Canonical key of one (rotation, θ) pair — what survives origin shifts. */
function rotationThetaKey(rotation: Mat3, theta: number): string {
  return `${rotation.map((row) => row.map((v) => Math.round(v)).join(",")).join(";")}|${theta}`;
}

/** Sorted, deduplicated (rotation, θ) keys of a group: its point-group part. */
function rotationSignature(keys: Iterable<string>): string {
  return [...new Set(keys)].sort().join(" ");
}

let lookup: Map<string, MagneticGroupIdentity> | null = null;
/** Rotation signatures of every tabulated group — a cheap necessary condition
 *  for a match that the setting search checks before trying origin shifts. */
let rotationLookup: Set<string> | null = null;

/** Build the signature → identity map (and the rotation-signature set) once, on first use. */
function buildLookup(): Map<string, MagneticGroupIdentity> {
  const map = new Map<string, MagneticGroupIdentity>();
  rotationLookup = new Set<string>();
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
    rotationLookup.add(rotationSignature(full.map((op) => rotationThetaKey(op.rotation, op.timeReversal ?? 1))));
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
// centre, a tetragonal subgroup still written in the cubic F cell, …), so its
// operation set misses the exact table match even though the group type is
// tabulated. The remedy is the ITA basis transformation (P, p): with
// x_old = P·x_new + p, every operation conjugates as
//
//   R' = P⁻¹·R·P,   t' = P⁻¹·(R·p + t − p)
//
// (International Tables for Crystallography Vol. A, §1.5 "Transformations of
// coordinate systems", and Vol. A1, Wondratschek & Müller, on subgroups in
// non-standard settings). Three families of basis changes are searched, each
// combined with origin shifts on the 1/4-grid:
//
//   1. the 24 proper signed axis permutations (det P = +1) — every
//      right-handed relabelling of the axes;
//   2. the three **orthohexagonal** C-centred cells (det P = +2) composed
//      with the 24 permutations — (a, a+2b, c) and its 120°-rotated variants.
//      These are how the orthorhombic and monoclinic subgroups of a hexagonal
//      parent reach their standard settings (ITA A1): the doubled cell brings
//      a centring, so the transformed operation set is expanded with the
//      centring cosets {P⁻¹·v mod 1, v ∈ ℤ³} before matching; and
//   3. the **cells of a cubic lattice** other than its conventional one: for a
//      face-centred lattice the body-centred tetragonal cell ((a−b)/2,
//      (a+b)/2, c), the obverse hexagonal cell of the rhombohedral sublattice
//      ((−a+b)/2, (−b+c)/2, a+b+c), two C-centred monoclinic cells with the
//      unique axis along a cube edge or a face diagonal, and the primitive
//      rhombohedral cell (det P = ½, ¾, ½, ½, ¼); for a primitive lattice the
//      obverse hexagonal cell (a−b, b−c, a+b+c) of ITA §1.5.1 (det 3), which
//      is also the rhombohedral→hexagonal axes change of a rhombohedral-axes
//      parent — each in every orientation the cubic point group allows. These
//      are how the tetragonal, rhombohedral, orthorhombic-I, monoclinic-C and
//      triclinic subgroups of an F cubic parent reach their standard settings
//      (I4/mm'm', R-3m', Im'm'm, C2'/m', P-1, …). A cell with fractional
//      basis vectors is applied only when each of them is a lattice vector of
//      the group being identified (its centring translations are read off the
//      operation list), so the transformed translation group is exactly P⁻¹
//      of the old one and never a fictitious superset.
//
// P is rational, P = N/d with N integer, and P⁻¹ = d·adj N / det N. A
// transformed rotation is accepted only when adj·R·N is divisible by det N —
// otherwise that basis simply does not apply. A basis whose transformed
// rotation set (which no origin shift can change) matches no tabulated group
// is dropped before any origin shift is tried. Every match is still
// **exact** — only the setting is searched, never the symbol guessed.
// Monoclinic cell choices 2/3, the reverse rhombohedral setting and sub-cells
// of I- or C-centred parents remain outside the family and honestly return
// null.
// ---------------------------------------------------------------------------

export interface TransformedIdentification {
  readonly identity: MagneticGroupIdentity;
  /** New basis in terms of the old, ITA-style, e.g. "(b, c, a; 0, 0, 0)" or
   *  "((a-b)/2, (a+b)/2, c; 0, 0, 0)". */
  readonly transformation: string;
  /** True when the match needed no transformation (standard setting). */
  readonly direct: boolean;
  /** Basis-change matrix: columns = standard-setting basis vectors in the
   *  parent basis (x_old = P·x_new + P·originShift), rational for sub-cells.
   *  Lets the UI draw the transformed cell. Identity when `direct`. */
  readonly P: Mat3;
  /** Origin shift in the new basis; the new cell origin sits at the parent
   *  fractional position P·originShift. Zero when `direct`. */
  readonly originShift: Vec3;
}

const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

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

/** Integer adjugate: N⁻¹ = adj(N) / det(N). */
function adjugate(m: Mat3): Mat3 {
  const c = (r1: number, c1: number, r2: number, c2: number): number =>
    m[r1]![c1]! * m[r2]![c2]! - m[r1]![c2]! * m[r2]![c1]!;
  return [
    [c(1, 1, 2, 2), -c(0, 1, 2, 2), c(0, 1, 1, 2)],
    [-c(1, 0, 2, 2), c(0, 0, 2, 2), -c(0, 0, 1, 2)],
    [c(1, 0, 2, 1), -c(0, 0, 2, 1), c(0, 0, 1, 1)],
  ];
}

/** x mod 1 in [0, 1), with values within 1e-9 of an integer snapped to 0. */
function wrap01(x: number): number {
  const r = ((x % 1) + 1) % 1;
  return Math.abs(r - 1) < 1e-9 || Math.abs(r) < 1e-9 ? 0 : r;
}

/** Canonical key of a translation vector modulo the lattice. */
function vecKey(v: Vec3): string {
  return v.map((x) => wrap01(x).toFixed(6)).join(",");
}

function isZeroVec(v: Vec3): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

interface BasisOption {
  /** Rational basis-change matrix: columns = new basis vectors in the old basis. */
  readonly P: Mat3;
  /** Integer numerator N = d·P, with adj N and det N > 0: P⁻¹ = d·adj/det. */
  readonly N: Mat3;
  readonly d: number;
  readonly adj: Mat3;
  readonly det: number;
  /** {P⁻¹·n mod 1 : n ∈ ℤ³} — the cosets the old integer translations occupy
   *  in the new cell (just the origin for a cell with integer P⁻¹). */
  readonly centerings: readonly Vec3[];
  /** Non-integer columns of P, reduced mod 1: each must be a centring
   *  translation of the group, or the cell is not a cell of its lattice. */
  readonly fractionalColumns: readonly Vec3[];
  readonly identity: boolean;
}

/** {d·adj·n / det mod 1 : n ∈ ℤ³} = P⁻¹·ℤ³ mod 1. Each image has order
 *  dividing det, so n over [0, det)³ reaches every coset. */
function centeringVectors(adj: Mat3, det: number, d: number): Vec3[] {
  const seen = new Map<string, Vec3>();
  for (let i = 0; i < det; i++) {
    for (let j = 0; j < det; j++) {
      for (let k = 0; k < det; k++) {
        const v = mulVec3(adj, [i, j, k]).map((x) => wrap01((d * x) / det)) as unknown as Vec3;
        seen.set(vecKey(v), v);
      }
    }
  }
  return [...seen.values()];
}

const DENOMINATORS = [1, 2, 3, 4, 6];

function makeBasisOption(P: Mat3): BasisOption {
  const isInt = (x: number): boolean => Math.abs(x - Math.round(x)) < 1e-9;
  const d = DENOMINATORS.find((k) => P.every((row) => row.every((x) => isInt(x * k))));
  if (d === undefined) throw new Error("basis matrix is not rational with a small denominator");
  const N = P.map((row) => row.map((x) => Math.round(x * d))) as unknown as Mat3;
  const det = det3(N);
  if (det <= 0) throw new Error("basis change must be right-handed");
  const adj = adjugate(N);
  const fractionalColumns: Vec3[] = [];
  for (let j = 0; j < 3; j++) {
    const col: Vec3 = [P[0]![j]!, P[1]![j]!, P[2]![j]!];
    if (!col.every(isInt)) fractionalColumns.push(col.map(wrap01) as unknown as Vec3);
  }
  return {
    P,
    N,
    d,
    adj,
    det,
    centerings: centeringVectors(adj, det, d),
    fractionalColumns,
    identity: isIdentityMat(P),
  };
}

/** Lattice points of a primitive and of a face-centred cell (origin included). */
const P_LATTICE: readonly Vec3[] = [[0, 0, 0]];
const F_LATTICE: readonly Vec3[] = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];

/** Centring sets a standard BNS setting can carry: P, C, I, F, obverse R. */
const STANDARD_CENTRINGS: ReadonlySet<string> = new Set(
  (
    [
      [[0, 0, 0]],
      [[0, 0, 0], [0.5, 0.5, 0]],
      [[0, 0, 0], [0.5, 0.5, 0.5]],
      [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
      [[0, 0, 0], [2 / 3, 1 / 3, 1 / 3], [1 / 3, 2 / 3, 2 / 3]],
    ] as Vec3[][]
  ).map((set) => set.map(vecKey).sort().join(" ")),
);

/** The cosets the given lattice occupies in the cell P, as a sorted key. */
function latticeCentringKey(b: BasisOption, lattice: readonly Vec3[]): string {
  const keys = new Set<string>();
  for (const c of lattice) {
    const pc = mulVec3(b.adj, c).map((x) => (b.d * x) / b.det);
    for (const n of b.centerings) keys.add(vecKey([pc[0]! + n[0]!, pc[1]! + n[1]!, pc[2]! + n[2]!]));
  }
  return [...keys].sort().join(" ");
}

/**
 * Cells of a cubic (or rhombohedral-axes) lattice other than its conventional
 * one: each seed in every orientation the cubic point group allows (left
 * factor Q₁ over the 24 proper rotations) and, where the standard setting
 * cares about axis order, every relabelling (right factor Q₂). Only cells in
 * which the seed's lattice shows a standard centring (P, C, I, F or obverse R)
 * are kept, so e.g. only the C-monoclinic relabellings with the centring at
 * (½, ½, 0) and only the obverse hexagonal orientations survive.
 */
function cubicSubcells(perms: readonly Mat3[]): Mat3[] {
  const seeds: { O: Mat3; lattice: readonly Vec3[]; orient: boolean; relabel: boolean }[] = [
    // F → body-centred tetragonal ((a−b)/2, (a+b)/2, c), det ½: the I4/mmm-,
    // Immm-, Imm2-, I222-family settings.
    { O: [[0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0, 1]], lattice: F_LATTICE, orient: true, relabel: true },
    // F → obverse hexagonal axes of the rhombohedral sublattice, det ¾:
    // a_h = a_r − b_r, b_h = b_r − c_r, c_h = a_r + b_r + c_r with
    // (a_r, b_r, c_r) = ((b+c)/2, (a+c)/2, (a+b)/2), i.e.
    // ((−a+b)/2, (−b+c)/2, a+b+c): the R3-…R-3m-family settings.
    { O: [[-0.5, 0, 1], [0.5, -0.5, 1], [0, 0.5, 1]], lattice: F_LATTICE, orient: true, relabel: false },
    // F → C-centred monoclinic, unique axis b' along a cube edge, det ½:
    // (a, c, (a−b)/2) — the C2/m-family settings for a mirror ⊥ a cube edge.
    { O: [[1, 0, 0.5], [0, 0, -0.5], [0, 1, 0]], lattice: F_LATTICE, orient: true, relabel: true },
    // F → C-centred monoclinic, unique axis b' along a face diagonal, det ½:
    // ((a+b)/2 + c, (a−b)/2, (a+b)/2) — for a mirror ⊥ a face diagonal.
    { O: [[0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [1, 0, 0]], lattice: F_LATTICE, orient: true, relabel: true },
    // F → primitive rhombohedral cell ((b+c)/2, (a+c)/2, (a+b)/2), det ¼:
    // the triclinic P1 / P-1 settings (any primitive cell will do).
    { O: [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]], lattice: F_LATTICE, orient: false, relabel: false },
    // Rhombohedral axes → obverse hexagonal axes (a−b, b−c, a+b+c), det 3
    // (ITA Vol. A §1.5.1): for a rhombohedral-axes parent, or a primitive
    // cubic one, whose 3-fold subgroups are rhombohedral.
    { O: [[1, 0, 1], [-1, 1, 1], [0, -1, 1]], lattice: P_LATTICE, orient: true, relabel: false },
  ];
  const out = new Map<string, Mat3>();
  for (const { O, lattice, orient, relabel } of seeds) {
    const lefts = orient ? perms : [IDENTITY];
    const rights = relabel ? perms : [IDENTITY];
    for (const Q1 of lefts) {
      for (const Q2 of rights) {
        const P = mulMat(mulMat(Q1, O), Q2);
        const key = P.map((row) => row.map((x) => x.toFixed(6)).join(",")).join(";");
        if (out.has(key)) continue;
        if (!STANDARD_CENTRINGS.has(latticeCentringKey(makeBasisOption(P), lattice))) continue;
        out.set(key, P);
      }
    }
  }
  return [...out.values()];
}

let basisOptionsCache: BasisOption[] | null = null;

/**
 * All searched basis changes, in order: the 24 proper signed permutations
 * (det 1), the three orthohexagonal cells composed with the permutations
 * (det 2), then the sub-cells of an F cubic lattice (det ½, ¾, ¼) and the
 * hexagonal cell of a rhombohedral-axes lattice (det 3).
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
  all.push(...cubicSubcells(perms));
  basisOptionsCache = all.map(makeBasisOption);
  return basisOptionsCache;
}

/** R' = adj·R·N / det, or null when it is not integral (basis does not apply). */
function changeRotation(rotation: Mat3, basis: BasisOption): Mat3 | null {
  const M = mulMat(mulMat(basis.adj, rotation), basis.N);
  const out: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const q = M[i]![j]! / basis.det;
      if (Math.abs(q - Math.round(q)) > 1e-9) return null;
      out[i]![j] = Math.round(q);
    }
  }
  return out as unknown as Mat3;
}

/**
 * Basis-change part of the conjugation: R' = P⁻¹·R·P (must be integral —
 * returns null when this basis does not apply to the rotation),
 * t' = P⁻¹·t = d·adj·t / det. Origin shifts are applied afterwards, in the
 * new basis.
 */
function changeBasis(op: SymmetryOperation, basis: BasisOption): SymmetryOperation | null {
  const rotation = changeRotation(op.rotation, basis);
  if (!rotation) return null;
  const translation = mulVec3(basis.adj, op.translation).map((x) => (basis.d * x) / basis.det) as unknown as Vec3;
  return {
    rotation,
    translation,
    xyz: formatOperationXyz(rotation, translation),
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

/** One column of P as "b", "-a", "a+2b", "(a-b)/2", "(a+b+2c)/2", … */
function describeColumn(col: Vec3): string {
  const d =
    DENOMINATORS.find((k) => col.every((x) => Math.abs(x * k - Math.round(x * k)) < 1e-9)) ?? 1;
  const terms: string[] = [];
  for (let i = 0; i < 3; i++) {
    const v = Math.round(col[i]! * d);
    if (v === 0) continue;
    const mag = Math.abs(v) === 1 ? "" : String(Math.abs(v));
    terms.push(`${v < 0 ? "-" : terms.length > 0 ? "+" : ""}${mag}${AXES[i]!}`);
  }
  const body = terms.join("") || "0";
  return d === 1 ? body : `(${body})/${d}`;
}

/** Describe P by its columns plus the origin shift. */
function describeTransformation(P: Mat3, p: Vec3): string {
  const cols = [0, 1, 2].map((j) => describeColumn([P[0]![j]!, P[1]![j]!, P[2]![j]!]));
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
 * permutation, an orthohexagonal (C-centred, det-2) cell, a sub-cell of an
 * F cubic lattice (I tetragonal/orthorhombic, obverse-hexagonal R, C
 * monoclinic, primitive triclinic) or the hexagonal cell of a rhombohedral
 * lattice, plus a ¼-grid origin shift**: conjugate
 * the operation set by each candidate (P, p), expand the translation cosets
 * the new cell requires, and look for an exact table match. Returns the
 * identity plus the transformation that produced the match (`direct` when
 * none was needed), or null when no setting in the family matches — a wrong
 * symbol is still worse than none.
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
      P: IDENTITY,
      originShift: [0, 0, 0],
    };
  }
  const rotations = rotationLookup!; // built by identifyMagneticGroup above

  // Lattice translations of the group: its pure unprimed translations. A
  // fractional cell is a cell of this lattice only if its basis vectors are
  // among them.
  const centrings = new Set<string>();
  for (const op of ops) {
    if (isIdentityMat(op.rotation) && (op.timeReversal ?? 1) === 1) centrings.add(vecKey(op.translation));
  }
  // One representative per (rotation, θ): the part of the group that neither
  // a centring expansion nor an origin shift changes.
  const rotationReps = new Map<string, SymmetryOperation>();
  for (const op of ops) {
    const k = rotationThetaKey(op.rotation, op.timeReversal ?? 1);
    if (!rotationReps.has(k)) rotationReps.set(k, op);
  }

  for (const basis of basisOptions()) {
    if (basis.fractionalColumns.some((c) => !centrings.has(vecKey(c)))) continue;
    // Necessary condition, cheap: the transformed rotation set is tabulated.
    const keys: string[] = [];
    let applies = true;
    for (const op of rotationReps.values()) {
      const R = changeRotation(op.rotation, basis);
      if (!R) { applies = false; break; } // rotation not integral in this cell
      keys.push(rotationThetaKey(R, op.timeReversal ?? 1));
    }
    if (!applies || !rotations.has(rotationSignature(keys))) continue;

    // Full conjugation, expanded with the cosets the old integer translations
    // occupy in the new cell and deduplicated modulo the new lattice (a
    // sub-cell collapses the old centring cosets).
    const reps = new Map<string, SymmetryOperation>();
    for (const op of ops) {
      const t = changeBasis(op, basis);
      if (!t) { applies = false; break; }
      for (const c of basis.centerings) {
        const shifted = isZeroVec(c)
          ? t
          : {
              ...t,
              translation: [
                t.translation[0]! + c[0]!,
                t.translation[1]! + c[1]!,
                t.translation[2]! + c[2]!,
              ] as Vec3,
            };
        const k = magneticOpKey(shifted);
        if (!reps.has(k)) reps.set(k, shifted);
      }
    }
    if (!applies) continue;
    const base = [...reps.values()];
    for (const p of originShifts()) {
      if (isZeroVec(p) && basis.identity) continue; // the untransformed set was already tried above
      const shifted = isZeroVec(p) ? base : base.map((op) => shiftOrigin(op, p));
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
