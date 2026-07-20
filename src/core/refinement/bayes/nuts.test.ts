import { describe, it, expect } from "vitest";
import type { RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { sampleNuts, type GradChi2 } from "@/core/refinement/bayes/nuts";

/**
 * NUTS gates mirror the ensemble sampler's: exact linear-Gaussian posterior
 * (analytic truth, now with an analytic gradient), bounded-measure correctness,
 * seeded determinism, and resume equivalence. The Ni-golden esdRatio gate lives
 * in workflow/pdfPosterior.test.ts next to the ensemble one (it needs the PDF
 * problem builder).
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

/** y = A·θ, unit weights: exact posterior N(θ_true, (AᵀA)⁻¹) under logL = −χ²/2. */
function linearGaussian(): {
  problem: RefinementProblem;
  gradChi2: GradChi2;
  exactMean: [number, number];
  exactCov: [[number, number], [number, number]];
} {
  const n = 60;
  const thetaTrue: [number, number] = [1.4, -0.6];
  const A: [number, number][] = Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return [1 + 0.5 * x, 0.7 + 0.6 * x] as [number, number];
  });
  const yObs = new Float64Array(n);
  for (let i = 0; i < n; i++) yObs[i] = A[i]![0] * thetaTrue[0] + A[i]![1] * thetaTrue[1];
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
  const calc = (t0: number, t1: number): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = A[i]![0] * t0 + A[i]![1] * t1;
    return out;
  };
  const problem: RefinementProblem = {
    parameters: [param("t0", thetaTrue[0]), param("t1", thetaTrue[1])],
    observations: yObs,
    weights: new Float64Array(n).fill(1),
    calculate: (values) => calc(values["t0"]!, values["t1"]!),
  };
  // Analytic ∇χ²: χ² = ‖y − Aθ‖², ∂χ²/∂θ_j = −2·Σ_i A_ij·(y_i − ŷ_i).
  const gradChi2: GradChi2 = (_fp, freeValues) => {
    const y = calc(freeValues[0]!, freeValues[1]!);
    let chi2 = 0;
    const grad = new Float64Array(2);
    for (let i = 0; i < n; i++) {
      const r = yObs[i]! - y[i]!;
      chi2 += r * r;
      grad[0] = grad[0]! - 2 * A[i]![0] * r;
      grad[1] = grad[1]! - 2 * A[i]![1] * r;
    }
    return { chi2, grad };
  };
  return { problem, gradChi2, exactMean: thetaTrue, exactCov };
}

describe("NUTS — linear-Gaussian exact posterior", () => {
  // Deliberately brutal target: the two design columns are nearly parallel, so
  // the exact posterior has correlation ≈ −0.998 — a razor-thin ridge that a
  // unit-mass NUTS must traverse by trajectory length alone. Tolerances below
  // are set from the ESS-implied standard errors, not wishful thinking:
  // 4 chains × 1500 draws mix to ESS ≈ 600–900 here, so SE(mean) ≈ σ/√ESS ≈
  // 0.04σ; the 0.12σ gate is ≈ 3 SE.
  const { problem, gradChi2, exactMean, exactCov } = linearGaussian();
  const result = sampleNuts(problem, gradChi2, {
    nSteps: 1500,
    nChains: 4,
    nWarmup: 100,
    seed: 4321,
    noiseModel: "fixed",
  });

  it("recovers the exact posterior mean and std", () => {
    for (let j = 0; j < 2; j++) {
      const sigma = Math.sqrt(exactCov[j]![j]!);
      const p = result.posterior.parameters[j]!;
      expect(Math.abs(p.mean - exactMean[j]!)).toBeLessThan(0.12 * sigma);
      expect(Math.abs(p.std - sigma) / sigma).toBeLessThan(0.1);
    }
  });

  it("recovers the exact posterior correlation", () => {
    const rho = exactCov[0]![1]! / Math.sqrt(exactCov[0]![0]! * exactCov[1]![1]!);
    expect(Math.abs(result.posterior.correlation[0]![1]! - rho)).toBeLessThan(0.05);
  });

  it("is healthy: converged, no divergences, sane acceptance", () => {
    expect(result.status).toBe("ok");
    expect(result.nuts.divergences).toBe(0);
    expect(result.diagnostics.maxRHat).toBeLessThan(1.03);
    expect(result.diagnostics.minEss).toBeGreaterThan(500);
    expect(result.acceptanceFraction).toBeGreaterThan(0.5);
  });

  it("mixes efficiently per draw on the ρ ≈ −0.998 ridge", () => {
    // ESS per kept draw — the honest NUTS efficiency number. (On a cheap 2-D
    // toy the affine-invariant ensemble is competitive per EVALUATION; NUTS's
    // edge is dimension scaling and the near-free analytic gradient on the
    // PDF path, where one gradChi2 ≈ one forward evaluation.)
    const essPerDraw = result.diagnostics.minEss / (4 * 1500);
    expect(essPerDraw).toBeGreaterThan(0.05);
  });
});

