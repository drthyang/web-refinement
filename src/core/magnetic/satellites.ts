/**
 * Magnetic satellite positions for a single propagation vector (commensurate
 * or incommensurate): the one list every consumer of "where can magnetic
 * intensity appear" must share — the powder engine (magneticPowder), the
 * F_obs/F_calc decomposition (obsCalc), and the Bragg tick rows
 * (reflectionTicks). Keeping them on one enumerator is what makes a tick, a
 * peak, and an F-plot point agree.
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
 *  - k = 0 puts magnetic intensity on the nuclear positions.
 *
 * Multiplicity — exact Laue families, each satellite position ONCE:
 *  - Every emitted entry is one Laue family of the (generally fractional)
 *    satellite index: its orbit under the point-group rotations of the parent
 *    space group plus Friedel −h. `multiplicity` is that family's size, which
 *    is the powder multiplicity under the standard equal-population assumption
 *    for the domains of the star of k. The representative index is the first
 *    member encountered (G + k or G − k of a parent representative), so |F_M|²
 *    is evaluated where it always was.
 *  - A **self-conjugate k** (−k ≡ k: k = ½-type) makes G + k and G′ − k the
 *    SAME reflection for G′ = G + 2k. Listing both arms per parent counted
 *    every such satellite twice — 2× the magnetic intensity, refined moments
 *    1/√2 too small against a shared scale. Families are deduplicated across
 *    all candidates, so each position now enters exactly once.
 *  - When some Laue rotation carries k to neither +k nor −k (a k off the
 *    Laue-invariant lines, e.g. (⅓,0,0) in a tetragonal cell), the satellites
 *    of the other parent-orbit members lie at DIFFERENT d than the
 *    representative's, so every member of each parent family is expanded
 *    before ±k is added. For a Laue-invariant k the representative alone
 *    already spans its families and the cheaper path is taken.
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { dSpacing } from "@/core/crystal/unitCell";

export interface SatellitePosition {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  /** d-spacing in Å (always finite, inside [dMin, dMax]). */
  readonly d: number;
  /** Laue-family multiplicity of this satellite (all arms of the star of k
   *  the Laue group generates, equal-population domains). */
  readonly multiplicity: number;
}

/** Parent d cap for the widened window: effectively "every lattice node", while
 *  still excluding the d = ∞ node (000), which is seeded explicitly. */
const PARENT_D_CAP = 1000;

/** Transpose-apply a rotation to (possibly fractional) indices: h' = Rᵀ·h. */
function transformIndex(rot: Mat3, h: Vec3): Vec3 {
  return [
    rot[0][0] * h[0] + rot[1][0] * h[1] + rot[2][0] * h[2],
    rot[0][1] * h[0] + rot[1][1] * h[1] + rot[2][1] * h[2],
    rot[0][2] * h[0] + rot[1][2] * h[1] + rot[2][2] * h[2],
  ];
}

/** Distinct rotation parts of the space group (the point group). */
function pointGroupRotations(sg: SpaceGroup): Mat3[] {
  const seen = new Set<string>();
  const rots: Mat3[] = [];
  for (const op of sg.operations) {
    const key = op.rotation.map((r) => r.join(",")).join(";");
    if (seen.has(key)) continue;
    seen.add(key);
    rots.push(op.rotation);
  }
  return rots;
}

