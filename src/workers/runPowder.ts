/**
 * Shared powder-refinement runner for both the worker and the in-thread fallback,
 * so the two paths cannot diverge. Handles the flat co-refinement and the staged
 * (guided) sequence, rebuilding the profile from the request fields.
 */

import type { EvaluatorSpec, RefinePowderRequest } from "@/workers/protocol";
import type { AgreementFactors, RefinementOptions, RefinementResult } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { buildPowderProblem, type PowderProfile } from "@/core/workflow/powder";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { buildMultiPhasePowderProblem } from "@/core/workflow/multiPhase";
import { refineStaged } from "@/core/refinement/staged";
import { stagesFromKindGroups } from "@/core/workflow/structureRefinement";

/**
 * Build the refinement problem an evaluator spec describes. Used by BOTH the
 * parallel driver (its local problem) and every pool worker (its replica), so
 * the two cannot diverge — the parallel-refinement exactness rests on this
 * single construction path.
 */
export function buildProblemForSpec(spec: EvaluatorSpec): RefinementProblem {
  if (spec.kind === "multiPhasePowder") {
    return buildMultiPhasePowderProblem([...spec.phases], spec.pattern, spec.parameters, spec.bindings, {
      shape: spec.shape,
      ...(spec.eta !== undefined ? { eta: spec.eta } : {}),
    }, spec.fitRange);
  }
  if (spec.kind === "singleCrystal") {
    return buildSingleCrystalRefinementProblem(spec.structure, spec.dataset, spec.parameters, spec.bindings);
  }
  if (spec.kind === "magneticSingleCrystal") {
    return buildMagneticSingleCrystalProblem(spec.structure, spec.magnetic, spec.dataset, spec.parameters, spec.bindings);
  }
  if (spec.kind === "magneticPowder") {
    return buildMagneticPowderProblem(spec.structure, spec.magnetic, spec.pattern, spec.parameters, spec.bindings, {
      shape: spec.shape,
      ...(spec.eta !== undefined ? { eta: spec.eta } : {}),
    }, spec.fitRange);
  }
  const profile: PowderProfile = {
    shape: spec.shape,
    ...(spec.eta !== undefined ? { eta: spec.eta } : {}),
    ...(spec.lorentz !== undefined ? { lorentz: spec.lorentz } : {}),
    ...(spec.backgroundType !== undefined ? { backgroundType: spec.backgroundType } : {}),
  };
  return buildPowderProblem(spec.structure, spec.pattern, spec.parameters, spec.bindings, profile, spec.restraints ?? [], spec.fitRange);
}

/** Per-cycle progress: the calculated pattern (data points only) + weighted R. */
export type PowderProgress = (yCalc: number[], rWeighted: number) => void;

export function runPowderRefinement(req: RefinePowderRequest, onProgress?: PowderProgress): RefinementResult {
  const profile: PowderProfile = {
    shape: req.shape,
    ...(req.eta !== undefined ? { eta: req.eta } : {}),
    ...(req.lorentz !== undefined ? { lorentz: req.lorentz } : {}),
    ...(req.backgroundType !== undefined ? { backgroundType: req.backgroundType } : {}),
  };
  const phases = req.extraPhases && req.extraPhases.length > 0
    ? [{ structure: req.structure, id: req.structure.id }, ...req.extraPhases.map((s) => ({ structure: s, id: s.id }))]
    : null;
  const build = (params: readonly RefinePowderRequest["parameters"][number][]) =>
    phases
      ? buildMultiPhasePowderProblem(phases, req.pattern, params, req.bindings, profile, req.fitRange)
      : buildPowderProblem(req.structure, req.pattern, params, req.bindings, profile, req.restraints ?? [], req.fitRange);

  const patternLen = req.pattern.points.length;
  const onIteration = onProgress
    ? (yCalc: Float64Array, agreement: AgreementFactors): void =>
        onProgress(Array.from(yCalc.subarray(0, patternLen)), agreement.rWeighted ?? 0)
    : undefined;
  const options: Partial<RefinementOptions> = { ...(req.options ?? {}), ...(onIteration ? { onIteration } : {}) };

  if (req.staged && req.staged.length > 0) {
    const out = refineStaged(req.parameters, build, stagesFromKindGroups(req.staged), options);
    if (out.final) return out.final;
  }
  return refine(build(req.parameters), options);
}
