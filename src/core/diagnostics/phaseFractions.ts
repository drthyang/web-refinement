/**
 * Quantitative phase analysis: weight fractions from the refined scale
 * factors (Hill & Howard 1987), W_p = S_p (ZMV)_p / Σ_i S_i (ZMV)_i, where
 * ZM is the mass of the cell contents and V the cell volume.
 *
 * It holds for this engine's scale because a reflection's calculated
 * intensity is S · m · Lp · |F|² with F summed over the whole cell and no
 * 1/V² folded in (core/diffraction/intensity.ts), the same convention as
 * GSAS-II and FullProf. The fractions are of the crystalline phases in the
 * model only: amorphous content and microabsorption (Brindley) are not
 * accounted for.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { cellContentsMass } from "@/core/crystal/atomicMass";

export interface PhaseScale {
  readonly id: string;
  readonly name: string;
  readonly structure: StructureModel;
  readonly scale: number;
  readonly scaleEsd?: number;
}

export interface PhaseFraction {
  readonly id: string;
  readonly name: string;
  /** Weight percent of the crystalline phases in the model. */
  readonly weightPercent: number;
  /** From the scale esds alone (their correlations are ignored); absent without esds. */
  readonly esd?: number;
}

/** Weight fractions (%) of the phases, in the order given. Throws for fewer than two phases or a non-positive total. */
export function phaseWeightFractions(phases: readonly PhaseScale[]): PhaseFraction[] {
  if (phases.length < 2) throw new Error("weight fractions need at least two phases");
  const zmv = phases.map((p) => cellContentsMass(p.structure) * cellVolume(p.structure.cell));
  const a = phases.map((p, i) => Math.max(p.scale, 0) * zmv[i]!);
  const total = a.reduce((s, v) => s + v, 0);
  if (!(total > 0)) throw new Error("the phase scales sum to zero");
  const withEsd = phases.every((p) => p.scaleEsd !== undefined && Number.isFinite(p.scaleEsd));
  return phases.map((p, i) => {
    const w = a[i]! / total;
    // ∂W_p/∂a_q = (δ_pq Σ − a_p)/Σ²; σ(a_q) = σ(S_q)·(ZMV)_q.
    const esd = withEsd
      ? Math.sqrt(phases.reduce((s, q, j) => s + (((j === i ? total : 0) - a[i]!) / (total * total)) ** 2 * (q.scaleEsd! * zmv[j]!) ** 2, 0))
      : undefined;
    return { id: p.id, name: p.name, weightPercent: 100 * w, ...(esd !== undefined ? { esd: 100 * esd } : {}) };
  });
}

/**
 * The phases' weight fractions from their refined scales (`p0_scale`,
 * `p1_scale`, …), or null when a phase has no scale or a cell mass cannot be
 * formed (an element with no atomic weight).
 */
export function fractionsOf(phases: readonly StructureModel[], params: readonly RefinementParameter[], result: RefinementResult): PhaseFraction[] | null {
  const scales = phases.map((ph, i) => {
    const p = params.find((q) => q.kind === "scale" && q.id === `p${i}_scale`);
    return p ? { id: ph.id, name: ph.name, structure: ph, scale: p.value, ...(result.esd[p.id] !== undefined ? { scaleEsd: result.esd[p.id]! } : {}) } : null;
  });
  if (scales.some((sc) => sc === null)) return null;
  try {
    return phaseWeightFractions(scales as NonNullable<(typeof scales)[number]>[]);
  } catch {
    return null;
  }
}

/** "3.8(1) wt%": the esd in the last digit shown. */
export function formatWt(w: PhaseFraction): string {
  if (w.esd === undefined || !(w.esd > 0)) return `${w.weightPercent.toFixed(1)} wt%`;
  const decimals = Math.min(Math.max(-Math.floor(Math.log10(w.esd)), 0), 3);
  const esdDigits = Math.round(w.esd * 10 ** decimals);
  return `${w.weightPercent.toFixed(decimals)}(${esdDigits}) wt%`;
}