const idxKey = (v: Vec3): string => v.map((x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(6)).join(",");

/**
 * The Laue family of an index: distinct members under the point-group
 * rotations plus Friedel. Returns the member keys (size = multiplicity) and a
 * canonical family key (the lexicographically greatest member string).
 */
function laueFamily(rots: readonly Mat3[], h: Vec3): { members: Set<string>; key: string } {
  const members = new Set<string>();
  let key = "";
  for (const R of rots) {
    const t = transformIndex(R, h);
    for (const m of [t, [-t[0], -t[1], -t[2]] as Vec3]) {
      const s = idxKey([m[0] === 0 ? 0 : m[0], m[1] === 0 ? 0 : m[1], m[2] === 0 ? 0 : m[2]]);
      members.add(s);
      if (s > key) key = s;
    }
  }
  return { members, key };
}

/** True when every point-group rotation carries k to ±k (mod lattice). */
function kIsLaueInvariant(rots: readonly Mat3[], k: Vec3, tol = 1e-6): boolean {
  const near = (a: Vec3, b: Vec3): boolean =>
    [0, 1, 2].every((i) => { const d = a[i]! - b[i]!; return Math.abs(d - Math.round(d)) < tol; });
  const minus: Vec3 = [-k[0]!, -k[1]!, -k[2]!];
  return rots.every((R) => { const t = transformIndex(R, k); return near(t, k) || near(t, minus); });
}

/**
 * Enumerate the magnetic satellite positions G ± k with dMin ≤ d ≤ dMax, one
 * entry per Laue family with its exact multiplicity. Positions only —
 * evaluating |F_M|² at each (non-integer) index is the caller's job, and is
 * what decides which candidates carry intensity.
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

  if (isK0) {
    for (const r of generateReflections(cell, spaceGroup, dMin, dMax, { absences: false })) {
      const d = dSpacing(cell, r.h, r.k, r.l);
      if (Number.isFinite(d) && d > 0 && d >= dMin && d <= dMax) {
        out.push({ h: r.h, k: r.k, l: r.l, d, multiplicity: r.multiplicity });
      }
    }
    return out;
  }

  const rots = pointGroupRotations(spaceGroup);
  const seenFamilies = new Set<string>();
  const push = (h: number, kk: number, l: number): void => {
    const idx: Vec3 = [h, kk, l];
    const fam = laueFamily(rots, idx);
    if (seenFamilies.has(fam.key)) return;
    seenFamilies.add(fam.key);
    const d = dSpacing(cell, h, kk, l);
    if (Number.isFinite(d) && d > 0 && d >= dMin && d <= dMax) {
      out.push({ h, k: kk, l, d, multiplicity: fam.members.size });
    }
  };

  // The pure G = (000) satellites at ±k (one family when the arms are
  // Laue-related, which Friedel alone guarantees).
  push(k[0]!, k[1]!, k[2]!);
  push(-k[0]!, -k[1]!, -k[2]!);

  // Parent window widened by |k*|: |G ± k| ∈ [ ||G| − |k*|| , |G| + |k*| ], so
  // every satellite inside [dMin, dMax] has its parent inside the widened
  // window (the satellite's own d filters the excess afterwards).
  const kQ = 1 / dSpacing(cell, k[0]!, k[1]!, k[2]!);
  const parentDMin = 1 / (1 / dMin + kQ);
  const parentDMax = 1 / Math.max(1 / dMax - kQ, 1 / PARENT_D_CAP);
  const laueInvariant = kIsLaueInvariant(rots, k);
  for (const r of generateReflections(cell, spaceGroup, parentDMin, parentDMax, { absences: false })) {
    if (laueInvariant) {
      push(r.h + k[0]!, r.k + k[1]!, r.l + k[2]!);
      push(r.h - k[0]!, r.k - k[1]!, r.l - k[2]!);
      continue;
    }
    // Off the Laue-invariant lines the other members of the parent family
    // put their satellites at other d: expand the parent orbit explicitly.
    const members = new Map<string, Vec3>();
    for (const R of rots) {
      const t = transformIndex(R, [r.h, r.k, r.l]);
      const g: Vec3 = [Math.round(t[0]), Math.round(t[1]), Math.round(t[2])];
      members.set(idxKey(g), g);
      const mg: Vec3 = [-g[0], -g[1], -g[2]];
      members.set(idxKey(mg), mg);
    }
    for (const g of members.values()) {
      push(g[0] + k[0]!, g[1] + k[1]!, g[2] + k[2]!);
      push(g[0] - k[0]!, g[1] - k[1]!, g[2] - k[2]!);
    }
  }
  return out;
}
