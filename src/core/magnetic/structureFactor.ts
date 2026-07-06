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
import { momentCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";

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

  for (const moment of magnetic.moments) {
    const site = structure.sites.find((st) => st.label === moment.siteLabel);
    if (!site) continue;
    const ffId = formFactorId(structure, moment.siteLabel, moment.formFactorId);
    const fMag = table.has(ffId) ? table.j0(ffId, s) : 1;
    const mCart = momentCartesian(structure.cell, moment);
    const mPerp = perpendicularMoment(mCart, q);

    for (const op of structure.spaceGroup.operations) {
      // Rotate the moment by the operation's rotation (axial vector).
      const r = op.rotation;
      const rm: [number, number, number] = [
        r[0][0] * mPerp[0] + r[0][1] * mPerp[1] + r[0][2] * mPerp[2],
        r[1][0] * mPerp[0] + r[1][1] * mPerp[1] + r[1][2] * mPerp[2],
        r[2][0] * mPerp[0] + r[2][1] * mPerp[1] + r[2][2] * mPerp[2],
      ];
      const p = applyOperation(op, site.position);
      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      const ph = expι(phase);
      const w = MAGNETIC_PREFACTOR * site.occupancy * fMag;
      fx = add(fx, cscale(ph, w * rm[0]));
      fy = add(fy, cscale(ph, w * rm[1]));
      fz = add(fz, cscale(ph, w * rm[2]));
    }
  }

  const squared =
    fx.re * fx.re + fx.im * fx.im +
    fy.re * fy.re + fy.im * fy.im +
    fz.re * fz.re + fz.im * fz.im;

  return { vector: [fx, fy, fz], squared };
}
