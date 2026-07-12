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

  /** Present when the controller rejected this stage: its newly-freed
   *  parameters were re-fixed and every value reverted to the pre-stage
   *  state before continuing with the next stage. */
  readonly rejected?: { readonly reason: string };
  /** Newly-freed parameters the controller re-fixed (kept the stage,
   *  reverted just these to their pre-stage values). */
  readonly refixed?: readonly { readonly id: string; readonly reason: string }[];
}

export interface StagedRefinementResult {
  /** Parameter objects with their final refined values and esds. */
  readonly parameters: RefinementParameter[];
  readonly stages: StageResult[];
  /** The last stage's result (full co-refinement); undefined if no stage ran. */
  readonly final?: RefinementResult;
}

/**
 * Controller guards (roadmap F1.4): parameter additions that make the model
 * WORSE are rejected rather than carried forward — at the right granularity.
 *
 * STAGE-level rejection (revert everything the stage did) only for genuine
 * divergence: the wR worsened (freeing parameters can only ever lower χ² at
 * the optimum), or freeing the new group INFLATED the esds of previously
 * determined parameters (the classic "adding X destabilizes everything").
 *
 * PARAMETER-level refixing (keep the stage, re-fix the culprit at its
 * pre-stage value) for solver-proven pathologies of individual newly-freed
 * parameters: a singular direction, or a near-perfect correlation. One weak
 * parameter must not discard its well-behaved siblings' gains.
 */
export interface StageGuardOptions {
  /** Master switch. Default true. */
  readonly enabled?: boolean;
  /** Max tolerated relative wR increase vs the last accepted stage. Default 1e-3. */
  readonly maxWrIncrease?: number;
  /** Reject the stage when a previously-free parameter's esd grows by ≥ this
   *  factor after the addition. Default 5. */
  readonly maxEsdInflation?: number;
  /** Re-fix a newly-freed parameter sitting in |ρ| ≥ this. Default 0.998. */
  readonly maxCorrelation?: number;
}

interface StageGuardVerdict {
  /** Reject the whole stage (revert values, re-fix its additions). */
  readonly stageReason: string | null;
  /** Individual newly-freed parameters to re-fix while keeping the stage. */
  readonly refix: { readonly id: string; readonly reason: string }[];
}

