/**
 * Bragg reflection tick marks for the powder plot. Each phase (nuclear or
 * magnetic) contributes a coloured row of vertical ticks at its allowed
 * reflection positions, so the user can see which peaks are indexed by which
 * phase. Positions are produced in d-spacing by the crystallography and mapped
 * to the plot's current display abscissa by a caller-supplied `toX`.
 *
 * Magnetic ticks cover the commensurate single-k case: satellites at G ± k
 * (k = 0 → nuclear positions), restricted to those carrying a non-negligible
 * magnetic structure factor — or, for `satellitePositionTicks`, unrestricted
 * (every position the k allows, the magnetic-analysis position check).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { magneticSatellites } from "@/core/magnetic/satellites";

export interface ReflectionTick {
  /** Position in the plot's current display unit. */
  readonly x: number;
  /** Miller indices, e.g. "1 0 2". */
  readonly hkl: string;
  /** d-spacing in Å (for the tooltip). */
  readonly d: number;
}

export interface PhaseTicks {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly kind: "nuclear" | "magnetic";
  readonly ticks: ReflectionTick[];
}

/** Distinct colours for nuclear phases; magnetic gets its own below. */
export const PHASE_COLORS = ["#0f8a8a", "#6a3d9a", "#00579b", "#b15928"] as const;
export const MAGNETIC_COLOR = "#c2185b";

interface PhaseMeta {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

function hklLabel(h: number, k: number, l: number): string {
  return `${h} ${k} ${l}`;
}

/** Nuclear Bragg reflection ticks for one phase over an inclusive d-window. */
export function nuclearPhaseTicks(
  structure: StructureModel,
  dMin: number,
  dMax: number,
  toX: (d: number) => number,
  meta: PhaseMeta,
): PhaseTicks {
  const reflections = generateReflections(structure.cell, structure.spaceGroup, dMin, dMax);
  const ticks: ReflectionTick[] = [];
  for (const r of reflections) {
    const x = toX(r.d);
    if (Number.isFinite(x)) ticks.push({ x, hkl: hklLabel(r.h, r.k, r.l), d: r.d });
  }
  return { ...meta, kind: "nuclear", ticks };
}

/**
 * Magnetic reflection ticks: satellite positions G ± k (from the shared
 * enumerator — nuclear-extinct parents and the pure (000)±k satellite
 * included) whose magnetic structure factor is non-negligible, relative to the
 * strongest. A magnetic structure with all-zero moments (or a paramagnetic
 * model) yields no ticks.
 */
export function magneticPhaseTicks(
  structure: StructureModel,
  magnetic: MagneticModel,
  dMin: number,
  dMax: number,
  toX: (d: number) => number,
  meta: PhaseMeta,
): PhaseTicks {
  const k = magnetic.propagation[0] ?? [0, 0, 0];
  const sat = magneticSatellites(structure.cell, structure.spaceGroup, k, dMin, dMax).map((s) => ({
    ...s,
    sq: magneticStructureFactor(structure, magnetic, s.h, s.k, s.l).squared,
  }));
  const maxSq = sat.reduce((m, s) => (s.sq > m ? s.sq : m), 0);
  const ticks: ReflectionTick[] = [];
  if (maxSq > 0) {
    const eps = maxSq * 1e-4;
    for (const r of sat) {
      if (r.sq <= eps) continue;
      const x = toX(r.d);
      if (Number.isFinite(x)) ticks.push({ x, hkl: hklLabel(r.h, r.k, r.l), d: r.d });
    }
  }
  return { ...meta, kind: "magnetic", ticks };
}

/**
 * Position-only satellite ticks: every place magnetic intensity CAN appear for
 * a propagation vector — G ± k over the full reciprocal lattice, no structure
 * factor involved. This is the k-selection check on the pattern: a viable k
 * puts a position tick under every unexplained peak. Coincident positions
 * (e.g. the ±k arms of one G, or different G sharing a d) collapse to one tick.
 */
export function satellitePositionTicks(
  structure: StructureModel,
  k: Vec3,
  dMin: number,
  dMax: number,
  toX: (d: number) => number,
  meta: PhaseMeta,
): PhaseTicks {
  const sat = [...magneticSatellites(structure.cell, structure.spaceGroup, k, dMin, dMax)].sort((a, b) => b.d - a.d);
  const ticks: ReflectionTick[] = [];
  for (const s of sat) {
    const prev = ticks[ticks.length - 1];
    if (prev && Math.abs(prev.d - s.d) < 1e-6 * s.d) continue;
    const x = toX(s.d);
    if (Number.isFinite(x)) ticks.push({ x, hkl: hklLabel(s.h, s.k, s.l), d: s.d });
  }
  return { ...meta, kind: "magnetic", ticks };
}
