/**
 * Build the full symmetry-allowed powder refinement parameter set for the UI.
 *
 * Wraps `buildStructureRefinement` (scale, Chebyshev background, symmetry-reduced
 * cell, instrument profile, per-site ADP, symmetry-adapted atomic positions) and
 * seeds the scale from the observed data. Structural parameters (positions, ADP,
 * occupancy, corrections) start *fixed* so the first click of "Refine" does a
 * safe scale/background/cell/profile fit; the user frees them per row or runs the
 * guided (staged) sequence, which unlocks them in the expert order.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { optimalScale } from "@/app/loadData";

/** Kinds held fixed on first load; freed via the table or the guided sequence. */
const STRUCTURAL_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "positionShift", "bIso", "occupancy", "poRatio", "absorption",
]);

export interface PowderSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly profile: PowderProfile;
}

export function buildPowderSpec(
  structure: StructureModel,
  pattern: PowderPattern,
  instrument: InstrumentParameters,
  lorentz = true,
): PowderSpec {
  const cw = instrument.kind === "constantWavelength" ? instrument : null;
  // A GSAS-II .instprm carries the Caglioti U,V,W → angle-dependent width; else
  // fall back to a single width.
  const caglioti = cw && cw.u !== undefined ? { u: cw.u, v: cw.v ?? 0, w: cw.w ?? 1 } : undefined;
  const zero = cw?.zero ?? 0;
  const profile: PowderProfile = {
    shape: caglioti ? "pseudoVoigt" : "gaussian",
    ...(caglioti ? { eta: 0.5 } : {}),
    lorentz,
  };

  const cagOpt = caglioti ? { caglioti } : {};
  // Seed the scale from the data with a unit-scale evaluation.
  const seed = buildStructureRefinement(structure, pattern, { scale: 1, zero, ...cagOpt });
  const curves = powderCurves(structure, pattern, seed.params, seed.bindings, profile);
  const s = optimalScale(curves.yObs.map((y) => (y > 0 ? y : 0)), curves.yCalc);

  const spec = buildStructureRefinement(structure, pattern, { scale: s, zero, ...cagOpt });
  const params = spec.params.map((p) => (STRUCTURAL_KINDS.has(p.kind) ? { ...p, fixed: true } : p));
  return { params, bindings: spec.bindings, profile };
}
