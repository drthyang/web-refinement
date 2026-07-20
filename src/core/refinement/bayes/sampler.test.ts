import { describe, it, expect } from "vitest";
import type { RefinementParameter } from "@/core/refinement/types";
import type { BatchEvaluator, RefinementProblem } from "@/core/refinement/engine";
import {
  sampleCore,
  samplePosterior,
  samplePosteriorParallel,
  type SampleOptions,
} from "@/core/refinement/bayes/sampler";

/**
 * The ensemble-sampler gates. The stochastic assertions (posterior moments) are
 * deliberately loose; the structural assertions (serial/pool bit-identity,
 * resume equivalence, seeded determinism) are exact — those are the invariants
 * that must never silently break.
 */

const param = (
  id: string,
  value: number,
  over: Partial<RefinementParameter> = {},
): RefinementParameter => ({
  id,
  label: id,
  kind: "pdfScale",
  value,
  initialValue: value,
  fixed: false,
  linear: false,
  ...over,
});

/**
 * Linear-Gaussian toy problem y = A·θ with EXACT posterior: under the "fixed"
 * noise model (logL = −χ²/2, unit weights) and flat priors, the posterior is
 * N(θ_true, (AᵀA)⁻¹). Two parameters with deliberately correlated columns so
 * the sampler must reproduce a non-trivial covariance.
 */
function linearGaussianProblem(): {
  problem: RefinementProblem;
  exactMean: [number, number];
  exactCov: [[number, number], [number, number]];
} {
  const n = 60;
  const thetaTrue: [number, number] = [1.4, -0.6];
  // Column 1: slowly varying; column 2: correlated with column 1 (ρ ≈ moderate).
  const A: [number, number][] = Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return [1 + 0.5 * x, 0.7 + 0.6 * x] as [number, number];
  });
  const yObs = new Float64Array(n);
  for (let i = 0; i < n; i++) yObs[i] = A[i]![0] * thetaTrue[0] + A[i]![1] * thetaTrue[1];

  // (AᵀA)⁻¹ analytically (2×2).
  let s00 = 0;
  let s01 = 0;
  let s11 = 0;
  for (const [a0, a1] of A) {
    s00 += a0 * a0;
    s01 += a0 * a1;
    s11 += a1 * a1;
  }
  const det = s00 * s11 - s01 * s01;
  const exactCov: [[number, number], [number, number]] = [
    [s11 / det, -s01 / det],
    [-s01 / det, s00 / det],
  ];

  const parameters = [param("t0", thetaTrue[0]), param("t1", thetaTrue[1])];
  const problem: RefinementProblem = {
    parameters,
    observations: yObs,
    weights: new Float64Array(n).fill(1),
    calculate: (values) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = A[i]![0] * values["t0"]! + A[i]![1] * values["t1"]!;
      return out;
    },
  };
  return { problem, exactMean: thetaTrue, exactCov };
}

const GAUSS_OPTS: SampleOptions = {
  nSteps: 3000,
  nWalkers: 64,
  burnIn: 1000,
  seed: 1234,
  noiseModel: "fixed",
};

describe("ensemble sampler — linear-Gaussian exact posterior (gate a)", () => {
  const { problem, exactMean, exactCov } = linearGaussianProblem();
  const result = samplePosterior(problem, GAUSS_OPTS);

  it("recovers the exact posterior mean within 0.1σ", () => {
    for (let j = 0; j < 2; j++) {
      const sigma = Math.sqrt(exactCov[j]![j]!);
      const p = result.posterior.parameters[j]!;
      expect(Math.abs(p.mean - exactMean[j]!)).toBeLessThan(0.1 * sigma);
    }
  });

  it("recovers the exact posterior std within 15%", () => {
    for (let j = 0; j < 2; j++) {
      const sigma = Math.sqrt(exactCov[j]![j]!);
      const p = result.posterior.parameters[j]!;
      expect(Math.abs(p.std - sigma) / sigma).toBeLessThan(0.15);
    }
  });

  it("recovers the exact posterior correlation within ±0.05", () => {
    const rhoExact = exactCov[0]![1]! / Math.sqrt(exactCov[0]![0]! * exactCov[1]![1]!);
    expect(Math.abs(result.posterior.correlation[0]![1]! - rhoExact)).toBeLessThan(0.05);
  });

  it("reports healthy convergence diagnostics (gate c)", () => {
    expect(result.diagnostics.maxRHat).toBeLessThan(1.02);
    expect(result.diagnostics.minEss).toBeGreaterThan(400);
    expect(result.status).toBe("ok");
    // Stretch-move acceptance in the healthy band.
    expect(result.acceptanceFraction).toBeGreaterThan(0.15);
    expect(result.acceptanceFraction).toBeLessThan(0.75);
  });

  it("a deliberately short run reports not-converged (gate c)", () => {
    const short = samplePosterior(problem, { ...GAUSS_OPTS, nSteps: 30, burnIn: 5 });
    expect(short.status).toBe("not-converged");
  });
});

