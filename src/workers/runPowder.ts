/**
 * Shared powder-refinement runner for both the worker and the in-thread fallback,
 * so the two paths cannot diverge. Handles the flat co-refinement and the staged
 * (guided) sequence, rebuilding the profile from the request fields.
 */

import type { RefinePowderRequest } from "@/workers/protocol";
import type { AgreementFactors, RefinementOptions, RefinementResult } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { buildPowderProblem, type PowderProfile } from "@/core/workflow/powder";
import { refineStaged } from "@/core/refinement/staged";
import { stagesFromKindGroups } from "@/core/workflow/structureRefinement";

/** Per-cycle progress: the calculated pattern (data points only) + weighted R. */
export type PowderProgress = (yCalc: number[], rWeighted: number) => void;

export function runPowderRefinement(req: RefinePowderRequest, onProgress?: PowderProgress): RefinementResult {
  const profile: PowderProfile = {
    shape: req.shape,
    ...(req.eta !== undefined ? { eta: req.eta } : {}),
    ...(req.lorentz !== undefined ? { lorentz: req.lorentz } : {}),
    ...(req.backgroundType !== undefined ? { backgroundType: req.backgroundType } : {}),
  };
  const build = (params: readonly RefinePowderRequest["parameters"][number][]) =>
    buildPowderProblem(req.structure, req.pattern, params, req.bindings, profile, req.restraints ?? [], req.fitRange);

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
