/**
 * Data-agnostic non-linear least-squares refinement engine.
 *
 * Levenberg–Marquardt. Parameters the model depends on *linearly* (scale,
 * background) get an exact Jacobian column from a single evaluation; the rest use
 * a central-difference numerical Jacobian. The engine sees only numbers: a flat
 * parameter list, observations, weights, and a `calculate(values)` closure
 * supplied by the active workflow. It knows nothing about crystallography.
 */

import type {
  AgreementFactors,
  ParameterKind,
  RefinementIteration,
  RefinementOptions,
  RefinementParameter,
  RefinementResult,
  RefinementStatus,
} from "@/core/refinement/types";
import { chiSquared, computeAgreementFactors } from "@/core/refinement/factors";
import { invertMatrix, solveLinearSystem, type Matrix } from "@/core/math/linalg";

/** The problem handed to the engine. `calculate` maps all param values → y_calc. */
export interface RefinementProblem {
  readonly parameters: readonly RefinementParameter[];
  readonly observations: Float64Array;
  readonly weights: Float64Array;
  readonly calculate: (values: Readonly<Record<string, number>>) => Float64Array;
}

const DEFAULT_OPTIONS: RefinementOptions = {
  maxIterations: 20,
  convergenceTolerance: 1e-4,
  lambda: 1e-3,
};

/**
 * Kinds whose contribution to the calculated pattern is linear (affine) by
 * construction: `scale·I_calc`, `magneticScale·I_mag`, and `Σ c_k·basis_k(x)`
 * background terms. Used as the default when a parameter does not set `linear`.
 */
const LINEAR_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "scale",
  "background",
  "magneticScale",
]);

/** Whether the model is linear in this parameter (explicit flag, else by kind). */
function isLinear(p: RefinementParameter): boolean {
  return p.linear ?? LINEAR_KINDS.has(p.kind);
}

function clamp(value: number, p: RefinementParameter): number {
  let v = value;
  if (p.min !== undefined && v < p.min) v = p.min;
  if (p.max !== undefined && v > p.max) v = p.max;
  return v;
}

/**
 * Limit a per-cycle parameter shift to at most `MAX_REL_SHIFT`× the parameter's
 * current magnitude — a safety net against a single ill-conditioned step
 * launching the model out of its basin. Parameters at ~0 are left unlimited
 * (relying on the LM step-rejection loop), so refining toward/away from zero is
 * not blocked.
 */
const MAX_REL_SHIFT = 5;
function limitShift(delta: number, value: number): number {
  const cap = MAX_REL_SHIFT * Math.abs(value);
  return cap > 0 && Math.abs(delta) > cap ? Math.sign(delta) * cap : delta;
}

/** Build the full id→value record from base params overlaid with free values. */
function valuesRecord(
  params: readonly RefinementParameter[],
  freeIds: readonly string[],
  freeValues: readonly number[],
): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const p of params) rec[p.id] = p.value;
  for (let i = 0; i < freeIds.length; i++) rec[freeIds[i]!] = freeValues[i]!;
  return rec;
}

function weightedResiduals(
  yObs: Float64Array,
  yCalc: Float64Array,
  weights: Float64Array,
): Float64Array {
  const r = new Float64Array(yObs.length);
  for (let i = 0; i < yObs.length; i++) {
    r[i] = Math.sqrt(weights[i]!) * (yObs[i]! - yCalc[i]!);
  }
  return r;
}

/**
 * Jacobian J_ij = ∂r_i/∂p_j of the weighted residual r = √w·(obs − calc); the
 * −√w factor is folded in so J carries the residual's sign.
 *
 * Linear parameters (scale, background — the model is affine in them) get an
 * exact column: since `calc(base + h) = calc(base) + h·∂calc/∂p` with no
 * higher-order terms, `(calc(base + h) − baseline)/h` is the true derivative for
 * *any* step `h`, with zero truncation error. It reuses the already-computed
 * baseline y_calc, costing one `calculate()` call instead of the two a central
 * difference needs. The step is sized to the parameter's own magnitude (floored
 * at 1) so the perturbed contribution stays well clear of the baseline — no
 * catastrophic cancellation whether the parameter sits at ~1e-11 (scale) or
 * ~1e4 (a background coefficient).
 *
 * Non-linear parameters use a central difference as before.
 */