describe("ensemble sampler — measure correctness (gate f)", () => {
  it("samples a flat posterior uniformly within bounds (logJacobian end-to-end)", () => {
    // A constant model: χ² is the same everywhere, so under flat priors the
    // posterior over the bounded parameter IS the uniform distribution on
    // [0, 1] — any warp from the logit transform would bend mean/std/quantiles.
    const n = 16;
    const parameters = [param("u", 0.5, { min: 0, max: 1 })];
    const problem: RefinementProblem = {
      parameters,
      observations: new Float64Array(n).fill(1),
      weights: new Float64Array(n).fill(1),
      calculate: () => new Float64Array(n).fill(0.5), // constant χ² = n·0.25
    };
    const result = samplePosterior(problem, {
      nSteps: 4000,
      nWalkers: 32,
      burnIn: 1000,
      seed: 77,
      noiseModel: "fixed",
      initialSpread: 0.5,
    });
    const p = result.posterior.parameters[0]!;
    expect(Math.abs(p.mean - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(p.std - Math.sqrt(1 / 12))).toBeLessThan(0.02);
    expect(Math.abs(p.q025 - 0.025)).toBeLessThan(0.04);
    expect(Math.abs(p.q975 - 0.975)).toBeLessThan(0.04);
  });
});

describe("ensemble sampler — structural invariants", () => {
  const { problem } = linearGaussianProblem();
  const opts: SampleOptions = { ...GAUSS_OPTS, nSteps: 200, burnIn: 50 };

  it("serial and pooled chains are bit-identical (gate d)", async () => {
    const serial = samplePosterior(problem, opts);
    // A faithful mock evaluator: same pure calculate, order-preserving.
    const evaluator: BatchEvaluator = {
      evaluate: (sets) => Promise.resolve(sets.map((s) => problem.calculate(s))),
    };
    const pooled = await samplePosteriorParallel(problem, opts, evaluator);
    expect(pooled.chains).toEqual(serial.chains);
    expect(pooled.logProb).toEqual(serial.logProb);
    expect(pooled.acceptanceFraction).toBe(serial.acceptanceFraction);
  });

  it("one 400-step run ≡ 200+200 via the resume token (gate e)", () => {
    const full = samplePosterior(problem, { ...GAUSS_OPTS, nSteps: 400, burnIn: 100 });
    const first = samplePosterior(problem, { ...GAUSS_OPTS, nSteps: 200, burnIn: 100 });
    const second = samplePosterior(problem, {
      ...GAUSS_OPTS,
      nSteps: 200,
      burnIn: 100,
      init: first.resume,
    });
    expect(second.resume).toEqual(full.resume);
    const concatenated = first.chains.map((walker, w) => [...walker, ...second.chains[w]!]);
    expect(concatenated).toEqual(full.chains);
  });

  it("same seed reproduces, different seed differs (gate g)", () => {
    const a = samplePosterior(problem, opts);
    const b = samplePosterior(problem, opts);
    const c = samplePosterior(problem, { ...opts, seed: 999 });
    expect(b.chains).toEqual(a.chains);
    expect(c.chains).not.toEqual(a.chains);
  });

  it("rejects a resume token whose free parameters do not match", () => {
    const first = samplePosterior(problem, opts);
    const other: RefinementProblem = {
      ...problem,
      parameters: [param("zz", 1)],
    };
    expect(() => samplePosterior(other, { ...opts, init: first.resume })).toThrow(/free parameters/);
  });

  it("initialization evaluates the ensemble as one batch (pool-friendly)", () => {
    // Count batch sizes yielded by the generator on a fresh start.
    const gen = sampleCore(problem, { ...opts, nSteps: 2 });
    const batchSizes: number[] = [];
    let step = gen.next();
    while (!step.done) {
      batchSizes.push(step.value.length);
      step = gen.next(step.value.map((v) => problem.calculate(v)));
    }
    // Batch 1: full ensemble init; then 2 steps × 2 half-ensembles.
    expect(batchSizes[0]).toBe(64);
    expect(batchSizes.slice(1)).toEqual([32, 32, 32, 32]);
  });
});
