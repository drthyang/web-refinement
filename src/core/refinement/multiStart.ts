/**
 * Multi-start (basin-hopping) refinement — escaping local minima.
 *
 * Levenberg–Marquardt is a *local* optimizer: it descends to the nearest minimum
 * of χ² from wherever it starts. On a rugged crystallographic χ² surface (peak
 * overlap, profile↔structure correlation, a narrow fit range with few peaks) that
 * minimum is often not the global one. Multi-start attacks this directly: refine
 * once, then re-refine from several *perturbed* starting points and keep the
 * result with the lowest χ². Each perturbation kicks the free parameters by a few
 * times their own esd (the natural scale of the local basin), so the restarts
 * spread across neighbouring basins rather than a fixed, kind-blind step.
 *
 * The driver is injection-based and driver-agnostic: `runOnce` performs one full
 * refinement (flat or staged, serial or pool-parallel) from a given starting
 * parameter set and reports the converged values + esds + final result. So the
 * same routine powers a lightweight on-convergence escape check (one restart, a
 * ~1σ kick) and a thorough search (many restarts, a wider kick).
 */

import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";

/** One full refinement from a starting parameter set: the converged parameter
 *  objects (values + esds written back) and the final engine result. */
export interface MultiStartRunResult {
  readonly parameters: RefinementParameter[];
  readonly final: RefinementResult;
}

/** Perform one full refinement from `start`. May be async (pool-backed). */
export type MultiStartRun = (
  start: readonly RefinementParameter[],
) => MultiStartRunResult | Promise<MultiStartRunResult>;

export interface MultiStartOptions {
  /** Number of perturbed restarts beyond the baseline run. Default 8. */
  readonly restarts?: number;
  /** Kick size in esd units: each free parameter is displaced by up to
   *  ±escapeSigma·esd. Default 4. */
  readonly escapeSigma?: number;
  /** Fallback kick as a fraction of |value| when a parameter has no usable esd
   *  (e.g. a mode seeded at 0 gets no kick from esd alone). Default 0.05. */
  readonly relFraction?: number;
  /** Seed for the deterministic RNG (reproducible restarts/tests). Default set. */
  readonly seed?: number;
  /** Restrict the perturbation to a parameter subspace: when set, only free
   *  parameters for which this returns true are kicked between restarts (the
   *  rest keep their baseline value). Used by the magnetic path to perturb only
   *  the moment modes and leave the (frozen) nuclear scaffold alone. Default:
   *  perturb every free parameter. */
  readonly shouldPerturb?: (parameter: RefinementParameter) => boolean;
  /** Relative χ² drop below the baseline needed to report `improved`. Default 1e-4. */
  readonly minImprovement?: number;
  /** Called after each start with its 0-based index (0 = baseline), its χ² cost,
   *  and whether it is the best so far — for progress reporting. */
  readonly onStart?: (index: number, cost: number, isBest: boolean) => void;
}

export interface MultiStartResult {
  /** The best (lowest-χ²) run's engine result. */
  readonly final: RefinementResult;
  /** The best run's converged parameter objects (values + esds). */
  readonly parameters: RefinementParameter[];
  /** Number of perturbed restarts actually run. */
  readonly restartsRun: number;
  /** Index of the winning start (0 = baseline, ≥1 = a perturbed restart). */
  readonly bestStartIndex: number;
  /** True when a perturbed restart beat the baseline by ≥ minImprovement. */
  readonly improved: boolean;
  /** Final χ² of each start, index-aligned (0 = baseline). */
  readonly costByStart: number[];
}

/** Deterministic 32-bit PRNG (mulberry32) → uniform [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** χ² of a converged result (the LM objective), for comparing starts. Falls back
 *  to the weighted/plain R factor when no χ² history is present. */
export function refinementCost(result: RefinementResult): number {
  const last = result.history[result.history.length - 1];
  if (last && Number.isFinite(last.chiSquared)) return last.chiSquared;
  const { rWeighted, rFactor } = result.agreement;
  if (rWeighted !== undefined && Number.isFinite(rWeighted)) return rWeighted;
  if (rFactor !== undefined && Number.isFinite(rFactor)) return rFactor;
  return Number.POSITIVE_INFINITY;
}

/**
 * Perturb the free parameters of `base` for a restart. Fixed and tied
 * (`expression`) parameters are never moved. The kick scale for a free parameter
 * is `max(escapeSigma·esd, relFraction·|value|)`, capped at half its bound span
 * so a huge esd can't fling it out of the physical range; the displacement is
 * uniform in ±scale and clamped to the bounds.
 */
export function perturbParameters(
  base: readonly RefinementParameter[],
  esd: Readonly<Record<string, number>>,
  rng: () => number,
  opts: { escapeSigma: number; relFraction: number; shouldPerturb?: (p: RefinementParameter) => boolean },
): RefinementParameter[] {
  return base.map((p) => {
    if (p.fixed || p.expression) return { ...p };
    if (opts.shouldPerturb && !opts.shouldPerturb(p)) return { ...p };
    const e = esd[p.id];
    let scale = Math.max(e !== undefined && e > 0 ? e * opts.escapeSigma : 0, Math.abs(p.value) * opts.relFraction);
    if (p.min !== undefined && p.max !== undefined && p.max > p.min) {
      scale = Math.min(scale, 0.5 * (p.max - p.min));
    }
    if (!(scale > 0)) return { ...p };
    let v = p.value + (rng() * 2 - 1) * scale;
    if (p.min !== undefined) v = Math.max(v, p.min);
    if (p.max !== undefined) v = Math.min(v, p.max);
    return { ...p, value: v };
  });
}

/**
 * Run a baseline refinement then `restarts` perturbed restarts (each via
 * `runOnce`), keeping the lowest-χ² result. Restarts perturb the *baseline's*
 * converged point (independent draws around one basin's rim), so a genuinely
 * better basin is found without walking away from a good solution.
 */
export async function refineMultiStart(
  startParams: readonly RefinementParameter[],
  runOnce: MultiStartRun,
  options: MultiStartOptions = {},
): Promise<MultiStartResult> {
  const restarts = Math.max(0, options.restarts ?? 8);
  const escapeSigma = options.escapeSigma ?? 4;
  const relFraction = options.relFraction ?? 0.05;
  const minImprovement = options.minImprovement ?? 1e-4;
  const rng = mulberry32((options.seed ?? 0xc0ffee) >>> 0);

  const base = await runOnce(startParams);
  const baseCost = refinementCost(base.final);
  const costByStart: number[] = [baseCost];
  options.onStart?.(0, baseCost, true);

  let best = base;
  let bestCost = baseCost;
  let bestStartIndex = 0;

  for (let k = 1; k <= restarts; k++) {
    const perturbed = perturbParameters(base.parameters, base.final.esd, rng, {
      escapeSigma,
      relFraction,
      ...(options.shouldPerturb ? { shouldPerturb: options.shouldPerturb } : {}),
    });
    const cand = await runOnce(perturbed);
    const cost = refinementCost(cand.final);
    costByStart.push(cost);
    const isBest = cost < bestCost;
    if (isBest) {
      best = cand;
      bestCost = cost;
      bestStartIndex = k;
    }
    options.onStart?.(k, cost, isBest);
  }

  return {
    final: best.final,
    parameters: best.parameters,
    restartsRun: restarts,
    bestStartIndex,
    improved: bestStartIndex > 0 && bestCost < baseCost * (1 - minImprovement),
    costByStart,
  };
}
