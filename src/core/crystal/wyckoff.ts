/**
 * Wyckoff-position assignment: name a site's Wyckoff position (e.g. "6h", "2d")
 * for the built-in space groups.
 *
 * The multiplicity and point-group site symmetry are COMPUTED from the operation
 * list (see `siteSymmetry.ts`); the Wyckoff LETTER is tabulated International
 * Tables data — the letter's within-multiplicity ordering is a convention, not
 * something derivable from the group. A site is matched to a tabulated position
 * by the DEFINING property of a Wyckoff position: two points share a position iff
 * their site-symmetry groups (stabilizers) are CONJUGATE in the space group. That
 * conjugacy test (a) handles free-parameter positions like (x,2x,¼) — every point
 * on the orbit of the locus has a conjugate stabilizer — and (b) distinguishes
 * positions of identical site-symmetry TYPE but different location (e.g. 2b/2c/2d
 * in P6₃/mmc, whose stabilizers are non-conjugate).
 *
 * Curated to the built-in groups; `assignWyckoff` returns null for anything else,
 * leaving the always-available multiplicity + site symmetry as the fallback.
 */

import type { SpaceGroup, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { applyOperation, siteMultiplicity, siteStabilizer } from "@/core/crystal/symmetry";
import { wrapFractional } from "@/core/math/vec3";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { classifyPointGroup } from "@/core/crystal/pointGroup";

// Coordinate shorthands. Free parameters use generic irrational-ish values so a
// representative never lands on an accidentally higher-symmetry point.
const T = 1 / 3;
const TT = 2 / 3;
const g1 = 0.137, g2 = 0.241, g3 = 0.311;

interface WyckoffEntry {
  readonly letter: string;
  readonly coord: Vec3;
}

/**
 * International Tables Wyckoff representatives (letter + one representative point)
 * per space-group number. Free coordinates are set to generic values; only the
 * letter and the position's orbit-locus (via the stabilizer) matter for matching.
 */
export const WYCKOFF_TABLE: Readonly<Record<number, readonly WyckoffEntry[]>> = {
  1: [{ letter: "a", coord: [g1, g2, g3] }],
  2: [
    { letter: "a", coord: [0, 0, 0] }, { letter: "b", coord: [0, 0, 0.5] },
    { letter: "c", coord: [0, 0.5, 0] }, { letter: "d", coord: [0.5, 0, 0] },
    { letter: "e", coord: [0.5, 0.5, 0] }, { letter: "f", coord: [0, 0.5, 0.5] },
    { letter: "g", coord: [0.5, 0, 0.5] }, { letter: "h", coord: [0.5, 0.5, 0.5] },
    { letter: "i", coord: [g1, g2, g3] },
  ],
  14: [
    { letter: "a", coord: [0, 0, 0] }, { letter: "b", coord: [0.5, 0, 0] },
    { letter: "c", coord: [0, 0, 0.5] }, { letter: "d", coord: [0.5, 0, 0.5] },
    { letter: "e", coord: [g1, g2, g3] },
  ],
  194: [
    { letter: "a", coord: [0, 0, 0] }, { letter: "b", coord: [0, 0, 0.25] },
    { letter: "c", coord: [T, TT, 0.25] }, { letter: "d", coord: [T, TT, 0.75] },
    { letter: "e", coord: [0, 0, g1] }, { letter: "f", coord: [T, TT, g1] },
    { letter: "g", coord: [0.5, 0, 0] }, { letter: "h", coord: [g1, 2 * g1, 0.25] },
    { letter: "i", coord: [g1, 0, 0] }, { letter: "j", coord: [g1, g2, 0.25] },
    { letter: "k", coord: [g1, 2 * g1, g3] }, { letter: "l", coord: [g1, g2, g3] },
  ],
  216: [
    { letter: "a", coord: [0, 0, 0] }, { letter: "b", coord: [0.5, 0.5, 0.5] },
    { letter: "c", coord: [0.25, 0.25, 0.25] }, { letter: "d", coord: [0.75, 0.75, 0.75] },
    { letter: "e", coord: [g1, g1, g1] }, { letter: "f", coord: [g1, 0, 0] },
    { letter: "g", coord: [g1, 0.25, 0.25] }, { letter: "h", coord: [g1, g1, g3] },
    { letter: "i", coord: [g1, g2, g3] },
  ],
  225: [
    { letter: "a", coord: [0, 0, 0] }, { letter: "b", coord: [0.5, 0.5, 0.5] },
    { letter: "c", coord: [0.25, 0.25, 0.25] }, { letter: "d", coord: [0, 0.25, 0.25] },
    { letter: "e", coord: [g1, 0, 0] }, { letter: "f", coord: [g1, g1, g1] },
    { letter: "g", coord: [g1, 0.25, 0.25] }, { letter: "h", coord: [0, g1, g1] },
    { letter: "i", coord: [0, g2, g3] }, { letter: "j", coord: [g1, g1, g3] },
    { letter: "k", coord: [g1, g2, g3] },
  ],
};

/** Gram–Schmidt orthonormal basis of the span of `vecs` (Euclidean, in
 *  fractional coordinates — adequate for the discrete locus/lattice test). */
function orthonormalize(vecs: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of vecs) {
    let w: [number, number, number] = [v[0], v[1], v[2]];
    for (const e of out) {
      const d = w[0] * e[0] + w[1] * e[1] + w[2] * e[2];
      w = [w[0] - d * e[0], w[1] - d * e[1], w[2] - d * e[2]];
    }
    const n = Math.hypot(w[0], w[1], w[2]);
    if (n > 1e-9) out.push([w[0] / n, w[1] / n, w[2] / n]);
  }
  return out;
}

