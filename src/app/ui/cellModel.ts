/**
 * Pure geometry for the 3D structure viewer: expand a structure's asymmetric
 * unit into the atoms of one unit cell (Cartesian Å). Kept free of three.js /
 * React so it is unit-testable and so the viewer component only exports a
 * component (clean React Fast Refresh).
 *
 * Each atom also carries its site label and the rotation of the space-group
 * operation that placed it — the latter is needed to transform an **axial**
 * magnetic-moment vector (m′ = det(R)·R·m) for the moment preview.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { applyOperation } from "@/core/crystal/symmetry";

/** One rendered atom: element, site label, Cartesian position (Å), placing rotation. */
export interface CellAtom {
  readonly element: string;
  readonly label: string;
  readonly xyz: Vec3;
  readonly rot: Mat3;
}

/** Fractional coord within this of 0 → also drawn at +1 (fill faces/edges/corners). */
const BOUNDARY_EPS = 0.02;
/** Guardrail against a pathological cell/space-group producing runaway atoms. */
const MAX_ATOMS = 4000;

const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function wrap01(v: number): number {
  return ((v % 1) + 1) % 1;
}

function coincide(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d);
    if (d > 1e-3) return false;
  }
  return true;
}

/**
 * Expand `structure` into the atoms of one unit cell: symmetry-equivalent
 * positions plus boundary duplicates. Deduped per site by wrapped position.
 */
export function buildCellAtoms(structure: StructureModel): CellAtom[] {
  const ops = structure.spaceGroup.operations.length
    ? structure.spaceGroup.operations
    : [{ rotation: IDENTITY, translation: [0, 0, 0] as Vec3, xyz: "x,y,z" }];
  const atoms: CellAtom[] = [];
  const seen = new Set<string>();
  const push = (element: string, label: string, frac: Vec3, rot: Mat3): void => {
    if (atoms.length >= MAX_ATOMS) return;
    const key = `${label}|${frac.map((v) => v.toFixed(3)).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    atoms.push({ element, label, xyz: fractionalToCartesian(structure.cell, frac), rot });
  };

  for (const site of structure.sites) {
    // Distinct equivalent positions (wrapped), each with its placing rotation.
    const placed: { frac: Vec3; rot: Mat3 }[] = [];
    for (const op of ops) {
      const raw = applyOperation(op, site.position);
      const frac: Vec3 = [wrap01(raw[0]), wrap01(raw[1]), wrap01(raw[2])];
      if (!placed.some((q) => coincide(q.frac, frac))) placed.push({ frac, rot: op.rotation });
    }
    for (const { frac, rot } of placed) {
      // Duplicate across each near-zero axis so faces/edges/corners are filled.
      const axisImages = [0, 1, 2].map((i) => (frac[i]! < BOUNDARY_EPS ? [0, 1] : [0]));
      for (const dx of axisImages[0]!) {
        for (const dy of axisImages[1]!) {
          for (const dz of axisImages[2]!) {
            push(site.element, site.label, [frac[0]! + dx, frac[1]! + dy, frac[2]! + dz], rot);
          }
        }
      }
    }
  }
  return atoms;
}
