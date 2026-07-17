/**
 * Isotropic ↔ anisotropic displacement-parameter (ADP) conversion.
 *
 * A refinement usually starts isotropic (one B_iso per site) and, once the
 * scale/cell/positions are stable, switches well-determined atoms to the full
 * anisotropic U tensor. The two parameterizations are linked by the equivalent
 * isotropic displacement (Fischer & Tillmanns, *Acta Cryst.* C44 (1988) 775;
 * International Tables Vol. C §1.2.2):
 *
 *   U_iso = B_iso / (8π²),           B_iso = 8π² · U_eq,
 *   U_eq  = ⅓ (U11 + U22 + U33)      (the trace of U, for the seed here).
 *
 * Promotion seeds an isotropic tensor U11 = U22 = U33 = U_iso with zero
 * off-diagonals — the correct spherical starting point; the symmetry-allowed
 * off-diagonal modes then refine away from it. Demotion collapses a tensor to
 * its equivalent B_iso. (U_eq is strictly (1/3)Σ_ij U_ij a*_i a*_j (a_i·a_j),
 * which reduces to the trace only for orthogonal axes; the trace is the standard
 * seed/label value and is what is used here — the subsequent refinement is
 * insensitive to the exact seed.)
 */

import type { DisplacementParameters, StructureModel, AtomSite } from "@/core/crystal/types";

/** 8π², the B_iso ↔ U_iso conversion constant. */
export const EIGHT_PI_SQUARED = 8 * Math.PI * Math.PI;

/** U_iso (Å²) from B_iso (Å²). */
export function uIsoFromBIso(bIso: number): number {
  return bIso / EIGHT_PI_SQUARED;
}

/** B_iso (Å²) from the equivalent isotropic U (trace/3) of an aniso tensor. */
export function bIsoFromUAniso(
  u: readonly [number, number, number, number, number, number],
): number {
  return (EIGHT_PI_SQUARED * (u[0] + u[1] + u[2])) / 3;
}

/** Convert a site's ADP to anisotropic (isotropic → spherical U; aniso passes through). */
export function toAnisotropic(adp: DisplacementParameters): DisplacementParameters {
  if (adp.kind === "anisotropic") return adp;
  const u = uIsoFromBIso(adp.bIso);
  return { kind: "anisotropic", uAniso: [u, u, u, 0, 0, 0] };
}

/** Convert a site's ADP to isotropic (aniso → equivalent B_iso; iso passes through). */
export function toIsotropic(adp: DisplacementParameters): DisplacementParameters {
  if (adp.kind === "isotropic") return adp;
  return { kind: "isotropic", bIso: bIsoFromUAniso(adp.uAniso) };
}

/**
 * Return a structure with every site's ADP set to the requested model. Sites
 * already in that model are unchanged; promotion seeds the spherical tensor from
 * each site's current B_iso, so a converged isotropic fit is the starting point
 * for the anisotropic one.
 */
export function withAdpModel(structure: StructureModel, kind: "isotropic" | "anisotropic"): StructureModel {
  const convert = kind === "anisotropic" ? toAnisotropic : toIsotropic;
  const sites: AtomSite[] = structure.sites.map((s) => ({ ...s, adp: convert(s.adp) }));
  return { ...structure, sites };
}

/**
 * Rotate an anisotropic U tensor by a space-group operation's (fractional)
 * rotation matrix: U′ = R·U·Rᵀ, with U^{jk} the CIF contravariant components.
 * This is how a site's displacement ellipsoid carries to the other members of
 * its orbit — an image related by a 4-fold has U11 and U22 swapped, etc.
 * Skipping this (using the asymmetric-unit tensor verbatim on every image)
 * corrupts anisotropic Debye–Waller factors and real-space bond-projected
 * displacement widths for every site whose orbit involves a rotation.
 */
export function rotateUAniso(
  u: readonly [number, number, number, number, number, number],
  r: readonly (readonly number[])[],
): [number, number, number, number, number, number] {
  const U = [
    [u[0], u[3], u[4]],
    [u[3], u[1], u[5]],
    [u[4], u[5], u[2]],
  ];
  // W = R·U, then U′ = W·Rᵀ.
  const w = [0, 1, 2].map((i) => [0, 1, 2].map((j) => r[i]![0]! * U[0]![j]! + r[i]![1]! * U[1]![j]! + r[i]![2]! * U[2]![j]!));
  const up = [0, 1, 2].map((i) => [0, 1, 2].map((j) => w[i]![0]! * r[j]![0]! + w[i]![1]! * r[j]![1]! + w[i]![2]! * r[j]![2]!));
  return [up[0]![0]!, up[1]![1]!, up[2]![2]!, up[0]![1]!, up[0]![2]!, up[1]![2]!];
}

/** A site's ADP as seen by one orbit image: isotropic passes through, an
 *  anisotropic tensor is rotated by the operation (see rotateUAniso). */
export function adpForOperation(adp: DisplacementParameters, rotation: readonly (readonly number[])[]): DisplacementParameters {
  if (adp.kind === "isotropic") return adp;
  return { kind: "anisotropic", uAniso: rotateUAniso(adp.uAniso, rotation) };
}
