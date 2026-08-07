/**
 * Magnetic satellite positions for a single commensurate propagation vector:
 * the one list every consumer of "where can magnetic intensity appear" must
 * share — the powder engine (magneticPowder), the F_obs/F_calc decomposition
 * (obsCalc), and the Bragg tick rows (reflectionTicks). Keeping them on one
 * enumerator is what makes a tick, a peak, and an F-plot point agree.
 *
 * Physics of the list:
 *  - Satellites live at G ± k for every reciprocal-lattice node G. Nuclear
 *    systematic absences do NOT bind the magnetic structure factor
 *    (`absences: false`): AFM structures put their satellites exactly at
 *    nuclear-extinct positions — a gray anti-translation lattice (BNS P_c…)
 *    even makes the (0,0,½)′ op look like a centring, and filtering would
 *    delete every magnetic peak. |F_M|² itself decides what is absent.
 *  - The parent window is WIDENED by |k*| on both ends: a satellite lies
 *    within |k*| of its parent in Q, so a parent outside the pattern's own
 *    d-window can still land a satellite inside it. Satellites are then
 *    filtered by their own d.
 *  - G = (000) contributes the pure ±k satellite — often the longest-d (and
 *    strongest) magnetic peak, and typically the one the k was chosen to
 *    explain. `generateReflections` never emits (000), so it is seeded here.
 *  - k = 0 puts magnetic intensity on the nuclear positions (the ±k images
 *    coincide, emitted once).
 *  - A **self-conjugate** k (2k a reciprocal-lattice vector — every k = ½
 *    type, the commonest commensurate AFM case) has coinciding arms:
 *    {G − k} over the full reflection sphere is the SAME node set as {G + k},
 *    since G − k = (G − 2k) + k and G − 2k is itself a lattice node. Emitting
 *    both arms at full parent multiplicity counted every satellite twice (a
 *    factor-2 scale error: moments refined ≈1/√2 low with `magneticScale`
 *    fixed), and no constant reweighting can repair it for a multi-component
 *    ½ vector, where the coinciding arms belong to Laue families of different
 *    multiplicities (k = (½,½,½) in Pmmm: per-d errors of 1.25–1.75×, a shape
 *    distortion the scale cannot absorb). These satellites are true Bragg
 *    reflections of a ≤ 2×2×2 supercell, so they are enumerated EXACTLY:
 *    every distinct node once, weight 1, |F_M|² evaluated per node. Verified
 *    against a brute-force full-sphere enumeration (P1 and Pmmm, single- and
 *    multi-axis ½) and a P1 supercell equivalence in satellites.test.
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { dSpacing } from "@/core/crystal/unitCell";

export interface SatellitePosition {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  /** d-spacing in Å (always finite, inside [dMin, dMax]). */
  readonly d: number;
  /**
   * Satellite weight. For a generic (two-arm) k: the parent-family Laue
   * multiplicity (star-of-k approximation; 1 for G = 000) attached to one
   * representative index per family arm. For a self-conjugate k (2k ∈ ℤ³):
   * always 1, because the list is then an exact distinct-node enumeration
   * with |F_M|² evaluated at every node individually.
   */
  readonly multiplicity: number;
}

/** Parent d cap for the widened window: effectively "every lattice node", while
 *  still excluding the d = ∞ node (000), which is seeded explicitly. */
const PARENT_D_CAP = 1000;

/**
 * Enumerate the candidate magnetic satellite positions G ± k with
 * dMin ≤ d ≤ dMax. Positions only — evaluating |F_M|² at each (non-integer)
 * index is the caller's job, and is what decides which candidates carry
 * intensity.
 */
