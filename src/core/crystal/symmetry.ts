/**
 * Symmetry operations: parsing Jones-Faithful strings (as found in CIF
 * `_space_group_symop_operation_xyz` loops), applying them, expanding an
 * asymmetric unit to the full cell, computing site multiplicity, and testing
 * systematic absences.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { mulMat, mulVec } from "@/core/math/mat3";
import { wrapFractional } from "@/core/math/vec3";

const AXES = ["x", "y", "z"] as const;

/** Parse a single component like "1/2+x-y" into a row [cx, cy, cz] and translation. */
function parseComponent(raw: string): { row: Vec3; translation: number } {
  // Normalize: remove spaces, ensure leading sign for tokenization.
  const s = raw.replace(/\s+/g, "").toLowerCase();
  const tokens = s.match(/[+-]?[^+-]+/g);
  if (!tokens) {
    throw new Error(`Cannot parse symmetry component: "${raw}"`);
  }
  const row: [number, number, number] = [0, 0, 0];
  let translation = 0;

  for (const token of tokens) {
    const axisIndex = AXES.findIndex((ax) => token.includes(ax));
    if (axisIndex >= 0) {
      // Coefficient on an axis, e.g. "-x", "+2x", "x".
      const coeffStr = token.replace(AXES[axisIndex]!, "").replace("*", "");
      let coeff: number;
      if (coeffStr === "" || coeffStr === "+") coeff = 1;
      else if (coeffStr === "-") coeff = -1;
      else coeff = parseFloat(coeffStr);
      row[axisIndex] = row[axisIndex]! + coeff;
    } else {
      // Pure translation, possibly a fraction like "1/2" or "-1/3".
      if (token.includes("/")) {
        const [num, den] = token.split("/");
        translation += parseFloat(num!) / parseFloat(den!);
      } else {
        translation += parseFloat(token);
      }
    }
  }
  return { row, translation };
}

/** Parse a Jones-Faithful string such as "x-y,x,1/2+z" into a SymmetryOperation. */
export function parseSymmetryOperation(xyz: string): SymmetryOperation {
  const parts = xyz.split(",");
  if (parts.length !== 3) {
    throw new Error(`Symmetry op must have 3 components: "${xyz}"`);
  }
  const parsed = parts.map(parseComponent);
  const rotation: Mat3 = [parsed[0]!.row, parsed[1]!.row, parsed[2]!.row];
  const translation: Vec3 = [
    parsed[0]!.translation,
    parsed[1]!.translation,
    parsed[2]!.translation,
  ];
  return { rotation, translation, xyz: xyz.replace(/\s+/g, "") };
}

/**
 * Parse a magnetic (BNS) operation string such as "-x,1/2+y,-z,-1": the first
 * three components are the spatial operation, the trailing ±1 is the
 * time-reversal flag.
 */
export function parseMagneticSymmetryOperation(xyz: string): SymmetryOperation {
  const parts = xyz.split(",");
  if (parts.length !== 4) {
    throw new Error(`Magnetic symmetry op must have 4 fields (x,y,z,±1): "${xyz}"`);
  }
  const spatial = parseSymmetryOperation(parts.slice(0, 3).join(","));
  const flag = parts[3]!.trim();
  const timeReversal: 1 | -1 = flag.startsWith("-") ? -1 : 1;
  // `xyz` keeps the SPATIAL string only — the flag lives in `timeReversal`,
  // matching generated ops (formatOperationXyz). Storing the 4-field string
  // here made the mCIF exporter (which appends the flag) emit "x,y,z,+1,+1"
  // and leaked ",+1" into nuclear symop loops.
  return { ...spatial, timeReversal };
}

/** Compose two operations: (a∘b)(x) = a(b(x)). Translations wrapped into [0,1). */
export function composeOperations(a: SymmetryOperation, b: SymmetryOperation): SymmetryOperation {
  const rotation = mulMat(a.rotation, b.rotation);
  const rb = mulVec(a.rotation, b.translation);
  const translation = wrapFractional([
    rb[0] + a.translation[0],
    rb[1] + a.translation[1],
    rb[2] + a.translation[2],
  ]);
  const timeReversal: 1 | -1 =
    ((a.timeReversal ?? 1) * (b.timeReversal ?? 1)) as 1 | -1;
  return { rotation, translation, xyz: formatOperationXyz(rotation, translation), timeReversal };
}

