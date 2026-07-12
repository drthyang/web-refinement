/**
 * Per-site symmetry analysis: for each atom, the point-group site symmetry, its
 * multiplicity, and the refinable degrees of freedom the symmetry leaves — the
 * "what can I actually refine here?" answer.
 *
 * This packages machinery that already exists (the stabilizer null-spaces in
 * `siteConstraints`/`adpConstraints`/`allowedMoments`, plus the point-group
 * classifier) into one diagnostic. It is the symmetry-constrained-parameterization
 * guardrail: an agent (or a person) should never free a positional coordinate an
 * atom's site symmetry forbids, and the allowed moment/ADP dimensions say exactly
 * how many independent components each carries.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { applyOperation, siteStabilizer } from "@/core/crystal/symmetry";
import { wrapFractional } from "@/core/math/vec3";
import { classifyPointGroup } from "@/core/crystal/pointGroup";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { allowedAnisotropicAdpModes } from "@/core/crystal/adpConstraints";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { assignWyckoff } from "@/core/crystal/wyckoff";

export interface SiteSymmetry {
  readonly label: string;
  readonly element: string;
  readonly position: Vec3;
  /** Number of symmetry-equivalent atoms in the cell (orbit size). */
  readonly multiplicity: number;
  /** Hermann–Mauguin symbol of the site's point-group symmetry (stabilizer), or
   *  null if the operation list is not a recognized crystallographic group. */
  readonly siteSymmetry: string | null;
  /** Order of the site-symmetry group (1 for a general position). */
  readonly siteSymmetryOrder: number;
  /** True when the atom sits on a special position (site symmetry > 1). */
  readonly special: boolean;
  /** Free positional coordinates the symmetry allows to refine (0–3). */
  readonly freePositionParams: number;
  /** Independent anisotropic-ADP components the symmetry allows (0–6). */
  readonly freeAdpModes: number;
  /** Independent magnetic-moment components the site symmetry allows (0–3);
   *  0 means a moment is symmetry-forbidden on this site. */
  readonly allowedMomentComponents: number;
  /** Wyckoff label (e.g. "6h") for the built-in space groups; null otherwise. */
  readonly wyckoff: string | null;
}

/**
 * Analyze the site symmetry of every atom in a structure. Uses the structure's
 * operation list (from the parsed CIF or the built-in group) — completeness of
 * the constraints is exactly the completeness of that list (roadmap F2).
 */
export function analyzeSiteSymmetry(structure: StructureModel): SiteSymmetry[] {
  const ops = structure.spaceGroup.operations;
  return structure.sites.map((site) => {
    const stabilizer = siteStabilizer(ops, site.position);
    const pg = classifyPointGroup(stabilizer);
    // Multiplicity = orbit size = |G| / |stabilizer point ops|. Compute the orbit
    // directly so centring/screw/glide translations are handled correctly.
    const orbit: Vec3[] = [];
    for (const op of ops) {
      const p = wrapFractional(applyOperation(op, site.position));
      if (!orbit.some((q) => q.every((c, i) => Math.min(Math.abs(c - p[i]!), 1 - Math.abs(c - p[i]!)) < 1e-3))) orbit.push(p);
    }
    return {
      label: site.label,
      element: site.element,
      position: site.position,
      multiplicity: orbit.length,
      siteSymmetry: pg.symbol,
      siteSymmetryOrder: pg.order,
      special: pg.order > 1,
      freePositionParams: allowedPositionShifts(ops, site.position).dimension,
      freeAdpModes: allowedAnisotropicAdpModes(ops, site.position, [0, 0, 0, 0, 0, 0]).dimension,
      allowedMomentComponents: allowedMomentDirections(ops, site.position).dimension,
      wyckoff: assignWyckoff(structure.spaceGroup, site.position)?.label ?? null,
    };
  });
}
