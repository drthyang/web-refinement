/**
 * Bragg reflection tick marks for the powder plot. Each phase (nuclear or
 * magnetic) contributes a coloured row of vertical ticks at its allowed
 * reflection positions, so the user can see which peaks are indexed by which
 * phase. Positions are produced in d-spacing by the crystallography and mapped
 * to the plot's current display abscissa by a caller-supplied `toX`.
 *
 * Magnetic ticks cover the commensurate k = 0 case the engine supports: the
 * magnetic reflections coincide with nuclear positions, restricted to those
 * carrying non-negligible magnetic structure factor.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";

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
 * Magnetic (k = 0) reflection ticks: nuclear reflections whose magnetic
 * structure factor is non-negligible, relative to the strongest. A magnetic
 * structure with all-zero moments (or a paramagnetic model) yields no ticks.
 */
export function magneticPhaseTicks(
  structure: StructureModel,
  magnetic: MagneticModel,
  dMin: number,
  dMax: number,
  toX: (d: number) => number,
  meta: PhaseMeta,
): PhaseTicks {
  const reflections = generateReflections(structure.cell, structure.spaceGroup, dMin, dMax);
  const squared = reflections.map((r) => magneticStructureFactor(structure, magnetic, r.h, r.k, r.l).squared);
  const maxSq = squared.reduce((m, s) => (s > m ? s : m), 0);
  const ticks: ReflectionTick[] = [];
  if (maxSq > 0) {
    const eps = maxSq * 1e-4;
    reflections.forEach((r, i) => {
      if (squared[i]! <= eps) return;
      const x = toX(r.d);
      if (Number.isFinite(x)) ticks.push({ x, hkl: hklLabel(r.h, r.k, r.l), d: r.d });
    });
  }
  return { ...meta, kind: "magnetic", ticks };
}