function computeJacobian(
  problem: RefinementProblem,
  freeParams: readonly RefinementParameter[],
  freeValues: number[],
  baseline: Float64Array,
): Matrix {
  const m = problem.observations.length;
  const n = freeValues.length;
  const freeIds = freeParams.map((p) => p.id);
  const jac: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  const sqrtW = new Float64Array(m);
  for (let i = 0; i < m; i++) sqrtW[i] = Math.sqrt(problem.weights[i]!);

  for (let j = 0; j < n; j++) {
    const base = freeValues[j]!;

    if (isLinear(freeParams[j]!)) {
      const h = Math.max(1, Math.abs(base));
      const forward = [...freeValues];
      forward[j] = base + h;
      const yF = problem.calculate(valuesRecord(problem.parameters, freeIds, forward));
      for (let i = 0; i < m; i++) {
        // r = √w·(obs − calc) ⇒ ∂r/∂p = −√w·∂calc/∂p.
        const dCalc = (yF[i]! - baseline[i]!) / h;
        jac[i]![j] = -sqrtW[i]! * dCalc;
      }
      continue;
    }

    const h = Math.max(1e-6, Math.abs(base) * 1e-5);
    const forward = [...freeValues];
    forward[j] = base + h;
    const yF = problem.calculate(valuesRecord(problem.parameters, freeIds, forward));

    const backward = [...freeValues];
    backward[j] = base - h;
    const yB = problem.calculate(valuesRecord(problem.parameters, freeIds, backward));

    for (let i = 0; i < m; i++) {
      const dCalc = (yF[i]! - yB[i]!) / (2 * h);
      jac[i]![j] = -sqrtW[i]! * dCalc;
    }
  }
  return jac;
}

/** JᵀJ and Jᵀr for the normal equations. */
function normalEquations(jac: Matrix, r: Float64Array): { jtj: Matrix; jtr: number[] } {
  const m = jac.length;
  const n = m > 0 ? jac[0]!.length : 0;
  const jtj: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const jtr = new Array<number>(n).fill(0);

  for (let i = 0; i < m; i++) {
    const row = jac[i]!;
    const ri = r[i]!;
    for (let a = 0; a < n; a++) {
      const ja = row[a]!;
      jtr[a]! += ja * ri;
      for (let b = a; b < n; b++) {
        jtj[a]![b]! += ja * row[b]!;
      }
    }
  }
  // Symmetric fill.
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < a; b++) {
      jtj[a]![b] = jtj[b]![a]!;
    }
  }
  return { jtj, jtr };
}

