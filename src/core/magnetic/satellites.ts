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
  /** Parent-family Laue multiplicity (star-of-k approximation; 1 for G = 000). */
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

  // The pure G = (000) satellites at ±k. Both arms are emitted (multiplicity 1
  // each, sharing one d) to mirror how every other G contributes its ±k pair.
  push(k[0]!, k[1]!, k[2]!, 1);
  push(-k[0]!, -k[1]!, -k[2]!, 1);

  // Parent window widened by |k*|: |G ± k| ∈ [ ||G| − |k*|| , |G| + |k*| ], so
  // every satellite inside [dMin, dMax] has its parent inside the widened
  // window (the satellite's own d filters the excess afterwards).
  const kQ = 1 / dSpacing(cell, k[0]!, k[1]!, k[2]!);
  const parentDMin = 1 / (1 / dMin + kQ);
  const parentDMax = 1 / Math.max(1 / dMax - kQ, 1 / PARENT_D_CAP);
  for (const r of generateReflections(cell, spaceGroup, parentDMin, parentDMax, { absences: false })) {
    push(r.h + k[0]!, r.k + k[1]!, r.l + k[2]!, r.multiplicity);
    push(r.h - k[0]!, r.k - k[1]!, r.l - k[2]!, r.multiplicity);
  }
  return out;
}