/** A canonical key (rotation + wrapped translation) for comparing operations mod lattice. */
export function operationKey(op: SymmetryOperation): string {
  const t = wrapFractional(op.translation);
  const r = op.rotation.map((row) => row.map((v) => Math.round(v)).join(",")).join(";");
  const tt = t.map((v) => Math.round(((v % 1) + 1) % 1 === 0 ? 0 : v * 12) / 12).join(",");
  return `${r}|${tt}`;
}

const AXIS_NAMES = ["x", "y", "z"] as const;

/** Render a rotation+translation back to a Jones-Faithful string. */
export function formatOperationXyz(rotation: Mat3, translation: Vec3): string {
  const frac = (v: number): string => {
    if (Math.abs(v) < 1e-6) return "";
    const twelfths = Math.round(v * 12);
    const map: Record<number, string> = { 6: "1/2", 4: "1/3", 8: "2/3", 3: "1/4", 9: "3/4", 2: "1/6", 10: "5/6" };
    return map[((twelfths % 12) + 12) % 12] ?? v.toFixed(3);
  };
  return rotation
    .map((row, i) => {
      const parts: string[] = [];
      for (let j = 0; j < 3; j++) {
        const c = row[j]!;
        if (Math.abs(c) < 1e-6) continue;
        const sign = c < 0 ? "-" : parts.length ? "+" : "";
        const mag = Math.abs(c);
        parts.push(`${sign}${mag === 1 ? "" : mag}${AXIS_NAMES[j]}`);
      }
      const t = frac(translation[i]!);
      if (t) parts.push(`${parts.length ? "+" : ""}${t}`);
      return parts.join("") || "0";
    })
    .join(",");
}

/** Apply an operation to a fractional coordinate: x' = R·x + t (not wrapped). */
export function applyOperation(op: SymmetryOperation, pos: Vec3): Vec3 {
  const rotated = mulVec(op.rotation, pos);
  return [
    rotated[0] + op.translation[0],
    rotated[1] + op.translation[1],
    rotated[2] + op.translation[2],
  ];
}

function almostEqualFractional(a: Vec3, b: Vec3, tol = 1e-5): boolean {
  for (let i = 0; i < 3; i++) {
    let diff = Math.abs(a[i]! - b[i]!);
    diff = Math.min(diff, 1 - diff); // periodic distance
    if (diff > tol) return false;
  }
  return true;
}

/**
 * Generate the distinct equivalent positions of a site under a set of
 * operations (wrapped into the unit cell). The count is the site multiplicity.
 */
export function equivalentPositions(
  ops: readonly SymmetryOperation[],
  pos: Vec3,
  // Coarser than machine tolerance: special positions must still be detected
  // when coordinates are rounded (as in refined CIF/GSAS output).
  tol = 1e-3,
): Vec3[] {
  const result: Vec3[] = [];
  for (const op of ops) {
    const p = wrapFractional(applyOperation(op, pos));
    if (!result.some((q) => almostEqualFractional(q, p, tol))) {
      result.push(p);
    }
  }
  return result;
}

/** Site multiplicity = number of distinct equivalent positions. */
export function siteMultiplicity(
  ops: readonly SymmetryOperation[],
  pos: Vec3,
  tol = 1e-3,
): number {
  return equivalentPositions(ops, pos, tol).length;
}

/** Whether `op` maps `pos` onto itself modulo a lattice translation. */
function fixesSite(op: SymmetryOperation, pos: Vec3, tol = 1e-3): boolean {
  const p = wrapFractional(applyOperation(op, pos));
  const q = wrapFractional(pos);
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(p[i]! - q[i]!);
    d = Math.min(d, 1 - d);
    if (d > tol) return false;
  }
  return true;
}

/** The site-symmetry group (stabilizer): the operations fixing `position`. */
export function siteStabilizer(operations: readonly SymmetryOperation[], position: Vec3): SymmetryOperation[] {
  return operations.filter((op) => fixesSite(op, position));
}

