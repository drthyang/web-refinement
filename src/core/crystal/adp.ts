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
