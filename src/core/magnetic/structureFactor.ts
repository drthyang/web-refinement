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
import type { StructureModel, DisplacementParameters, SymmetryOperation } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { MagneticFormFactorTable } from "@/core/scattering/types";
import { add, expι, scale as cscale, ZERO } from "@/core/math/complex";
import { dSpacing } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";
import { momentAnchorPosition } from "@/core/crystal/cellExpansion";
import { magneticTable } from "@/core/scattering/magnetic";
import { crystalComponentsToCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";
import { determinant } from "@/core/math/mat3";
import { anisotropicDebyeWaller, debyeWaller } from "@/core/diffraction/structureFactor";
import { rotateUAniso } from "@/core/crystal/adp";
import { IDENTITY3 } from "@/core/math/mat3";
import { fourierArmFactor } from "@/core/magnetic/propagation";

/** Rotate crystal-axis moment components as an axial vector: axial·R·m. */
function rotateAxial(r: readonly (readonly number[])[], axial: number, comps: Vec3): [number, number, number] {
  return [
    axial * (r[0]![0]! * comps[0] + r[0]![1]! * comps[1] + r[0]![2]! * comps[2]),
    axial * (r[1]![0]! * comps[0] + r[1]![1]! * comps[1] + r[1]![2]! * comps[2]),
    axial * (r[2]![0]! * comps[0] + r[2]![1]! * comps[1] + r[2]![2]! * comps[2]),
  ];
}

/**
 * Which arm of the star {+k, −k} a (generally fractional) index belongs to:
 * +1 when h − k is a reciprocal-lattice vector (a +k satellite H + k), −1 when
 * h + k is (a −k satellite H − k), 0 when neither (a nuclear index, a higher
 * harmonic, or a foreign k). A self-conjugate k satisfies both; it returns +1
 * there (the coefficient is real anyway).
 */
export function satelliteArm(h: number, k: number, l: number, kVec: Vec3, tol = 1e-6): 1 | -1 | 0 {
  const isLattice = (a: number, b: number, c: number): boolean =>
    Math.abs(a - Math.round(a)) < tol && Math.abs(b - Math.round(b)) < tol && Math.abs(c - Math.round(c)) < tol;
  if (isLattice(h - kVec[0], k - kVec[1], l - kVec[2])) return 1;
  if (isLattice(h + kVec[0], k + kVec[1], l + kVec[2])) return -1;
  return 0;
}

/** The sine (quadrature) amplitude that actually enters the structure factor:
 *  absent, zero, or unobservable (self-conjugate k) all collapse to null. */
function observableSin(moment: { readonly sinComponents?: Vec3 }, arm: 0.5 | 1): Vec3 | null {
  if (arm === 1) return null;
  const s = moment.sinComponents;
  if (!s || (s[0] === 0 && s[1] === 0 && s[2] === 0)) return null;
  return s;
}

/** The nuclear operation carrying `from` onto `to` (mod 1), else identity —
 *  used to anchor a split-orbit representative's anisotropic tensor. */
function opToPosition(structure: StructureModel, from: Vec3, to: Vec3): SymmetryOperation {
  const near = (a: number, b: number): boolean => {
    let d = Math.abs((((a - b) % 1) + 1) % 1);
    d = Math.min(d, 1 - d);
    return d < 1e-4;
  };
  for (const op of structure.spaceGroup.operations) {
    const p = applyOperation(op, from);
    if (near(p[0], to[0]) && near(p[1], to[1]) && near(p[2], to[2])) return op;
  }
  return { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
}

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
  /** Op-rotated, axial-signed cosine amplitude in the Cartesian frame (μ_B),
   *  already multiplied by the two-arm factor (½ when −k ≢ k, else 1) so it is
   *  the real part of the Fourier coefficient the satellite sees. */
  readonly momentCart: Vec3;
  /** Op-rotated, axial-signed sine (quadrature) amplitude × arm factor — the
   *  imaginary part of the coefficient. Present only for a two-arm k with a
   *  nonzero quadrature amplitude; a kernel that ignores it is wrong for
   *  helical/elliptical modulations and must refuse such a model. */
  readonly sinMomentCart?: Vec3;
  readonly occupancy: number;
  readonly formFactorId: string;
  readonly adp: DisplacementParameters;
}

/** Expand a magnetic model over each moment's distinct orbit (see the type doc). */
export function expandMagneticAtoms(structure: StructureModel, magnetic: MagneticModel): ExpandedMagneticAtom[] {
  const ops = magnetic.operations ?? structure.spaceGroup.operations;
  const dedup = magnetic.operations !== undefined;
  const arm = fourierArmFactor(magnetic.propagation[0] ?? [0, 0, 0]);
  const out: ExpandedMagneticAtom[] = [];
  for (const moment of magnetic.moments) {
    const site = structure.sites.find((st) => st.label === moment.siteLabel);
    if (!site) continue;
    const ffId = formFactorId(structure, moment.siteLabel, moment.formFactorId);
    const sinComps = observableSin(moment, arm);
    const seen: Vec3[] | null = dedup ? [] : null;
    const basePos = momentAnchorPosition(structure.spaceGroup.operations, ops, site.position, moment.orbitIndex, moment.position);
    // Anisotropic ADP anchored at the orbit representative, rotated per image —
    // mirrors magneticStructureFactor exactly (the GPU kernel marshals this).
    const adpAtRep: DisplacementParameters = site.adp.kind === "anisotropic"
      ? { kind: "anisotropic", uAniso: rotateUAniso(site.adp.uAniso, opToPosition(structure, site.position, basePos).rotation) }
      : site.adp;
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
      const rotatedComps = rotateAxial(r, axial, moment.components);
      const cosCart = moment.frame === "cartesian" ? rotatedComps : crystalComponentsToCartesian(structure.cell, rotatedComps);
      const momentCart: Vec3 = arm === 1 ? cosCart : [cosCart[0] * arm, cosCart[1] * arm, cosCart[2] * arm];
      let sinMomentCart: Vec3 | undefined;
      if (sinComps) {
        const rotatedSin = rotateAxial(r, axial, sinComps);
        const sc = moment.frame === "cartesian" ? rotatedSin : crystalComponentsToCartesian(structure.cell, rotatedSin);
        sinMomentCart = [sc[0] * arm, sc[1] * arm, sc[2] * arm];
      }
      const adp: DisplacementParameters = adpAtRep.kind === "anisotropic"
        ? { kind: "anisotropic", uAniso: rotateUAniso(adpAtRep.uAniso, r) }
        : adpAtRep;
      out.push({
        position: p, momentCart, occupancy: site.occupancy, formFactorId: ffId, adp,
        ...(sinMomentCart ? { sinMomentCart } : {}),
      });
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

  // Two-arm propagation vectors (−k ≢ k): the coefficient of the +k satellite
  // is S = ½·(M^cos + i·M^sin) — the ½ is the two-arm factor, and the sine
  // amplitude is what makes helices/cycloids/elliptical modulations
  // representable at all. Self-conjugate k (k = 0, ½-type): S = M^cos, real,
  // and the sine amplitude is unobservable (sin(2π k·n) ≡ 0). See
  // core/magnetic/propagation.ts. The lattice phase e^{2πi k·n_g} that relates
  // the coefficients of orbit images (S_j' = θ·det R·R·S_j·e^{2πi k·n_g}) is
  // carried by the UNWRAPPED image position below: e^{2πi (H+k)·(r + n_g)}.
  const kVec = magnetic.propagation[0] ?? [0, 0, 0];
  const arm = fourierArmFactor(kVec);
  // Which arm is this index? The −k satellite (H − k) scatters with the
  // CONJUGATE coefficient S* = ½(M^cos − i·M^sin): the lattice phases of the
  // orbit images conjugate on their own through the index (e^{2πi(H−k)·n_g}),
  // but the representative's own sine part must be negated explicitly. An
  // index that is neither H + k nor H − k (a nuclear node of a k ≠ 0 model, a
  // higher harmonic) carries NO magnetic intensity from a single-k modulation:
  // the formula would return a meaningless partial sum there, which is exactly
  // what used to leak magnetic intensity onto the nuclear rows of a mixed
  // single-crystal dataset. The index tolerance is loose (1e-3) because
  // satellite indices in reflection files are written with few decimals.
  const isK0 = kVec[0] === 0 && kVec[1] === 0 && kVec[2] === 0;
  const armSign = isK0 ? 1 : satelliteArm(h, k, l, kVec, 1e-3);
  if (armSign === 0) return { vector: [ZERO, ZERO, ZERO], squared: 0 };
  const conjugate = arm === 0.5 && armSign === -1;

  for (const moment of magnetic.moments) {
    const site = structure.sites.find((st) => st.label === moment.siteLabel);
    if (!site) continue;
    const ffId = formFactorId(structure, moment.siteLabel, moment.formFactorId);
    const fMag = table.has(ffId) ? table.j0(ffId, s) : 1;
    const sinRaw = observableSin(moment, arm);
    const sinComps: Vec3 | null = sinRaw && conjugate ? [-sinRaw[0], -sinRaw[1], -sinRaw[2]] : sinRaw;
    // Thermal damping: the same Debye-Waller factor as the nuclear structure
    // factor — the magnetic scatterer is the same vibrating atom (GSAS-II and
    // FullProf damp |F_M| identically). Omitting it inflates the calculated
    // magnetic intensity at low d, biasing refined moments low.
    // Isotropic Debye–Waller is rotation-invariant; an anisotropic tensor is
    // rotated per orbit image (U′ = R·U·Rᵀ) inside the operation loop below.
    const isoDw = site.adp.kind === "isotropic" ? debyeWaller(site.adp.bIso, s) : null;
    const seen: Vec3[] | null = dedup ? [] : null;
    // A split-orbit moment (magnetic subgroup ⊂ nuclear group) expands from its
    // own orbit-representative position, not the site's asymmetric-unit one —
    // re-derived from the site's CURRENT position, so the sublattice moves with
    // the refinement instead of staying pinned where the model was built.
    const basePos = momentAnchorPosition(structure.spaceGroup.operations, ops, site.position, moment.orbitIndex, moment.position);
    // The tensor AT the representative: the site's U carried by the nuclear
    // operation g₀ that maps the asymmetric position to basePos (identity when
    // the moment sits on the asymmetric site itself). Each image below then
    // sees R·U₀·Rᵀ.
    const anisoU = site.adp.kind === "anisotropic"
      ? rotateUAniso(site.adp.uAniso, opToPosition(structure, site.position, basePos).rotation)
      : null;

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
      const rotatedComps = rotateAxial(r, axial, moment.components);
      const mCart =
        moment.frame === "cartesian"
          ? rotatedComps
          : crystalComponentsToCartesian(structure.cell, rotatedComps);
      const mPerp = perpendicularMoment(mCart, q);

      const phase = TWO_PI * (h * p[0] + k * p[1] + l * p[2]);
      const ph = expι(phase);
      const dw = isoDw ?? anisotropicDebyeWaller(structure.cell, rotateUAniso(anisoU!, r), h, k, l);
      const w = MAGNETIC_PREFACTOR * site.occupancy * fMag * dw * arm;
      if (!sinComps) {
        // Real coefficient (k = 0, self-conjugate k, or no quadrature part):
        // the historical path, kept operation-for-operation so every k = 0
        // golden stays bit-identical.
        fx = add(fx, cscale(ph, w * mPerp[0]));
        fy = add(fy, cscale(ph, w * mPerp[1]));
        fz = add(fz, cscale(ph, w * mPerp[2]));
        continue;
      }
      // Complex coefficient: (M⊥^cos + i·M⊥^sin)·e^{iφ}, the sine part rotated
      // by the same axial transform and projected by the same q̂ (both linear).
      const rotatedSin = rotateAxial(r, axial, sinComps);
      const sCart = moment.frame === "cartesian" ? rotatedSin : crystalComponentsToCartesian(structure.cell, rotatedSin);
      const sPerp = perpendicularMoment(sCart, q);
      const acc = [fx, fy, fz];
      for (let a = 0; a < 3; a++) {
        const c = w * mPerp[a]!;
        const sv = w * sPerp[a]!;
        acc[a] = add(acc[a]!, { re: c * ph.re - sv * ph.im, im: c * ph.im + sv * ph.re });
      }
      fx = acc[0]!;
      fy = acc[1]!;
      fz = acc[2]!;
    }
  }

  const squared =
    fx.re * fx.re + fx.im * fx.im +
    fy.re * fy.re + fy.im * fy.im +
    fz.re * fz.re + fz.im * fz.im;

  return { vector: [fx, fy, fz], squared };
}
