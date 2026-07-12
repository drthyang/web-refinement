/**
 * Staged (guided) refinement driver.
 *
 * Structure refinement diverges when every parameter is freed at once: a wrong
 * scale corrupts the position gradients, a wrong background masks the peaks, and
 * the coupled solve wanders. The expert workflow instead unlocks parameters in
 * order of how strongly and how linearly they act on the pattern —
 *   scale → background → cell → profile width → ADP → positions → occupancy —
 * refining each group to convergence before adding the next, and carrying the
 * converged values forward. Groups are *cumulative*: once freed, a parameter
 * stays free in every later stage, so the final stage is a full co-refinement
 * seeded from a good point.
 *
 * The driver is crystallography-blind. It toggles each parameter's `fixed` flag
 * per stage, rebuilds the problem through a caller-supplied factory (so the
 * closure captures the updated values), runs the base `refine`, and writes the
 * converged values back onto the parameter objects.
 */

import type { RefinementOptions, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";

/** One stage: a name and a predicate selecting the parameters it unlocks. */
export interface RefinementStage {
  readonly name: string;
  /** Parameters (by object) this stage adds to the free set. */
  readonly select: (p: RefinementParameter) => boolean;
}

/** Per-stage record of what ran and how it ended. */
export interface StageResult {
  readonly name: string;
  /** Ids of the parameters free during this stage (cumulative). */
  readonly freeIds: readonly string[];
  readonly result: RefinementResult;
}

export interface StagedRefinementResult {
  /** Parameter objects with their final refined values and esds. */
  readonly parameters: RefinementParameter[];
  readonly stages: StageResult[];
  /** The last stage's result (full co-refinement); undefined if no stage ran. */
  readonly final?: RefinementResult;
}

/**
 * Run a cumulative staged refinement. `parameters` is the full working set;
 * `buildProblem` rebuilds the `RefinementProblem` from a parameter list (its
 * `calculate` closure must read the passed parameters' current values). Stages
 * unlock parameters in order. Parameters that no stage selects, and those the
 * caller pre-marked `fixed`, stay fixed throughout.
 *
 * Returns copies of the parameters (the input array is not mutated).
 */
export function refineStaged(
  parameters: readonly RefinementParameter[],
  buildProblem: (params: readonly RefinementParameter[]) => RefinementProblem,
  stages: readonly RefinementStage[],
  options: Partial<RefinementOptions> = {},
): StagedRefinementResult {
  // Work on copies; remember which were caller-fixed so a stage cannot free one
  // the caller deliberately held (a stage widens the free set, never overrides).
  const work: RefinementParameter[] = parameters.map((p) => ({ ...p }));
  const lockedByCaller = new Set(parameters.filter((p) => p.fixed).map((p) => p.id));
  const freed = new Set<string>();
  const stageResults: StageResult[] = [];
  let final: RefinementResult | undefined;

  for (const stage of stages) {
    for (const p of work) {
      if (!lockedByCaller.has(p.id) && stage.select(p)) freed.add(p.id);
    }
    // No point running a stage that unlocks nothing new.
    const freeIds = work.filter((p) => freed.has(p.id)).map((p) => p.id);
    if (freeIds.length === 0) {
      stageResults.push({ name: stage.name, freeIds: [], result: emptyStage() });
      continue;
    }
    for (const p of work) p.fixed = !freed.has(p.id);

    const result = refine(buildProblem(work), options);
    for (const p of work) {
      const v = result.parameters[p.id];
      if (v !== undefined) p.value = v;
      const e = result.esd[p.id];
      if (e !== undefined) p.esd = e;
    }
    stageResults.push({ name: stage.name, freeIds, result });
    final = result;
  }

  return { parameters: work, stages: stageResults, ...(final !== undefined ? { final } : {}) };
}

function emptyStage(): RefinementResult {
  return {
    status: "converged",
    parameters: {},
    esd: {},
    agreement: { rFactor: 0 },
    history: [],
    message: "Stage unlocked no new parameters.",
  };
}


/** A refinement runner: the serial `refine` or a parallel/pooled variant. */
export type StagedRefiner = (
  problem: RefinementProblem,
  options: Partial<RefinementOptions>,
) => RefinementResult | Promise<RefinementResult>;

/**
 * `refineStaged` with an injectable (possibly async) refiner, so the staged
 * sequence can run each stage through the parallel evaluator pool. The loop
 * body mirrors `refineStaged` exactly — `staged.test.ts` pins the two to
 * identical results when given the serial refiner.
 */
export async function refineStagedAsync(
  parameters: readonly RefinementParameter[],
  buildProblem: (params: readonly RefinementParameter[]) => RefinementProblem,
  stages: readonly RefinementStage[],
  options: Partial<RefinementOptions> = {},
  refiner: StagedRefiner = refine,
): Promise<StagedRefinementResult> {
  const work: RefinementParameter[] = parameters.map((p) => ({ ...p }));
  const lockedByCaller = new Set(parameters.filter((p) => p.fixed).map((p) => p.id));
  const freed = new Set<string>();
  const stageResults: StageResult[] = [];
  let final: RefinementResult | undefined;

  for (const stage of stages) {
    for (const p of work) {
      if (!lockedByCaller.has(p.id) && stage.select(p)) freed.add(p.id);
    }
    const freeIds = work.filter((p) => freed.has(p.id)).map((p) => p.id);
    if (freeIds.length === 0) {
      stageResults.push({ name: stage.name, freeIds: [], result: emptyStage() });
      continue;
    }
    for (const p of work) p.fixed = !freed.has(p.id);
    const result = await refiner(buildProblem(work), options);
    for (const p of work) {
      const v = result.parameters[p.id];
      if (v !== undefined) p.value = v;
      const e = result.esd[p.id];
      if (e !== undefined) p.esd = e;
    }
    stageResults.push({ name: stage.name, freeIds, result });
    final = result;
  }

  return { parameters: work, stages: stageResults, ...(final !== undefined ? { final } : {}) };
}