/**
 * Systematic-absence test: a reflection is absent if any operation maps (hkl)
 * onto itself (in reciprocal space) but the associated phase shift
 * 2π(h·t) is not a multiple of 2π. Uses the standard rule
 *   (hkl) is present iff for every op with (h'k'l') = (hkl)·R, h·t ∈ ℤ.
 */
export function isReflectionAbsent(
  ops: readonly SymmetryOperation[],
  h: number,
  k: number,
  l: number,
  tol = 1e-4,
): boolean {
  const hkl: Vec3 = [h, k, l];
  for (const op of ops) {
    // Transformed indices: h'·x = h·(R x + t) ⇒ h' = Rᵀ·h.
    const hp: Vec3 = [
      op.rotation[0][0] * hkl[0] + op.rotation[1][0] * hkl[1] + op.rotation[2][0] * hkl[2],
      op.rotation[0][1] * hkl[0] + op.rotation[1][1] * hkl[1] + op.rotation[2][1] * hkl[2],
      op.rotation[0][2] * hkl[0] + op.rotation[1][2] * hkl[1] + op.rotation[2][2] * hkl[2],
    ];
    if (
      Math.abs(hp[0] - h) < tol &&
      Math.abs(hp[1] - k) < tol &&
      Math.abs(hp[2] - l) < tol
    ) {
      const phase =
        h * op.translation[0] + k * op.translation[1] + l * op.translation[2];
      const frac = phase - Math.round(phase);
      if (Math.abs(frac) > tol) {
        return true; // maps onto itself with non-integer phase ⇒ absent
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Centred lattices
//
// A conventional centred cell (A, B, C, I, F, or R in the hexagonal setting)
// lists its centring translations as identity-rotation operations, so the
// operation list is G modulo the INTEGER translations ℤ³, not modulo the true
// lattice Λ = ℤ³ + {centrings}. Everything that depends on the lattice — the
// reciprocal lattice Λ* (a sublattice of ℤ³), the phase e^{2πi k·t} a lattice
// translation t carries in a k ≠ 0 magnetic structure, and "the same site
// modulo a lattice translation" — must use Λ, not ℤ³. These helpers are the one
// place that knowledge lives.
// ---------------------------------------------------------------------------

const CENTRING_TOL = 1e-6;

/** Snap to the 1/12 grid every crystallographic translation lives on (0, ¼, ⅓, ½, ⅔, ¾ …). */
function snap12(v: number): number {
  const r = Math.round(v * 12) / 12;
  return Math.abs(v - r) < 1e-3 ? (r === 0 ? 0 : r) : v;
}

function snapWrap(v: number): number {
  const w = snap12(v - Math.floor(v));
  return w > 1 - CENTRING_TOL || w < CENTRING_TOL ? 0 : w;
}

/**
 * A lattice vector with its components snapped to the 1/12 grid: a returning
 * translation computed as a difference of refined coordinates (0.6667 − 0.3333)
 * must enter a k-phase as exactly ⅓, not 0.3334, or cos/sin of the phase
 * leave 1e-4 residues where the constraint machinery expects exact zeros.
 */
export function snapLatticeVector(d: Vec3): Vec3 {
  return [snap12(d[0]!), snap12(d[1]!), snap12(d[2]!)];
}

function isIdentityRotation(R: Mat3): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (R[i]![j] !== (i === j ? 1 : 0)) return false;
  return true;
}

const centringCache = new WeakMap<readonly SymmetryOperation[], Vec3[]>();

/**
 * Centring translations of a complete operation list: the non-zero
 * translations (mod 1) of its identity-rotation operations — (0,½,½), (½,0,½),
 * (½,½,0) for F; (½,½,½) for I; (½,½,0) for C; (⅔,⅓,⅓), (⅓,⅔,⅔) for an
 * obverse R in the hexagonal setting. Empty for a primitive lattice, and for a
 * list holding only coset representatives.
 *
 * Only UNPRIMED translations count: a primed identity-rotation operation is an
 * anti-translation of a black-and-white (type-IV) magnetic group, a genuine
 * group element with θ = −1 and not a translation of the magnetic lattice —
 * it stays a stabilizer element in the moment constraints and gets no lattice
 * phase.
 */
export function centringTranslations(ops: readonly SymmetryOperation[]): Vec3[] {
  const cached = centringCache.get(ops);
  if (cached) return cached;
  const out: Vec3[] = [];
  for (const op of ops) {
    if (!isIdentityRotation(op.rotation) || (op.timeReversal ?? 1) !== 1) continue;
    const t: Vec3 = [snapWrap(op.translation[0]!), snapWrap(op.translation[1]!), snapWrap(op.translation[2]!)];
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) continue;
    if (!out.some((u) => almostEqualFractional(u, t))) out.push(t);
  }
  centringCache.set(ops, out);
  return out;
}

/**
 * True when the direct-space vector `d` is a lattice translation of the
 * (possibly centred) lattice: an integer vector, or an integer vector plus a
 * centring translation.
 */
export function isLatticeVector(d: Vec3, centrings: readonly Vec3[], tol = 1e-3): boolean {
  const f = wrapFractional(d);
  if (almostEqualFractional(f, [0, 0, 0], tol)) return true;
  return centrings.some((t) => almostEqualFractional(f, t, tol));
}

/**
 * True when the reciprocal-space vector `v` (conventional reciprocal units)
 * belongs to the reciprocal lattice Λ* of the centred cell: integer components
 * with v·t an integer for every centring translation t — F: h, k, l all even
 * or all odd; I: h+k+l even; C: h+k even; obverse R: −h+k+l ≡ 0 (mod 3). For a
 * primitive lattice this is just "integer".
 */
export function isReciprocalLatticeVector(v: Vec3, centrings: readonly Vec3[], tol = 1e-6): boolean {
  for (let i = 0; i < 3; i++) if (Math.abs(v[i]! - Math.round(v[i]!)) > tol) return false;
  for (const t of centrings) {
    const p = v[0]! * t[0]! + v[1]! * t[1]! + v[2]! * t[2]!;
    if (Math.abs(p - Math.round(p)) > tol) return false;
  }
  return true;
}

const offsetCache = new WeakMap<readonly SymmetryOperation[], Vec3[]>();

/** Lexicographic order of two wrapped translations, with a tolerance. */
function translationBefore(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (Math.abs(d) > CENTRING_TOL) return d < 0;
  }
  return false;
}

/**
 * The centring offset c(g) of every operation of the list: the centring
 * translation by which g differs from the **representative** of its rotation
 * class, g = {I|c(g)}·rep (mod ℤ³). The representative is the class member
 * with the lexicographically smallest wrapped translation — the (0,0,0)+ block
 * operation of an ITA-ordered list — so the choice does not depend on list
 * order and agrees between a parent list, its little group, and a magnetic
 * candidate built from it. Zero for every operation of a primitive group.
 * Classes are keyed by rotation AND θ, so two members of a class differ by an
 * unprimed translation (g·rep⁻¹ has θ = +1): an anti-translation of a
 * black-and-white group never becomes an offset.
 *
 * Why this matters: in a k ≠ 0 structure a lattice translation t multiplies a
 * site's Fourier coefficient by e^{−2πi k·t}. The integer part of a
 * translation is handled through the returning lattice translation of an
 * image; the centring part is only visible as this offset, so every consumer
 * of the k-phase (allowed moments, cell expansion, the structure factor, the
 * representation analysis) subtracts c(g) from the returning translation.
 */
export function centringOffsets(ops: readonly SymmetryOperation[]): Vec3[] {
  const cached = offsetCache.get(ops);
  if (cached) return cached;
  const wrapped = ops.map((op) => [snapWrap(op.translation[0]!), snapWrap(op.translation[1]!), snapWrap(op.translation[2]!)] as Vec3);
  const classKey = (op: SymmetryOperation): string =>
    `${op.rotation.map((row) => row.map((v) => Math.round(v)).join(",")).join(";")}|${op.timeReversal ?? 1}`;
  const rep = new Map<string, Vec3>();
  ops.forEach((op, i) => {
    const key = classKey(op);
    const cur = rep.get(key);
    if (!cur || translationBefore(wrapped[i]!, cur)) rep.set(key, wrapped[i]!);
  });
  const out = ops.map((op, i) => {
    const r = rep.get(classKey(op))!;
    return [snapWrap(wrapped[i]![0] - r[0]), snapWrap(wrapped[i]![1] - r[1]), snapWrap(wrapped[i]![2] - r[2])] as Vec3;
  });
  offsetCache.set(ops, out);
  return out;
}