function stageGuardVerdict(
  prev: { wr: number | undefined; esd: ReadonlyMap<string, number>; singular: ReadonlySet<string> },
  result: RefinementResult,
  previouslyFree: readonly string[],
  newlyFreed: readonly string[],
  guards: StageGuardOptions,
): StageGuardVerdict {
  if (guards.enabled === false) return { stageReason: null, refix: [] };

  const wr = result.agreement.rWeighted;
  const maxInc = guards.maxWrIncrease ?? 1e-3;
  if (prev.wr !== undefined && wr !== undefined && wr > prev.wr * (1 + maxInc) + 1e-12) {
    return { stageReason: `wR worsened: ${(100 * prev.wr).toFixed(3)}% → ${(100 * wr).toFixed(3)}%`, refix: [] };
  }
  const maxInfl = guards.maxEsdInflation ?? 5;
  for (const id of previouslyFree) {
    const before = prev.esd.get(id);
    const after = result.esd[id];
    if (before !== undefined && before > 0 && after !== undefined && after > maxInfl * before && after > 1e-8) {
      return {
        stageReason: `freeing ${newlyFreed.join(", ")} inflated esd(${id}) ${(after / before).toFixed(1)}×`,
        refix: [],
      };
    }
  }

  const refix: { id: string; reason: string }[] = [];
  const fresh = new Set(newlyFreed);
  // Singular directions the solver reported may name EITHER member of a
  // degenerate pair. Attribution rule: any singular id that was not singular
  // in the last accepted stage is evidence against THIS stage's additions —
  // re-fix the singular ids that are fresh, and when the newly-singular id is
  // an old parameter (the newcomer shadowed or duplicated it), re-fix the
  // fresh ones instead.
  const singularNow = result.diagnostics?.singularParameterIds ?? [];
  const newSingular = singularNow.filter((id) => !prev.singular.has(id));
  for (const id of newSingular) {
    if (fresh.has(id)) refix.push({ id, reason: "singular direction" });
  }
  if (newSingular.length > 0 && refix.length === 0) {
    for (const id of newlyFreed) {
      refix.push({ id, reason: `made ${newSingular.join(", ")} singular` });
    }
  }
  const maxCorr = guards.maxCorrelation ?? 0.998;
  for (const c of result.diagnostics?.highCorrelations ?? []) {
    if (Math.abs(c.coefficient) < maxCorr) continue;
    // Re-fix the NEW member of the pair (the older one was fine before).
    const target = fresh.has(c.parameterIdA) ? c.parameterIdA : fresh.has(c.parameterIdB) ? c.parameterIdB : null;
    if (target && !refix.some((r) => r.id === target)) {
      refix.push({ id: target, reason: `|ρ|=${Math.abs(c.coefficient).toFixed(4)} with ${target === c.parameterIdA ? c.parameterIdB : c.parameterIdA}` });
    }
  }
  return { stageReason: null, refix };
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
  guards: StageGuardOptions = {},
): StagedRefinementResult {
  // Work on copies; remember which were caller-fixed so a stage cannot free one
  // the caller deliberately held (a stage widens the free set, never overrides).
  const work: RefinementParameter[] = parameters.map((p) => ({ ...p }));
  const lockedByCaller = new Set(parameters.filter((p) => p.fixed).map((p) => p.id));
  const freed = new Set<string>();
  const stageResults: StageResult[] = [];
  let final: RefinementResult | undefined;

  let lastAcceptedWr: number | undefined;
  let lastAcceptedEsd: ReadonlyMap<string, number> = new Map();
  let lastAcceptedSingular: ReadonlySet<string> = new Set();
  for (const stage of stages) {
    const newlyFreed: string[] = [];
    for (const p of work) {
      if (!lockedByCaller.has(p.id) && stage.select(p) && !freed.has(p.id)) {
        freed.add(p.id);
        newlyFreed.push(p.id);
      }
    }
    // No point running a stage that unlocks nothing new.
    const freeIds = work.filter((p) => freed.has(p.id)).map((p) => p.id);
    if (freeIds.length === 0) {
      stageResults.push({ name: stage.name, freeIds: [], result: emptyStage() });
      continue;
    }
    for (const p of work) p.fixed = !freed.has(p.id);

    const before = new Map(work.map((p) => [p.id, p.value]));
    const previouslyFree = freeIds.filter((id) => !newlyFreed.includes(id));
    const result = refine(buildProblem(work), options);
    const verdict = stageGuardVerdict({ wr: lastAcceptedWr, esd: lastAcceptedEsd, singular: lastAcceptedSingular }, result, previouslyFree, newlyFreed, guards);
    if (verdict.stageReason !== null) {
      // Revert: this stage's additions come back out; values roll back.
      for (const id of newlyFreed) freed.delete(id);
      for (const p of work) {
        p.value = before.get(p.id)!;
        p.fixed = !freed.has(p.id);
      }
      stageResults.push({ name: stage.name, freeIds, result, rejected: { reason: verdict.stageReason } });
      continue;
    }
    const refixSet = new Set(verdict.refix.map((r) => r.id));
    for (const p of work) {
      if (refixSet.has(p.id)) {
        p.value = before.get(p.id)!;
        p.fixed = true;
        freed.delete(p.id);
        continue;
      }
      const v = result.parameters[p.id];
      if (v !== undefined) p.value = v;
      const e = result.esd[p.id];
      if (e !== undefined) p.esd = e;
    }
    stageResults.push({ name: stage.name, freeIds, result, ...(verdict.refix.length ? { refixed: verdict.refix } : {}) });
    final = result;
    lastAcceptedWr = result.agreement.rWeighted ?? lastAcceptedWr;
    lastAcceptedEsd = new Map(freeIds.filter((id) => !refixSet.has(id)).map((id) => [id, result.esd[id] ?? 0]));
    lastAcceptedSingular = new Set(result.diagnostics?.singularParameterIds ?? []);
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
  guards: StageGuardOptions = {},
): Promise<StagedRefinementResult> {
  const work: RefinementParameter[] = parameters.map((p) => ({ ...p }));
  const lockedByCaller = new Set(parameters.filter((p) => p.fixed).map((p) => p.id));
  const freed = new Set<string>();
  const stageResults: StageResult[] = [];
  let final: RefinementResult | undefined;

  let lastAcceptedWr: number | undefined;
  let lastAcceptedEsd: ReadonlyMap<string, number> = new Map();
  let lastAcceptedSingular: ReadonlySet<string> = new Set();
  for (const stage of stages) {
    const newlyFreed: string[] = [];
    for (const p of work) {
      if (!lockedByCaller.has(p.id) && stage.select(p) && !freed.has(p.id)) {
        freed.add(p.id);
        newlyFreed.push(p.id);
      }
    }
    const freeIds = work.filter((p) => freed.has(p.id)).map((p) => p.id);
    if (freeIds.length === 0) {
      stageResults.push({ name: stage.name, freeIds: [], result: emptyStage() });
      continue;
    }
    for (const p of work) p.fixed = !freed.has(p.id);
    const before = new Map(work.map((p) => [p.id, p.value]));
    const previouslyFree = freeIds.filter((id) => !newlyFreed.includes(id));
    const result = await refiner(buildProblem(work), options);
    const verdict = stageGuardVerdict({ wr: lastAcceptedWr, esd: lastAcceptedEsd, singular: lastAcceptedSingular }, result, previouslyFree, newlyFreed, guards);
    if (verdict.stageReason !== null) {
      // Revert: this stage's additions come back out; values roll back.
      for (const id of newlyFreed) freed.delete(id);
      for (const p of work) {
        p.value = before.get(p.id)!;
        p.fixed = !freed.has(p.id);
      }
      stageResults.push({ name: stage.name, freeIds, result, rejected: { reason: verdict.stageReason } });
      continue;
    }
    const refixSet = new Set(verdict.refix.map((r) => r.id));
    for (const p of work) {
      if (refixSet.has(p.id)) {
        p.value = before.get(p.id)!;
        p.fixed = true;
        freed.delete(p.id);
        continue;
      }
      const v = result.parameters[p.id];
      if (v !== undefined) p.value = v;
      const e = result.esd[p.id];
      if (e !== undefined) p.esd = e;
    }
    stageResults.push({ name: stage.name, freeIds, result, ...(verdict.refix.length ? { refixed: verdict.refix } : {}) });
    final = result;
    lastAcceptedWr = result.agreement.rWeighted ?? lastAcceptedWr;
    lastAcceptedEsd = new Map(freeIds.filter((id) => !refixSet.has(id)).map((id) => [id, result.esd[id] ?? 0]));
    lastAcceptedSingular = new Set(result.diagnostics?.singularParameterIds ?? []);
  }

  return { parameters: work, stages: stageResults, ...(final !== undefined ? { final } : {}) };
}