export function magneticSatellites(
  cell: UnitCell,
  spaceGroup: SpaceGroup,
  k: Vec3,
  dMin: number,
  dMax: number,
): SatellitePosition[] {
  const isK0 = k.every((v) => Math.abs(v) < 1e-9);
  const out: SatellitePosition[] = [];
  const push = (h: number, kk: number, l: number, multiplicity: number): void => {
    const d = dSpacing(cell, h, kk, l);
    if (Number.isFinite(d) && d > 0 && d >= dMin && d <= dMax) out.push({ h, k: kk, l, d, multiplicity });
  };

  if (isK0) {
    for (const r of generateReflections(cell, spaceGroup, dMin, dMax, { absences: false })) {
      push(r.h, r.k, r.l, r.multiplicity);
    }
    return out;
  }

  // Parent window widened by |k*|: |G ± k| ∈ [ ||G| − |k*|| , |G| + |k*| ], so
  // every satellite inside [dMin, dMax] has its parent inside the widened
  // window (the satellite's own d filters the excess afterwards).
  const kQ = 1 / dSpacing(cell, k[0]!, k[1]!, k[2]!);
  const parentDMin = 1 / (1 / dMin + kQ);
  const parentDMax = 1 / Math.max(1 / dMax - kQ, 1 / PARENT_D_CAP);

  // Self-conjugate k (2k ∈ ℤ³, every k = ½ type): the ±k arms enumerate the
  // SAME node set, and for a multi-component k the coinciding arms belong to
  // Laue families of DIFFERENT multiplicities — no constant arm weight is
  // correct (a ½ weight is exact only when every coincidence pairs equal-sized
  // families, e.g. single-axis ½ or P1). These satellites are genuine Bragg
  // reflections of a small (≤ 2×2×2) supercell, so enumerate them EXACTLY:
  // expand every parent to its full Laue family, take both arms, and emit each
  // DISTINCT node once with weight 1. The caller then evaluates |F_M|² per
  // node — which is also better physics than one representative × multiplicity
  // (each node carries its own perpendicular projection).
  if (k.every((v) => Math.abs(2 * v - Math.round(2 * v)) < 1e-6)) {
    return selfConjugateNodes(cell, spaceGroup, k, dMin, dMax, parentDMin, parentDMax);
  }

  // The pure G = (000) satellites at ±k. Both arms are emitted (multiplicity 1
  // each, sharing one d) to mirror how every other G contributes its ±k pair.
  push(k[0]!, k[1]!, k[2]!, 1);
  push(-k[0]!, -k[1]!, -k[2]!, 1);

  for (const r of generateReflections(cell, spaceGroup, parentDMin, parentDMax, { absences: false })) {
    push(r.h + k[0]!, r.k + k[1]!, r.l + k[2]!, r.multiplicity);
    push(r.h - k[0]!, r.k - k[1]!, r.l - k[2]!, r.multiplicity);
  }
  return out;
}

/**
 * Exact distinct-node enumeration for a self-conjugate k. Every parent
 * representative is expanded to its full Laue star (reciprocal indices
 * transform as h′ = h·R, plus the Friedel partner −h′), both ±k arms are
 * formed, and nodes are deduplicated globally — across arms AND across parent
 * families, because for a multi-component ½ vector the +k arm of one family
 * coincides with the −k arm of another (G + k = G′ − k whenever G′ − G = 2k,
 * a lattice vector). Each surviving node carries multiplicity 1: the list IS
 * the full sphere of magnetic Bragg positions, nothing is represented by
 * proxy.
 */
function selfConjugateNodes(
  cell: UnitCell,
  spaceGroup: SpaceGroup,
  k: Vec3,
  dMin: number,
  dMax: number,
  parentDMin: number,
  parentDMax: number,
): SatellitePosition[] {
  const out: SatellitePosition[] = [];
  const seen = new Set<string>();
  const keyOf = (h: number, kk: number, l: number): string =>
    `${Math.round(h * 1e6)},${Math.round(kk * 1e6)},${Math.round(l * 1e6)}`;
  const emit = (h: number, kk: number, l: number): void => {
    const d = dSpacing(cell, h, kk, l);
    if (!Number.isFinite(d) || d <= 0 || d < dMin || d > dMax) return;
    const key = keyOf(h, kk, l);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ h, k: kk, l, d, multiplicity: 1 });
  };

  // The pure ±k satellites (parent G = 000).
  emit(k[0]!, k[1]!, k[2]!);
  emit(-k[0]!, -k[1]!, -k[2]!);

  // Laue star of each parent representative: reciprocal indices transform by
  // the rotation acting on the row vector (h′_j = Σ_i h_i R_ij), and the
  // Friedel partner completes the diffraction symmetry.
  const rotations = spaceGroup.operations.map((op) => op.rotation);
  for (const r of generateReflections(cell, spaceGroup, parentDMin, parentDMax, { absences: false })) {
    for (const R of rotations) {
      const gh = r.h * R[0][0] + r.k * R[1][0] + r.l * R[2][0];
      const gk = r.h * R[0][1] + r.k * R[1][1] + r.l * R[2][1];
      const gl = r.h * R[0][2] + r.k * R[1][2] + r.l * R[2][2];
      for (const [ph, pk, pl] of [[gh, gk, gl], [-gh, -gk, -gl]]) {
        emit(ph! + k[0]!, pk! + k[1]!, pl! + k[2]!);
        emit(ph! - k[0]!, pk! - k[1]!, pl! - k[2]!);
      }
    }
  }
  return out;
}