export function refine(
  problem: RefinementProblem,
  options: Partial<RefinementOptions> = {},
): RefinementResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const freeParams = problem.parameters.filter((p) => !p.fixed);
  const freeIds = freeParams.map((p) => p.id);
  const n = freeParams.length;

  const history: RefinementIteration[] = [];
  let freeValues = freeParams.map((p) => p.value);
  let lambda = opts.lambda ?? 1e-3;

  const evalChi = (vals: number[]): { yCalc: Float64Array; chi: number } => {
    const yCalc = problem.calculate(valuesRecord(problem.parameters, freeIds, vals));
    return { yCalc, chi: chiSquared(problem.observations, yCalc, problem.weights) };
  };

  if (n === 0) {
    const { yCalc, chi } = evalChi(freeValues);
    const agreement = computeAgreementFactors(problem.observations, yCalc, problem.weights, 0);
    return {
      status: "converged",
      parameters: valuesRecord(problem.parameters, [], []),
      esd: {},
      agreement,
      history: [{ iteration: 0, chiSquared: chi, agreement }],
      message: "No free parameters; evaluated current model.",
    };
  }

  let current = evalChi(freeValues);
  let status: RefinementStatus = "maxIterations";
  let lastJtj: Matrix | null = null;

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const r = weightedResiduals(problem.observations, current.yCalc, problem.weights);
    const jac = computeJacobian(problem, freeParams, freeValues, current.yCalc);
    const { jtj, jtr } = normalEquations(jac, r);
    lastJtj = jtj;

    // Gradient norm ‖Jᵀr‖: near zero means we sit at a (local) minimum.
    const gradNorm = Math.sqrt(jtr.reduce((acc, v) => acc + v * v, 0));

    // Diagonal preconditioning: rescale so JᵀJ has a unit diagonal before the
    // solve. This keeps the normal matrix well-conditioned even when parameters
    // span many orders of magnitude (scale ~1e-11, cell ~10, B ~1, xyz ~0.1),
    // which is the main cause of stalls/divergence. s_j = sqrt(JᵀJ_jj).
    const sc = jtj.map((row, j) => {
      const d = row[j]!;
      return d > 0 && Number.isFinite(d) ? Math.sqrt(d) : 1;
    });
    const A: Matrix = jtj.map((row, i) => row.map((v, j) => v / (sc[i]! * sc[j]!)));
    const b = jtr.map((g, i) => g / sc[i]!);

    // LM damping on the (unit-diagonal) scaled system; retry with larger λ.
    let stepAccepted = false;
    for (let attempt = 0; attempt < 15 && !stepAccepted; attempt++) {
      const damped: Matrix = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda : v)));
      let y: number[];
      try {
        // Solve (D·JᵀJ·D + λI)·y = −D·Jᵀr, then unscale Δp_j = y_j / s_j.
        y = solveLinearSystem(damped, b.map((v) => -v));
      } catch {
        lambda *= 10;
        continue;
      }

      const delta = y.map((yj, j) => limitShift(yj / sc[j]!, freeValues[j]!));
      if (delta.some((d) => !Number.isFinite(d))) { lambda *= 10; continue; }

      const trial = freeValues.map((v, j) => clamp(v + delta[j]!, freeParams[j]!));
      const trialEval = evalChi(trial);

      // Reject non-finite objectives (overflow/NaN) as well as uphill steps.
      if (Number.isFinite(trialEval.chi) && trialEval.chi < current.chi) {
        freeValues = trial;
        current = trialEval;
        lambda = Math.max(lambda / 3, 1e-12);
        stepAccepted = true;
      } else {
        lambda *= 3;
      }
    }

    const agreement = computeAgreementFactors(
      problem.observations,
      current.yCalc,
      problem.weights,
      n,
    );
    history.push({ iteration: iter + 1, chiSquared: current.chi, agreement });

    if (!stepAccepted) {
      // No downhill step exists. If the gradient is essentially zero we are at
      // a minimum (converged); otherwise the search genuinely stalled.
      status = gradNorm < 1e-6 * (1 + current.chi) ? "converged" : "stalled";
      break;
    }
    if (history.length >= 2) {
      const prev = history[history.length - 2]!.chiSquared;
      const rel = Math.abs(prev - current.chi) / Math.max(prev, 1e-30);
      if (rel < opts.convergenceTolerance) {
        status = "converged";
        break;
      }
    }
  }

  // Covariance & esds from (JᵀJ)⁻¹ scaled by reduced χ² (GoF²).
  const esd: Record<string, number> = {};
  const dof = Math.max(problem.observations.length - n, 1);
  const reducedChi = current.chi / dof;
  if (lastJtj) {
    try {
      const cov = invertMatrix(lastJtj);
      for (let j = 0; j < n; j++) {
        const variance = cov[j]![j]! * reducedChi;
        esd[freeIds[j]!] = variance > 0 ? Math.sqrt(variance) : 0;
      }
    } catch {
      // Singular normal matrix: leave esds unset.
    }
  }

  const finalValues = valuesRecord(problem.parameters, freeIds, freeValues);
  const agreement: AgreementFactors = computeAgreementFactors(
    problem.observations,
    current.yCalc,
    problem.weights,
    n,
  );

  return {
    status,
    parameters: finalValues,
    esd,
    agreement,
    history,
    message: `${status} after ${history.length} iteration(s)`,
  };
}
