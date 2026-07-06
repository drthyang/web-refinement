/**
 * Magnetic moment geometry: converting moment components to a Cartesian frame,
 * the scattering vector Q in Cartesian, and the perpendicular-moment projection
 * that governs magnetic neutron scattering.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { UnitCell } from "@/core/crystal/types";
import type { MagneticMoment } from "@/core/magnetic/types";
import { orthogonalizationMatrix } from "@/core/crystal/unitCell";
import { inverse, mulVec, transpose } from "@/core/math/mat3";
import { dot, norm, normalize, scale, sub } from "@/core/math/vec3";

/**
 * Q vector in the Cartesian frame (Å⁻¹), including the 2π factor:
 *   Q = 2π · (M⁻¹)ᵀ · (h, k, l)
 * where M is the fractional→Cartesian orthogonalization matrix.
 */
export function qCartesian(cell: UnitCell, h: number, k: number, l: number): Vec3 {
  const m = orthogonalizationMatrix(cell);
  const reciprocalCart = transpose(inverse(m));
  const q = mulVec(reciprocalCart, [h, k, l]);
  return scale(q, 2 * Math.PI);
}

/**
 * Moment vector in the Cartesian frame (μ_B).
 *  - "cartesian": components are already Cartesian.
 *  - "crystallographic": components are along the normalized direct lattice
 *    directions (â, b̂, ĉ). For orthogonal cells this is the identity; for
 *    oblique cells it is a documented simplification (see LIMITATIONS.md).
 */
export function momentCartesian(cell: UnitCell, moment: MagneticMoment): Vec3 {
  if (moment.frame === "cartesian") {
    return moment.components;
  }
  const m = orthogonalizationMatrix(cell);
  // Columns of M are a, b, c in Cartesian; normalize each to a direction.
  const cols: Mat3 = transpose(m);
  const ahat = normalize(cols[0]);
  const bhat = normalize(cols[1]);
  const chat = normalize(cols[2]);
  const [mx, my, mz] = moment.components;
  return [
    mx * ahat[0] + my * bhat[0] + mz * chat[0],
    mx * ahat[1] + my * bhat[1] + mz * chat[1],
    mx * ahat[2] + my * bhat[2] + mz * chat[2],
  ];
}

/**
 * Perpendicular-moment projection: the component of M perpendicular to the
 * scattering direction q̂. Only M⊥ contributes to magnetic scattering.
 *   M⊥ = M − q̂ (M · q̂)
 */
export function perpendicularMoment(moment: Vec3, q: Vec3): Vec3 {
  if (norm(q) === 0) return moment;
  const qhat = normalize(q);
  return sub(moment, scale(qhat, dot(moment, qhat)));
}
