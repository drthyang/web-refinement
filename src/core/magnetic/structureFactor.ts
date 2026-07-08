/**
 * Magnetic structure factor (simplified, dipole approximation):
 *
 *   F_M(hkl) = p · Σ_j f_mag,j(s) · M⊥,j · exp[2πi(h·x_j + k·y_j + l·z_j)]
 *
 * F_M is a complex vector; the magnetic intensity is |F_M|² summed over its
 * three Cartesian components. The constant p = 0.2695 fm/μ_B converts moment
 * (μ_B) to a neutron scattering length so nuclear and magnetic intensities are
 * on the same scale.
 *
 * Nuclear and magnetic contributions are kept strictly separate: this module
 * never touches nuclear code.
 */

import type { Complex } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { MagneticFormFactorTable } from "@/core/scattering/types";
import { add, expι, scale as cscale, ZERO } from "@/core/math/complex";
import { dSpacing } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";
import { magneticTable } from "@/core/scattering/magnetic";
import { crystalComponentsToCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";
import { determinant } from "@/core/math/mat3";

const TWO_PI = 2 * Math.PI;
/** Magnetic scattering length per Bohr magneton (fm/μ_B): (γ r_e)/2 · g/2. */
export const MAGNETIC_PREFACTOR = 0.2695;

/** Resolve the ⟨j0⟩ form-factor id for a moment (explicit, or element+ox state). */
function formFactorId(
  structure: StructureModel,
  siteLabel: string,
  explicitId: string | undefined,
): string {
  if (explicitId) return explicitId;
  const site = structure.sites.find((s) => s.label === siteLabel);
  if (!site) throw new Error(`Magnetic moment references unknown site "${siteLabel}"`);
  const ox = site.oxidationState ?? 2;
  return `${site.element}${ox}`;
}

export interface MagneticStructureFactor {
  /** Complex vector components (x, y, z) of F_M in Cartesian space. */
  readonly vector: readonly [Complex, Complex, Complex];
  /** |F_M|² = |Fx|² + |Fy|² + |Fz|². */
  readonly squared: number;
}

/**
 * Magnetic structure factor for one reflection. Expands each moment site over
 * the space-group operations (rotating the moment by the operation's rotation
 * part). Returns both the complex vector and |F_M|².
 */
export function magneticStructureFactor(
  structure: StructureModel,
  magnetic: MagneticModel,
  h: number,
  k: number,
  l: number,
  table: MagneticFormFactorTable = magneticTable,
): MagneticStructureFactor {
  const d = dSpacing(structure.cell, h, k, l);
  const s = d === Infinity ? 0 : 1 / (2 * d);
  const q = qCartesian(structure.cell, h, k, l);

  let fx = ZERO;
  let fy = ZERO;
  let fz = ZERO;

  // Expand each moment over the *magnetic* subgroup operations (θ-signed) when
  // the model carries them, deduplicating the crystallographic orbit; otherwise
  // fall back to the nuclear operations (legacy k = 0 / no-subgroup behaviour).
  // Expanding over the nuclear group with θ = 1 is a ferromagnetic arrangement:
  // it gives zero intensity at k ≠ 0 satellites and over-counts special positions.
  const ops = magnetic.operations ?? structure.spaceGroup.operations;
  const dedup = magnetic.operations !== undefined;

  for (const moment of magnetic.moments) {
    const site = structure.sites.find((st) => st.label === moment.siteLabel);
    if (!site) continue;
    const ffId = formFactorId(structure, moment.siteLabel, moment.formFactorId);
    const fMag = table.has(ffId) ? table.j0(ffId, s) : 1;
    const seen = dedup ? new Set<string>() : null;
    // A split-orbit moment (magnetic subgroup ⊂ nuclear group) expands from its
    // own orbit-representative position, not the site's asymmetric-unit one.
    const basePos = moment.position ?? site.position;

    for (const op of ops) {
      const p = applyOperation(op, basePos);
      if (seen) {
        // One atom per unique position in the cell (no special-position over-count).
        const key = p.map((v) => (((v % 1) + 1) % 1).toFixed(4)).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // Transform the moment as an axial vector in the crystal-axis frame:
      // m' = θ · det(R) · R · m (θ = time-reversal flag ±1), then convert to
      // Cartesian and project perpendicular to Q. Rotate-then-project matters:
      // the two operations do not commute for a general Q.
      const r = op.rotation;
      const axial = determinant(r) * (op.timeReversal ?? 1);
      const comps = moment.components;
      const rotatedComps: [number, number, number] = [
        axial * (r[0][0] * comps[0] + r[0][1] * comps[1] + r[0][2] * comps[2]),
        axial * (r[1][0] * comps[0] + r[1][1] * comps[1] + r[1][2] * comps[2]),
        axial * (r[2][0] * comps[0] + r[2][1] * comps[1] + r[2][2] * comps[2]),
      ];
      const mCart =
        moment.frame === "cartesian"
          ? rotatedComps
          : crystalComponentsToCartesian(structure.cell, rotatedComps);
      const mPerp = perpendicularMoment(mCart, q);

      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      const ph = expι(phase);
      const w = MAGNETIC_PREFACTOR * site.occupancy * fMag;
      fx = add(fx, cscale(ph, w * mPerp[0]));
      fy = add(fy, cscale(ph, w * mPerp[1]));
      fz = add(fz, cscale(ph, w * mPerp[2]));
    }
  }

  const squared =
    fx.re * fx.re + fx.im * fx.im +
    fy.re * fy.re + fy.im * fy.im +
    fz.re * fz.re + fz.im * fz.im;

  return { vector: [fx, fy, fz], squared };
}
