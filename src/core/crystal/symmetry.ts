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
  return { ...spatial, xyz: xyz.replace(/\s+/g, ""), timeReversal };
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
