/**
 * Reflection generation for powder work: enumerate allowed (hkl) within a
 * d-spacing range, remove systematic absences, and group symmetry-equivalent
 * reflections into families with a multiplicity.
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { dSpacing, qMagnitude } from "@/core/crystal/unitCell";
import { isReflectionAbsent } from "@/core/crystal/symmetry";

export interface Reflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly q: number;
  /** Number of symmetry-equivalent reflections (incl. Friedel pairs). */
  readonly multiplicity: number;
}

/** Transpose-apply a rotation to Miller indices: h' = Rᵀ·h. */
function transformIndices(rot: Mat3, h: number, k: number, l: number): Vec3 {
  return [
    rot[0][0] * h + rot[1][0] * k + rot[2][0] * l,
    rot[0][1] * h + rot[1][1] * k + rot[2][1] * l,
    rot[0][2] * h + rot[1][2] * k + rot[2][2] * l,
  ];
}

function key(h: number, k: number, l: number): string {
  return `${h},${k},${l}`;
}

/**
 * Set of Miller indices equivalent to (hkl) under the Laue group (rotation
 * parts of the space-group operations plus Friedel −(hkl)).
 */
function equivalentIndices(sg: SpaceGroup, h: number, k: number, l: number): Set<string> {
  const set = new Set<string>();
  for (const op of sg.operations) {
    const t = transformIndices(op.rotation, h, k, l);
    const th = Math.round(t[0]);
    const tk = Math.round(t[1]);
    const tl = Math.round(t[2]);
    set.add(key(th, tk, tl));
    set.add(key(-th, -tk, -tl)); // Friedel
  }
  return set;
}

/** A canonical representative for a family: lexicographically greatest index. */
function canonical(indices: Set<string>): { h: number; k: number; l: number } {
  let best: { h: number; k: number; l: number } | null = null;
  for (const s of indices) {
    const [h, k, l] = s.split(",").map(Number) as [number, number, number];
    if (
      best === null ||
      h > best.h ||
      (h === best.h && k > best.k) ||
      (h === best.h && k === best.k && l > best.l)
    ) {
      best = { h, k, l };
    }
  }
  // `indices` is always non-empty (identity op present), so best is set.
  return best as { h: number; k: number; l: number };
}

/**
 * Generate unique powder reflection families with dMin ≤ d ≤ dMax.
 * Sorted by decreasing d (increasing |Q|).
 */
export function generateReflections(
  cell: UnitCell,
  sg: SpaceGroup,
  dMin: number,
  dMax: number,
): Reflection[] {
  // Loop bound: max index needed to reach dMin on any axis.
  const nMax = Math.ceil(Math.max(cell.a, cell.b, cell.c) / dMin) + 1;

  const seenFamilies = new Set<string>();
  const reflections: Reflection[] = [];

  for (let h = -nMax; h <= nMax; h++) {
    for (let k = -nMax; k <= nMax; k++) {
      for (let l = -nMax; l <= nMax; l++) {
        if (h === 0 && k === 0 && l === 0) continue;
        const d = dSpacing(cell, h, k, l);
        if (!(d >= dMin && d <= dMax)) continue;

        const family = equivalentIndices(sg, h, k, l);
        const rep = canonical(family);
        const repKey = key(rep.h, rep.k, rep.l);
        if (seenFamilies.has(repKey)) continue;

        if (isReflectionAbsent(sg.operations, rep.h, rep.k, rep.l)) {
          seenFamilies.add(repKey);
          continue;
        }
        seenFamilies.add(repKey);

        reflections.push({
          h: rep.h,
          k: rep.k,
          l: rep.l,
          d: dSpacing(cell, rep.h, rep.k, rep.l),
          q: qMagnitude(cell, rep.h, rep.k, rep.l),
          multiplicity: family.size,
        });
      }
    }
  }

  reflections.sort((a, b) => b.d - a.d);
  return reflections;
}
