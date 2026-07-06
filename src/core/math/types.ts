/**
 * Small linear-algebra primitives shared across the scientific core.
 *
 * These are plain data types (not classes) so they serialize cleanly into the
 * project file and cross the worker boundary without custom (de)serialization.
 * Operations on them live in sibling modules (e.g. `vec3.ts`, `mat3.ts`) as
 * pure functions, per the "no methods on data models" rule.
 */

/** A 3-vector, `[x, y, z]`. Interpretation (fractional vs Cartesian) is contextual. */
export type Vec3 = readonly [number, number, number];

/**
 * A 3×3 matrix in row-major order: `[[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]]`.
 * Used for the fractional↔Cartesian basis, metric tensors, and symmetry rotations.
 */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

/** A complex number, `re + i·im`. Structure factors are complex-valued. */
export interface Complex {
  readonly re: number;
  readonly im: number;
}
