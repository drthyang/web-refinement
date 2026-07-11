/**
 * Absorption transmission factor for a single crystal of arbitrary convex
 * shape, by Gaussian numerical integration over the crystal volume.
 *
 * For a reflection with incident beam direction ŝ₀ and diffracted beam
 * direction ŝ, the transmission factor is the volume-averaged attenuation
 *
 *   A = (1/V) ∫_V exp(−μ·(L_in(r) + L_out(r))) dV ,   A ∈ (0, 1]
 *
 * where L_in is the path from the entry surface to r (measured back along −ŝ₀)
 * and L_out the path from r to the exit surface (along ŝ). A multiplies the
 * ideal (absorption-free) intensity, matching the convention of the existing
 * powder cylinderAbsorption. A → 1 as μ → 0.
 *
 * The integral is evaluated by tensor-product Gauss–Legendre quadrature over
 * the shape's bounding box, masking nodes that fall outside the convex body;
 * the bounding-box Jacobian cancels in the A = numerator/denominator ratio, so
 * A is exactly the volume average. For an axis-aligned box with a smooth
 * integrand this is spectrally accurate; a face-decomposition (tetrahedral)
 * quadrature is a future accuracy upgrade for strongly-absorbing awkward habits.
 *
 * Units: μ and the shape's dimensions must use reciprocal length units
 * (e.g. μ in mm⁻¹ with the shape in mm). See neutronAbsorption.ts for μ.
 */

import type { Vec3 } from "@/core/math/types";
import { normalize, scale } from "@/core/math/vec3";
import { gaussLegendre } from "@/core/math/quadrature";
import { exitDistance, isInside, type ConvexShape } from "@/core/absorption/shape";

export interface TransmissionOptions {
  /** Gauss–Legendre points per axis (default 24). Higher = more accurate/slower. */
  readonly gaussPoints?: number;
}

/**
 * Transmission factor A ∈ (0, 1] for a crystal `shape` with linear absorption
 * coefficient `mu`, incident beam direction `incident`, and diffracted beam
 * direction `diffracted` (directions of propagation; normalised internally).
 */
export function transmissionFactor(
  shape: ConvexShape,
  mu: number,
  incident: Vec3,
  diffracted: Vec3,
  options: TransmissionOptions = {},
): number {
  if (mu <= 0) return 1; // no absorption ⇒ full transmission
  const n = options.gaussPoints ?? 24;
  const { nodes, weights } = gaussLegendre(n);

  // Beam back along −ŝ₀ gives the incident path; ŝ gives the diffracted path.
  const back = scale(normalize(incident), -1);
  const out = normalize(diffracted);

  // Map the [−1, 1] nodes onto each bounding-box axis.
  const axis = (lo: number, hi: number): number[] =>
    nodes.map((t) => lo + ((hi - lo) * (t + 1)) / 2);
  const xs = axis(shape.min[0], shape.max[0]);
  const ys = axis(shape.min[1], shape.max[1]);
  const zs = axis(shape.min[2], shape.max[2]);

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const wxy = weights[i]! * weights[j]!;
      for (let k = 0; k < n; k++) {
        const p: Vec3 = [xs[i]!, ys[j]!, zs[k]!];
        if (!isInside(shape, p)) continue;
        const w = wxy * weights[k]!;
        const path = exitDistance(shape, p, back) + exitDistance(shape, p, out);
        numerator += w * Math.exp(-mu * path);
        denominator += w;
      }
    }
  }

  if (denominator === 0) {
    throw new Error(
      "transmissionFactor: no quadrature nodes fell inside the shape; increase gaussPoints or check the bounding box",
    );
  }
  return numerator / denominator;
}