describe("NUTS — bounded measure correctness", () => {
  it("samples a flat posterior uniformly within bounds", () => {
    const n = 16;
    const problem: RefinementProblem = {
      parameters: [param("u", 0.5, { min: 0, max: 1 })],
      observations: new Float64Array(n).fill(1),
      weights: new Float64Array(n).fill(1),
      calculate: () => new Float64Array(n).fill(0.5),
    };
    // Constant χ² ⇒ zero gradient; the sampled measure is purely the
    // logit-transform Jacobian — any error in dxdq/dLogJacobianDq shows up
    // as a bent marginal.
    const gradChi2: GradChi2 = () => ({ chi2: n * 0.25, grad: new Float64Array(1) });
    const result = sampleNuts(problem, gradChi2, {
      nSteps: 2000,
      nChains: 2,
      nWarmup: 100,
      seed: 99,
      noiseModel: "fixed",
    });
    const p = result.posterior.parameters[0]!;
    expect(Math.abs(p.mean - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(p.std - Math.sqrt(1 / 12))).toBeLessThan(0.02);
    expect(Math.abs(p.q025 - 0.025)).toBeLessThan(0.04);
    expect(Math.abs(p.q975 - 0.975)).toBeLessThan(0.04);
  });
});

describe("NUTS — structural invariants", () => {
  const { problem, gradChi2 } = linearGaussian();
  const opts = { nSteps: 100, nChains: 2, nWarmup: 50, seed: 7, noiseModel: "fixed" as const };

  it("same seed reproduces, different seed differs", () => {
    const a = sampleNuts(problem, gradChi2, opts);
    const b = sampleNuts(problem, gradChi2, opts);
    const c = sampleNuts(problem, gradChi2, { ...opts, seed: 8 });
    expect(b.chains).toEqual(a.chains);
    expect(c.chains).not.toEqual(a.chains);
  });

  it("one 200-draw run ≡ 100+100 via the resume token", () => {
    const full = sampleNuts(problem, gradChi2, { ...opts, nSteps: 200 });
    const first = sampleNuts(problem, gradChi2, { ...opts, nSteps: 100 });
    const second = sampleNuts(problem, gradChi2, { ...opts, nSteps: 100, init: first.resume });
    expect(second.resume).toEqual(full.resume);
    const concatenated = first.chains.map((chain, c) => [...chain, ...second.chains[c]!]);
    expect(concatenated).toEqual(full.chains);
  });

  it("rejects a resume token whose free parameters do not match", () => {
    const first = sampleNuts(problem, gradChi2, opts);
    const other: RefinementProblem = { ...problem, parameters: [param("zz", 1)] };
    expect(() => sampleNuts(other, gradChi2, { ...opts, init: first.resume })).toThrow(
      /free parameters/,
    );
  });

  it("reports divergences on a pathological step size instead of failing silently", () => {
    // Force a huge fixed step by resuming with a doctored token: leapfrog
    // explodes, divergences must be counted and status must not be "ok".
    const base = sampleNuts(problem, gradChi2, opts);
    const doctored = {
      ...base.resume,
      stepSize: base.resume.stepSize.map(() => 1e6),
    };
    const result = sampleNuts(problem, gradChi2, { ...opts, nSteps: 50, init: doctored });
    expect(result.nuts.divergences).toBeGreaterThan(0);
    expect(result.status).toBe("not-converged");
  });
});