/**
 * Is `p` on the affine locus `rep + span(basis)`, modulo a lattice translation?
 * `basis` is the position's free-parameter directions (orthonormalized). The ±1
 * lattice offsets cover a locus that wraps across a cell boundary; a point lies
 * on the locus when its component ORTHOGONAL to the free directions vanishes.
 */
function onLocus(p: Vec3, rep: Vec3, orthoBasis: readonly Vec3[]): boolean {
  for (let nx = -1; nx <= 1; nx++) {
    for (let ny = -1; ny <= 1; ny++) {
      for (let nz = -1; nz <= 1; nz++) {
        let v: [number, number, number] = [p[0] - rep[0] - nx, p[1] - rep[1] - ny, p[2] - rep[2] - nz];
        for (const e of orthoBasis) {
          const d = v[0] * e[0] + v[1] * e[1] + v[2] * e[2];
          v = [v[0] - d * e[0], v[1] - d * e[1], v[2] - d * e[2]];
        }
        if (Math.hypot(v[0], v[1], v[2]) < 1e-3) return true;
      }
    }
  }
  return false;
}

/**
 * Does `site` belong to the Wyckoff position whose representative locus is
 * `rep + span(freeDirs)`? True iff SOME symmetry image of the site lies on that
 * locus — the orbit-of-locus test. This is the correct invariant (stabilizer
 * conjugacy fails, because mod-lattice the same operation fixes distinct special
 * points, e.g. inversion fixes both (0,0,0) and (0,0,½)). The general position
 * has a 3-D locus that every point satisfies, so it must be tried LAST.
 */
function siteMatchesPosition(ops: readonly SymmetryOperation[], site: Vec3, rep: Vec3): boolean {
  const basis = orthonormalize(allowedPositionShifts(ops, rep).basis);
  for (const g of ops) {
    if (onLocus(wrapFractional(applyOperation(g, site)), rep, basis)) return true;
  }
  return false;
}

/** Resolve the International Tables number for the tabulated groups, from the
 *  number if present else the Hermann–Mauguin symbol (a parsed CIF often carries
 *  only the symbol). Covers exactly the groups in `WYCKOFF_TABLE`. */
const NUMBER_BY_SYMBOL: Readonly<Record<string, number>> = {
  p1: 1, "p-1": 2,
  "p121/c1": 14, "p21/c": 14, "p1121/c1": 14,
  "p63/mmc": 194,
  "f-43m": 216, "f4-3m": 216,
  "fm-3m": 225, fm3m: 225,
};
function resolveNumber(sg: SpaceGroup): number | undefined {
  if (sg.number !== undefined) return sg.number;
  if (sg.hermannMauguin) return NUMBER_BY_SYMBOL[sg.hermannMauguin.replace(/\s+/g, "").toLowerCase()];
  return undefined;
}

export interface WyckoffAssignment {
  /** Full Wyckoff label, e.g. "6h". */
  readonly label: string;
  /** Wyckoff letter alone, e.g. "h". */
  readonly letter: string;
  readonly multiplicity: number;
  /** Point-group site symmetry (Hermann–Mauguin), from the stabilizer. */
  readonly siteSymmetry: string | null;
}

/**
 * Assign the Wyckoff position of a site. Returns null when the space group is not
 * in the built-in table, or the site matches no tabulated position (an
 * incompletely tabulated group) — callers fall back to multiplicity + site
 * symmetry, which are always available.
 */
export function assignWyckoff(spaceGroup: SpaceGroup, position: Vec3): WyckoffAssignment | null {
  const number = resolveNumber(spaceGroup);
  const table = number !== undefined ? WYCKOFF_TABLE[number] : undefined;
  if (!table) return null;
  const ops = spaceGroup.operations;
  // The table is ordered by increasing multiplicity, so special positions are
  // tried before the general one (whose locus every point satisfies).
  for (const entry of table) {
    if (siteMatchesPosition(ops, position, entry.coord)) {
      const multiplicity = siteMultiplicity(ops, position);
      return {
        label: `${multiplicity}${entry.letter}`,
        letter: entry.letter,
        multiplicity,
        siteSymmetry: classifyPointGroup(siteStabilizer(ops, position)).symbol,
      };
    }
  }
  return null;
}
