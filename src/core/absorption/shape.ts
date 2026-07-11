/**
 * Convex crystal shape as an intersection of half-spaces — the geometry the
 * absorption transmission integral is evaluated over.
 *
 * A crystal habit is a convex polyhedron bounded by planar faces (each with a
 * Miller index, in the eventual face-indexing workflow). Here a shape is just
 * its set of outward-oriented face planes plus an axis-aligned bounding box for
 * volume sampling; the interior is {r : nᵢ·r ≤ dᵢ for every face i}.
 *
 * Lengths are unitless here — the caller fixes the unit (mm is natural for real
 * crystals) and must supply μ in the reciprocal unit; see transmission.ts.
 */

import type { Vec3 } from "@/core/math/types";
import { dot, normalize } from "@/core/math/vec3";

/** One bounding plane of a convex shape: interior side is `normal·r ≤ offset`. */
export interface Face {
  /** Outward unit normal. */
  readonly normal: Vec3;
  /** Signed plane offset along the normal (distance from origin when normal is unit). */
  readonly offset: number;
}

/** A convex polyhedron: its face planes and an axis-aligned bounding box. */
export interface ConvexShape {
  readonly faces: readonly Face[];
  /** Bounding-box minimum corner, for placing the sampling grid. */
  readonly min: Vec3;
  /** Bounding-box maximum corner. */
  readonly max: Vec3;
}

/** True if `p` is inside (or within `eps` of) every face plane. */
export function isInside(shape: ConvexShape, p: Vec3, eps = 1e-9): boolean {
  return shape.faces.every((f) => dot(f.normal, p) <= f.offset + eps);
}

/**
 * Distance from an interior point `p` to the shape boundary along unit direction
 * `u` — i.e. how far a ray travels inside the crystal before exiting. Found as
 * the nearest forward face intersection. Assumes `p` is inside and `u` is unit.
 */
export function exitDistance(shape: ConvexShape, p: Vec3, u: Vec3): number {
  let t = Infinity;
  for (const f of shape.faces) {
    const nu = dot(f.normal, u);
    if (nu > 1e-12) {
      // Ray reaches this face at nᵢ·(p + t·u) = dᵢ ⇒ t = (dᵢ − nᵢ·p)/(nᵢ·u).
      const ti = (f.offset - dot(f.normal, p)) / nu;
      if (ti < t) t = ti;
    }
  }
  return t;
}

/** Rectangular box of full edge lengths `size = [Lx, Ly, Lz]`, centred at the origin. */
export function boxShape(size: Vec3): ConvexShape {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  return {
    faces: [
      { normal: [1, 0, 0], offset: hx },
      { normal: [-1, 0, 0], offset: hx },
      { normal: [0, 1, 0], offset: hy },
      { normal: [0, -1, 0], offset: hy },
      { normal: [0, 0, 1], offset: hz },
      { normal: [0, 0, -1], offset: hz },
    ],
    min: [-hx, -hy, -hz],
    max: [hx, hy, hz],
  };
}

/**
 * Regular octahedron |x| + |y| + |z| ≤ r, centred at the origin — a non
 * axis-aligned test habit whose bounding box is larger than the body, so the
 * volume sampler must actually mask points outside the faces.
 */
export function octahedronShape(r: number): ConvexShape {
  const faces: Face[] = [];
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        faces.push({ normal: normalize([sx, sy, sz]), offset: r / Math.sqrt(3) });
      }
    }
  }
  return { faces, min: [-r, -r, -r], max: [r, r, r] };
}

/**
 * Build a convex shape from explicit face planes (outward normals, not
 * necessarily unit) and an axis-aligned bounding box. Normals are normalised so
 * `offset` is a true perpendicular distance. This is the constructor the
 * face-indexing / photo-reconstruction front-ends will target.
 */
export function shapeFromFaces(
  faces: readonly Face[],
  min: Vec3,
  max: Vec3,
): ConvexShape {
  return {
    faces: faces.map((f) => {
      const len = Math.hypot(f.normal[0], f.normal[1], f.normal[2]);
      return { normal: normalize(f.normal), offset: f.offset / len };
    }),
    min,
    max,
  };
}
