/**
 * Reflection generation for powder work: enumerate allowed (hkl) within a
 * d-spacing range, remove systematic absences, and group symmetry-equivalent
 * reflections into families with a multiplicity.
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { reciprocalTensorA } from "@/core/crystal/unitCell";
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

// Pack a Miller index triple into one integer for fast Set membership.
// Safe for |index| < 512, which far exceeds any powder loop bound.
const PACK_OFFSET = 512;
const PACK_BASE = 1024;
function pack(h: number, k: number, l: number): number {
  return ((h + PACK_OFFSET) * PACK_BASE + (k + PACK_OFFSET)) * PACK_BASE + (l + PACK_OFFSET);
}

/**
 * Numeric Miller indices equivalent to (hkl) under the Laue group (rotation
 * parts of the space-group operations plus Friedel −(hkl)), as packed integers.
 */
function equivalentPacked(sg: SpaceGroup, h: number, k: number, l: number): Set<number> {
  const set = new Set<number>();
  for (const op of sg.operations) {
    const t = transformIndices(op.rotation, h, k, l);
    const th = Math.round(t[0]);
    const tk = Math.round(t[1]);
    const tl = Math.round(t[2]);
    set.add(pack(th, tk, tl));
    set.add(pack(-th, -tk, -tl)); // Friedel
  }
  return set;
}

/** Canonical representative (lexicographically greatest) from packed indices. */
function canonicalPacked(indices: Set<number>): { h: number; k: number; l: number } {
  let bh = -Infinity, bk = -Infinity, bl = -Infinity;
  for (const p of indices) {
    const h = Math.floor(p / (PACK_BASE * PACK_BASE)) - PACK_OFFSET;
    const k = (Math.floor(p / PACK_BASE) % PACK_BASE) - PACK_OFFSET;
    const l = (p % PACK_BASE) - PACK_OFFSET;
    if (h > bh || (h === bh && k > bk) || (h === bh && k === bk && l > bl)) {
      bh = h; bk = k; bl = l;
    }
  }
  return { h: bh, k: bk, l: bl };
}

/** Bounded memo of reflection lists keyed on cell + range + space group. */
const reflCache = new Map<string, Reflection[]>();
const REFL_CACHE_MAX = 24;

function reflectionCacheKey(cell: UnitCell, sg: SpaceGroup, dMin: number, dMax: number): string {
  // Full-precision cell values so cell-derivative Jacobian columns don't collide
  // with the base cell; other (non-cell) parameters reuse the same key → hits.
  return `${cell.a},${cell.b},${cell.c},${cell.alpha},${cell.beta},${cell.gamma}|${dMin},${dMax}|${sg.operations.length}|${sg.hermannMauguin ?? ""}`;
}

/**
 * Generate unique powder reflection families with dMin ≤ d ≤ dMax.
 * Sorted by decreasing d (increasing |Q|).
 *
 * The reciprocal tensor is computed once (not a matrix inversion per hkl), and
 * results are memoized on the cell — reflections only change when the cell (or
 * range) changes, so refinements of scale/width/ADP/positions reuse the list.
 */
export function generateReflections(
  cell: UnitCell,
  sg: SpaceGroup,
  dMin: number,
  dMax: number,
): Reflection[] {
  const cacheKey = reflectionCacheKey(cell, sg, dMin, dMax);
  const cached = reflCache.get(cacheKey);
  if (cached) return cached;

  // Precompute the reciprocal tensor once: 1/d² = A11 h² + A22 k² + A33 l²
  // + A12 hk + A13 hl + A23 kl. Avoids a 3×3 inversion per candidate hkl.
  const A = reciprocalTensorA(cell);
  const invDMax2 = 1 / (dMax * dMax); // lower bound on 1/d²
  const invDMin2 = 1 / (dMin * dMin); // upper bound on 1/d²

  // Miller-index search half-width. Capped so an unreasonable cell edge (a typo
  // like 54.2→542, or a diverged refinement value) cannot blow the triple loop
  // up to astronomical size and freeze the thread. NMAX_CAP=160 covers cells up
  // to ~80 Å at dMin=0.5 — far beyond any inorganic powder this tool targets.
  const NMAX_CAP = 120;
  const MAX_REFLECTIONS = 12000; // a physical powder cell yields far fewer
  const nMax = Math.min(NMAX_CAP, Math.ceil(Math.max(cell.a, cell.b, cell.c) / dMin) + 1);
  const seen = new Set<number>(); // every individual (hkl) already assigned to a family
  const reflections: Reflection[] = [];

  outer: for (let h = -nMax; h <= nMax; h++) {
    for (let k = -nMax; k <= nMax; k++) {
      for (let l = -nMax; l <= nMax; l++) {
        if (h === 0 && k === 0 && l === 0) continue;
        if (seen.has(pack(h, k, l))) continue; // family already emitted — cheap skip
        const invd2 = A.a11 * h * h + A.a22 * k * k + A.a33 * l * l + A.a12 * h * k + A.a13 * h * l + A.a23 * k * l;
        if (invd2 < invDMax2 || invd2 > invDMin2) continue;

        // First time we meet this family: expand once, mark all members seen.
        const family = equivalentPacked(sg, h, k, l);
        for (const p of family) seen.add(p);
        const rep = canonicalPacked(family);
        if (isReflectionAbsent(sg.operations, rep.h, rep.k, rep.l)) continue;

        const repInvd2 = A.a11 * rep.h * rep.h + A.a22 * rep.k * rep.k + A.a33 * rep.l * rep.l + A.a12 * rep.h * rep.k + A.a13 * rep.h * rep.l + A.a23 * rep.k * rep.l;
        const d = 1 / Math.sqrt(repInvd2);
        reflections.push({ h: rep.h, k: rep.k, l: rep.l, d, q: (2 * Math.PI) / d, multiplicity: family.size });
        // Bail out on a pathological cell (a typo/diverged value) rather than
        // grinding through an enormous reciprocal shell and freezing the thread.
        if (reflections.length >= MAX_REFLECTIONS) break outer;
      }
    }
  }

  reflections.sort((a, b) => b.d - a.d);
  if (reflCache.size >= REFL_CACHE_MAX) reflCache.delete(reflCache.keys().next().value as string);
  reflCache.set(cacheKey, reflections);
  return reflections;
}
