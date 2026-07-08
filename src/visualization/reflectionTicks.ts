/**
 * Bragg reflection tick marks for the powder plot. Each phase (nuclear or
 * magnetic) contributes a coloured row of vertical ticks at its allowed
 * reflection positions, so the user can see which peaks are indexed by which
 * phase. Positions are produced in d-spacing by the crystallography and mapped
 * to the plot's current display abscissa by a caller-supplied `toX`.
 *
 * Magnetic ticks cover the commensurate single-k case: satellites at G ± k
 * (k = 0 → nuclear positions), restricted to those carrying a non-negligible
 * magnetic structure factor.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { dSpacing } from "@/core/crystal/unitCell";

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
  // Magnetic satellites at G ± k for the (single, commensurate) propagation
  // vector. k = 0 → the nuclear positions (the ±k satellites coincide).
  const k = magnetic.propagation[0] ?? [0, 0, 0];
  const isK0 = k.every((v) => Math.abs(v) < 1e-9);
  const reflections = generateReflections(structure.cell, structure.spaceGroup, dMin, dMax);
  const sat: { h: number; k: number; l: number; d: number; sq: number }[] = [];
  for (const r of reflections) {
    const images: [number, number, number][] = isK0
      ? [[r.h, r.k, r.l]]
      : [[r.h + k[0]!, r.k + k[1]!, r.l + k[2]!], [r.h - k[0]!, r.k - k[1]!, r.l - k[2]!]];
    for (const [mh, mk, ml] of images) {
      const d = dSpacing(structure.cell, mh, mk, ml);
      if (!Number.isFinite(d) || d < dMin || d > dMax) continue;
      sat.push({ h: mh, k: mk, l: ml, d, sq: magneticStructureFactor(structure, magnetic, mh, mk, ml).squared });
    }
  }
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
