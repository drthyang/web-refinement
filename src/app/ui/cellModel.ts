/**
 * Pure geometry for the 3D structure viewer: expand a structure's asymmetric
 * unit into the atoms of one unit cell (Cartesian Å). Kept free of three.js /
 * React so it is unit-testable and so the viewer component only exports a
 * component (clean React Fast Refresh).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { equivalentPositions } from "@/core/crystal/symmetry";

/** One rendered atom: element + Cartesian position (Å). */
export interface CellAtom {
  readonly element: string;
  readonly xyz: Vec3;
}

/** Fractional coord within this of 0 → also drawn at +1 (fill faces/edges/corners). */
const BOUNDARY_EPS = 0.02;
/** Guardrail against a pathological cell/space-group producing runaway atoms. */
const MAX_ATOMS = 4000;

/**
 * Expand `structure` into the atoms of one unit cell, symmetry-equivalent
 * positions plus boundary duplicates. Deduped by (element, rounded position).
 */
export function buildCellAtoms(structure: StructureModel): CellAtom[] {
  const ops = structure.spaceGroup.operations;
  const atoms: CellAtom[] = [];
  const seen = new Set<string>();
  const push = (element: string, frac: Vec3): void => {
    if (atoms.length >= MAX_ATOMS) return;
    const key = `${element}|${frac.map((v) => v.toFixed(3)).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    atoms.push({ element, xyz: fractionalToCartesian(structure.cell, frac) });
  };

  for (const site of structure.sites) {
    const equivs = ops.length ? equivalentPositions(ops, site.position) : [site.position as Vec3];
    for (const p of equivs) {
      const axisImages = [0, 1, 2].map((i) => (p[i]! < BOUNDARY_EPS ? [0, 1] : [0]));
      for (const dx of axisImages[0]!) {
        for (const dy of axisImages[1]!) {
          for (const dz of axisImages[2]!) {
            push(site.element, [p[0]! + dx, p[1]! + dy, p[2]! + dz]);
          }
        }
      }
    }
  }
  return atoms;
}
