/**
 * Structural geometry helpers for the quality-assessment step: interatomic
 * distances (bond lengths) computed from the fractional coordinates and cell.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";
import { wrapFractional, sub, norm } from "@/core/math/vec3";

export interface BondLength {
  readonly from: string;
  readonly to: string;
  readonly distance: number;
}

/**
 * Nearest-neighbour bond lengths (Å) up to `cutoff`, between each asymmetric
 * site and all symmetry-generated atoms in the surrounding cells. Deduplicated
 * and sorted by distance.
 */
export function bondLengths(model: StructureModel, cutoff = 3.2): BondLength[] {
  // Generate all atoms in the reference cell plus neighbouring cells.
  const atoms: Array<{ label: string; frac: Vec3 }> = [];
  for (const site of model.sites) {
    const positions: Vec3[] = [];
    for (const op of model.spaceGroup.operations) {
      const p = wrapFractional(applyOperation(op, site.position));
      if (!positions.some((q) => norm(sub(q, p)) < 1e-4)) positions.push(p);
    }
    for (const p of positions) atoms.push({ label: site.label, frac: p });
  }

  const bonds: BondLength[] = [];
  for (const site of model.sites) {
    const originFrac = wrapFractional(site.position);
    const originCart = fractionalToCartesian(model.cell, originFrac);
    for (const atom of atoms) {
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          for (let dc = -1; dc <= 1; dc++) {
            const frac: Vec3 = [atom.frac[0] + da, atom.frac[1] + db, atom.frac[2] + dc];
            const cart = fractionalToCartesian(model.cell, frac);
            const dist = norm(sub(cart, originCart));
            if (dist > 1e-3 && dist <= cutoff) {
              bonds.push({ from: site.label, to: atom.label, distance: dist });
            }
          }
        }
      }
    }
  }

  // Deduplicate near-equal bonds and sort.
  bonds.sort((a, b) => a.distance - b.distance);
  const unique: BondLength[] = [];
  for (const b of bonds) {
    if (!unique.some((u) => u.from === b.from && u.to === b.to && Math.abs(u.distance - b.distance) < 1e-3)) {
      unique.push(b);
    }
  }
  return unique;
}
