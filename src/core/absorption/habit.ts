/**
 * Crystal habit: a convex crystal described the crystallographic way — by its
 * bounding faces' Miller indices and central distances — converted into the
 * geometric ConvexShape the transmission engine integrates over.
 *
 * A face (hkl) is perpendicular to the reciprocal-lattice vector
 * d*_hkl = h·a* + k·b* + l·c*. In the Cartesian setting (a ∥ x, standard
 * orthogonalisation) its outward unit normal is (M⁻¹)ᵀ·(h,k,l) normalised, where
 * M is the cell's orthogonalisation matrix (Cartesian = M·fractional). The
 * central distance is the perpendicular distance from the crystal centre (the
 * origin) to the face, in the length unit the correction uses — mm for real
 * crystals, and it must match the unit of μ (see transmission.ts).
 *
 * This is the representation both correction front-ends target: a photo
 * reconstruction indexes the observed faces, and the symmetry route expands a
 * face family through the point group. Both end up as {(hkl, distance)} lists.
 */

import type { SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { inverse, transpose, mulVec, determinant } from "@/core/math/mat3";
import { dot, normalize } from "@/core/math/vec3";
import type { ConvexShape, Face } from "@/core/absorption/shape";

/** A crystal face: its Miller indices and central distance from the centre. */
export interface CrystalFace {
  /** Miller indices (h, k, l) of the face. */
  readonly hkl: Vec3;
  /** Perpendicular distance from the crystal centre to the face (length unit). */
  readonly distance: number;
}

/**
 * A crystal form: a representative face {hkl} standing for its whole symmetry-
 * equivalent family, and the central distance the family shares. This is how a
 * habit is described in practice — e.g. the cube form {100} at 0.3 mm.
 */
export interface CrystalForm {
  /** A representative face of the form. */
  readonly hkl: Vec3;
  /** Central distance shared by every face in the family (length unit). */
  readonly distance: number;
}

/** Outward unit normal of face (hkl) in the cell's Cartesian frame. */
export function faceNormalCartesian(cell: UnitCell, hkl: Vec3): Vec3 {
  const reciprocalToCartesian = transpose(inverse(orthogonalizationMatrix(cell)));
  return normalize(mulVec(reciprocalToCartesian, hkl));
}

/**
 * Build a convex crystal shape from its crystallographic faces and cell. Each
 * face becomes a bounding half-space; the bounding box is derived from the
 * polyhedron vertices (feasible intersections of face triples). Throws if the
 * faces do not enclose a bounded volume.
 */
export function crystalHabit(cell: UnitCell, faces: readonly CrystalFace[]): ConvexShape {
  if (faces.length < 4) {
    throw new Error("a bounded crystal habit needs at least 4 faces");
  }
  const reciprocalToCartesian = transpose(inverse(orthogonalizationMatrix(cell)));
  const planes: Face[] = faces.map((f) => ({
    normal: normalize(mulVec(reciprocalToCartesian, f.hkl)),
    offset: f.distance,
  }));

  const vertices = enumerateVertices(planes);
  if (vertices.length < 4) {
    throw new Error("crystal habit is unbounded or degenerate — faces must enclose a volume");
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let a = 0; a < 3; a++) {
      if (v[a]! < min[a]!) min[a] = v[a]!;
      if (v[a]! > max[a]!) max[a] = v[a]!;
    }
  }
  return { faces: planes, min, max };
}

/**
 * The star of (hkl): every symmetry-equivalent Miller index under the point
 * group (the rotation parts of the given operations). Each operation R maps a
 * reflection by h' = (R⁻¹)ᵀ·h; the union over the group is the face family.
 */
export function expandFaceFamily(operations: readonly SymmetryOperation[], hkl: Vec3): Vec3[] {
  const seen = new Map<string, Vec3>();
  for (const op of operations) {
    const mapped = mulVec(transpose(inverse(op.rotation)), hkl);
    const rounded: Vec3 = [Math.round(mapped[0]), Math.round(mapped[1]), Math.round(mapped[2])];
    seen.set(rounded.join(","), rounded);
  }
  return [...seen.values()];
}

/**
 * Build a habit from crystal forms: each form is expanded to its full face
 * family through the point group, and all faces of a family sit at the form's
 * shared distance. The natural crystallographic way to specify a shape.
 */
export function crystalHabitFromForms(
  cell: UnitCell,
  operations: readonly SymmetryOperation[],
  forms: readonly CrystalForm[],
): ConvexShape {
  const faces: CrystalFace[] = [];
  for (const form of forms) {
    for (const hkl of expandFaceFamily(operations, form.hkl)) {
      faces.push({ hkl, distance: form.distance });
    }
  }
  return crystalHabit(cell, faces);
}

/** Corner points of the convex body: feasible intersections of face triples. */
function enumerateVertices(planes: readonly Face[]): Vec3[] {
  const scale = Math.max(...planes.map((p) => Math.abs(p.offset)), 1);
  const feasEps = 1e-6 * scale;
  const dupEps = 1e-9 * scale;
  const vertices: Vec3[] = [];

  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const a = planes[i]!.normal;
        const b = planes[j]!.normal;
        const c = planes[k]!.normal;
        const m: Mat3 = [a, b, c];
        if (Math.abs(determinant(m)) < 1e-9) continue; // near-parallel planes
        const p = mulVec(inverse(m), [planes[i]!.offset, planes[j]!.offset, planes[k]!.offset]);
        if (!planes.every((pl) => dot(pl.normal, p) <= pl.offset + feasEps)) continue;
        if (!vertices.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < dupEps)) {
          vertices.push(p);
        }
      }
    }
  }
  return vertices;
}
