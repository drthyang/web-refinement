/**
 * Identify which atom sites of a structure can carry a magnetic moment — the
 * candidates the user selects before a magnetic (k-vector) analysis.
 *
 * A site is "magnetic" if its ion (element + oxidation state) has an entry in the
 * ⟨j0⟩ magnetic form-factor table (International Tables Vol. C §4.4.5). This
 * correctly excludes closed-shell ions (e.g. Zn²⁺, O²⁻) and non-magnetic
 * elements while covering the 3d/4d/rare-earth/actinide ions in the table.
 */

import type { AtomSite, StructureModel } from "@/core/crystal/types";
import { magneticTable } from "@/core/scattering/magnetic";

export interface MagneticIonCandidate {
  readonly siteLabel: string;
  readonly element: string;
  /** ⟨j0⟩ ion id, e.g. "Mn2", "Fe3". */
  readonly ionId: string;
}

/** Resolve a site's ⟨j0⟩ ion id from element + oxidation state (default 2+). */
export function siteIonId(site: AtomSite): string {
  const ox = site.oxidationState ?? 2;
  return `${site.element}${ox}`;
}

/**
 * List the sites that can carry a magnetic moment (ion present in the ⟨j0⟩
 * table). Every site is considered, including each cation of a disordered site,
 * so the user can pick which are magnetically active.
 */
export function magneticIonCandidates(structure: StructureModel): MagneticIonCandidate[] {
  const out: MagneticIonCandidate[] = [];
  for (const site of structure.sites) {
    const ionId = siteIonId(site);
    if (magneticTable.has(ionId)) {
      out.push({ siteLabel: site.label, element: site.element, ionId });
    }
  }
  return out;
}
