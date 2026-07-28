/**
 * Sequential refinement: one parameter set refined against an ORDERED SERIES of
 * datasets (a temperature/pressure/composition series), each fit seeded from
 * the previous dataset's refined values — the GSAS-II "sequential refinement"
 * workflow, engine-level and domain-blind.
 *
 * This is the third residual topology next to single-dataset fitting and
 * multi-dataset co-refinement (one concatenated residual, shared structure):
 * here every dataset gets its OWN copy of the parameters, and what links the
 * series is only the seeding, so parameters may drift freely along the series
 * (cell vs T, moment vs T…). The controller sees only `RefinementProblem`s, so
 * Rietveld (powder), PDF, or any other workflow shares it verbatim — the
 * datasets supply a problem factory, nothing else (the "one engine, many
 * workflows" seam, applied along the series axis).
 */

import type {
  RefinementOptions,
  RefinementParameter,
  RefinementResult,
} from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";

/** One dataset of the series: an id plus a problem factory over the (seeded)
 *  parameter set. The factory owns everything domain-specific. */
export interface SequentialDataset {
  readonly id: string;
  readonly label?: string;
  readonly buildProblem: (parameters: readonly RefinementParameter[]) => RefinementProblem;
}

export interface SequentialStep {
  readonly datasetId: string;
  readonly label?: string;
  readonly result: RefinementResult;
  /** The full parameter set with this dataset's refined values folded in —
   *  exactly what seeded the NEXT dataset (when `carried`). */
  readonly parameters: RefinementParameter[];
  /** False when this step's values were rejected as the next seed
   *  (diverged/failed status under `rejectDiverged`). */
  readonly carried: boolean;
}

export interface SequentialOptions {
  readonly refineOptions?: Partial<RefinementOptions>;
  /**
   * Seed each dataset from the previous refined values (default true) — the
   * defining feature of a sequential refinement, letting a slowly drifting
   * parameter track the series. False refines every dataset from the initial
   * set (independent "batch" mode: same results, no path dependence).
   */
  readonly seedFromPrevious?: boolean;
  /**
   * Refuse to carry a diverged/failed step's values into the next seed
   * (default true): the next dataset reseeds from the last good step instead,
   * so one broken pattern cannot derail the rest of the series.
   */
  readonly rejectDiverged?: boolean;
  /** Progress callback after each dataset completes. */
  readonly onStep?: (step: SequentialStep, index: number, total: number) => void;
}

/** Per-parameter value/esd tracks along the series — the deliverable of a
 *  sequential refinement (plot a(T), moment(T), …). Indexed like `steps`. */
export interface SequentialEvolution {
  readonly parameterId: string;
  readonly values: (number | undefined)[];
  readonly esd: (number | undefined)[];
}

export interface SequentialResult {
  readonly steps: SequentialStep[];
  readonly evolution: SequentialEvolution[];
}

const BAD_SEED: ReadonlySet<RefinementResult["status"]> = new Set(["diverged", "failed"]);

/** Clone `params` restarted at `values`: value AND initialValue take the seed,
 *  so each step's Δ/reset semantics are local to its own fit. */
function seeded(
  params: readonly RefinementParameter[],
  values: Readonly<Record<string, number>> | null,
): RefinementParameter[] {
  return params.map((p) => {
    const v = values?.[p.id] ?? p.value;
    return { ...p, value: v, initialValue: v };
  });
}

/** Fold one dataset's result into the running series state (shared between the
 *  sync and async controllers so their carry/reject semantics cannot drift). */
function recordStep(
  dataset: SequentialDataset,
  params: readonly RefinementParameter[],
  result: RefinementResult,
  rejectDiverged: boolean,
): SequentialStep {
  const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  return {
    datasetId: dataset.id,
    ...(dataset.label !== undefined ? { label: dataset.label } : {}),
    result,
    parameters: refined,
    carried: !(rejectDiverged && BAD_SEED.has(result.status)),
  };
}

function evolutionOf(
  initialParameters: readonly RefinementParameter[],
  steps: readonly SequentialStep[],
): SequentialEvolution[] {
  return initialParameters.map((p) => ({
    parameterId: p.id,
    values: steps.map((s) => s.result.parameters[p.id]),
    esd: steps.map((s) => s.result.esd[p.id]),
  }));
}

export function refineSequential(
  initialParameters: readonly RefinementParameter[],
  datasets: readonly SequentialDataset[],
  options: SequentialOptions = {},
): SequentialResult {
  const seedFromPrevious = options.seedFromPrevious ?? true;
  const rejectDiverged = options.rejectDiverged ?? true;
  const steps: SequentialStep[] = [];
  let seedValues: Readonly<Record<string, number>> | null = null;

  datasets.forEach((dataset, index) => {
    const params = seeded(initialParameters, seedFromPrevious ? seedValues : null);
    const problem = dataset.buildProblem(params);
    const result = refine(problem, options.refineOptions ?? {});
    const step = recordStep(dataset, params, result, rejectDiverged);
    if (step.carried) seedValues = result.parameters;
    steps.push(step);
    options.onStep?.(step, index, datasets.length);
  });

  return { steps, evolution: evolutionOf(initialParameters, steps) };
}

/**
 * The solver one async sequential step delegates to. The default is the serial
 * in-thread `refine`; a pooled driver passes `refineParallel` bound to its
 * evaluator pool (re-initialized per dataset by the caller — the runner sees
 * the dataset and index for exactly that purpose).
 */
export type SequentialRunner = (
  problem: RefinementProblem,
  options: Partial<RefinementOptions>,
  dataset: SequentialDataset,
  index: number,
) => Promise<RefinementResult>;

/**
 * The async twin of {@link refineSequential}: identical seeding/carry
 * semantics (shared helpers), but each dataset's solve is awaited from a
 * runner — the seam that lets the browser client fan each step's Jacobian over
 * its evaluator-worker pool while node/tests stay on the serial engine. A
 * runner rejection (e.g. a cancelled pool) propagates after the completed
 * steps' `onStep` callbacks have fired, so a cancelling caller keeps the
 * partial series it already received.
 */
export async function refineSequentialAsync(
  initialParameters: readonly RefinementParameter[],
  datasets: readonly SequentialDataset[],
  options: SequentialOptions = {},
  run: SequentialRunner = async (problem, refineOptions) => refine(problem, refineOptions),
): Promise<SequentialResult> {
  const seedFromPrevious = options.seedFromPrevious ?? true;
  const rejectDiverged = options.rejectDiverged ?? true;
  const steps: SequentialStep[] = [];
  let seedValues: Readonly<Record<string, number>> | null = null;

  for (let index = 0; index < datasets.length; index++) {
    const dataset = datasets[index]!;
    const params = seeded(initialParameters, seedFromPrevious ? seedValues : null);
    const problem = dataset.buildProblem(params);
    const result = await run(problem, options.refineOptions ?? {}, dataset, index);
    const step = recordStep(dataset, params, result, rejectDiverged);
    if (step.carried) seedValues = result.parameters;
    steps.push(step);
    options.onStep?.(step, index, datasets.length);
  }

  return { steps, evolution: evolutionOf(initialParameters, steps) };
}
