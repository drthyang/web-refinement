/**
 * Magnetic structure factor (spin-only ⟨j0⟩ form-factor approximation):
 *
 *   F_M(hkl) = p · Σ_j f_mag,j(s) · M⊥,j · exp[2πi(h·x_j + k·y_j + l·z_j)]
 *
 * F_M is a complex vector; the magnetic intensity is |F_M|² summed over its
 * three Cartesian components. The constant p = 2.695 fm/μ_B converts moment
 * (μ_B) to a neutron scattering length so nuclear and magnetic intensities are
 * on the same scale (nuclear b is tabulated in fm).
 *
 * Nuclear and magnetic contributions are kept strictly separate: this module
 * never touches nuclear code.
 */

import type { Complex, Vec3 } from "@/core/math/types";
import type { StructureModel, DisplacementParameters } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { MagneticFormFactorTable } from "@/core/scattering/types";
import { add, expι, scale as cscale, ZERO } from "@/core/math/complex";
import { dSpacing } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";
import { magneticTable } from "@/core/scattering/magnetic";
import { crystalComponentsToCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";
import { determinant } from "@/core/math/mat3";
import { anisotropicDebyeWaller, debyeWaller } from "@/core/diffraction/structureFactor";

const TWO_PI = 2 * Math.PI;
/**
 * Magnetic scattering length per Bohr magneton, in **fm/μ_B**:
 *   p = γ_n·r_e/2 = 1.91304 × 2.81794 fm / 2 = 2.695 fm/μ_B,
 * the same physical constant usually quoted as 0.2695 × 10⁻¹² cm/μ_B (since
 * 0.2695 × 10⁻¹² cm = 2.695 fm). It must be in fm here because the nuclear
 * scattering lengths it shares an intensity scale with are tabulated in fm
 * (see neutronData.ts). Reference: Squires, *Thermal Neutron Scattering*,
 * §7; Lovesey, *Theory of Neutron Scattering from Condensed Matter*, Vol. 2.
 */
export const MAGNETIC_PREFACTOR = 2.695;

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
 * One magnetic scatterer of the cell: a moment replicated to each DISTINCT orbit
 * position, carrying the op-rotated moment ALREADY in Cartesian (μ_B) and the
 * scattering properties needed downstream. This is precisely the (moment,
 * distinct-op) expansion `magneticStructureFactor` sums over — but with the
 * REFLECTION-INDEPENDENT parts pulled out (position, Cartesian moment, occupancy,
 * form factor, DW), so an off-core consumer (the WebGPU magnetic kernel) marshals
 * the identical atom list and applies only the per-reflection q̂ projection and
 * ⟨j0⟩(s) itself. No drift: same ops, same dedup, same axial transform.
 */
export interface ExpandedMagneticAtom {
  readonly position: Vec3;
  /** Op-rotated, axial-signed moment in the Cartesian frame (μ_B). */
  readonly momentCart: Vec3;
  readonly occupancy: number;
  readonly formFactorId: string;
  readonly adp: DisplacementParameters;
}

/** Expand a magnetic model over each moment's distinct orbit (see the type doc). */
export function expandMagneticAtoms(structure: StructureModel, magnetic: MagneticModel): ExpandedMagneticAtom[] {
  const ops = magnetic.operations ?? structure.spaceGroup.operations;
  const dedup = magnetic.operations !== undefined;
  const out: ExpandedMagneticAtom[] = [];
  for (const moment of magnetic.moments) {
    const site = structure.sites.find((st) => st.label === moment.siteLabel);
    if (!site) continue;
    const ffId = formFactorId(structure, moment.siteLabel, moment.formFactorId);
    const seen: Vec3[] | null = dedup ? [] : null;
    const basePos = moment.position ?? site.position;
    for (const op of ops) {
      const p = applyOperation(op, basePos);
      if (seen) {
        const wrapped: Vec3 = [((p[0] % 1) + 1) % 1, ((p[1] % 1) + 1) % 1, ((p[2] % 1) + 1) % 1];
        const isDup = seen.some((q) => {
          for (let i = 0; i < 3; i++) {
            let dd = Math.abs(wrapped[i]! - q[i]!);
            dd = Math.min(dd, 1 - dd);
            if (dd > 1e-3) return false;
          }
          return true;
        });
        if (isDup) continue;
        seen.push(wrapped);
      }
      const r = op.rotation;
      const axial = determinant(r) * (op.timeReversal ?? 1);
      const comps = moment.components;
      const rotatedComps: [number, number, number] = [
        axial * (r[0][0] * comps[0] + r[0][1] * comps[1] + r[0][2] * comps[2]),
        axial * (r[1][0] * comps[0] + r[1][1] * comps[1] + r[1][2] * comps[2]),
        axial * (r[2][0] * comps[0] + r[2][1] * comps[1] + r[2][2] * comps[2]),
      ];
      const momentCart = moment.frame === "cartesian" ? rotatedComps : crystalComponentsToCartesian(structure.cell, rotatedComps);
      out.push({ position: p, momentCart, occupancy: site.occupancy, formFactorId: ffId, adp: site.adp });
    }
  }
  return out;
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
    // Thermal damping: the same Debye-Waller factor as the nuclear structure
    // factor — the magnetic scatterer is the same vibrating atom (GSAS-II and
    // FullProf damp |F_M| identically). Omitting it inflates the calculated
    // magnetic intensity at low d, biasing refined moments low.
    const dw =
      site.adp.kind === "isotropic"
        ? debyeWaller(site.adp.bIso, s)
        : anisotropicDebyeWaller(structure.cell, site.adp.uAniso, h, k, l);
    const seen: Vec3[] | null = dedup ? [] : null;
    // A split-orbit moment (magnetic subgroup ⊂ nuclear group) expands from its
    // own orbit-representative position, not the site's asymmetric-unit one.
    const basePos = moment.position ?? site.position;

    for (const op of ops) {
      const p = applyOperation(op, basePos);
      if (seen) {
        // One atom per unique position in the cell (no special-position
        // over-count). Compare by periodic distance, not a rounded string key:
        // a refined coordinate a hair off a special position (e.g. x = 0.50005)
        // puts images at 0.00005 and 0.99995 — the same atom mod 1 — and
        // rounded keys split them, over-counting the sublattice.
        const wrapped: Vec3 = [((p[0] % 1) + 1) % 1, ((p[1] % 1) + 1) % 1, ((p[2] % 1) + 1) % 1];
        const isDup = seen.some((q) => {
          for (let i = 0; i < 3; i++) {
            let dd = Math.abs(wrapped[i]! - q[i]!);
            dd = Math.min(dd, 1 - dd);
            if (dd > 1e-3) return false;
          }
          return true;
        });
        if (isDup) continue;
        seen.push(wrapped);
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
      const w = MAGNETIC_PREFACTOR * site.occupancy * fMag * dw;
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
