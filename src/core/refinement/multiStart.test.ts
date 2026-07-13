import { describe, it, expect } from "vitest";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import {
  refineMultiStart,
  perturbParameters,
  refinementCost,
  type MultiStartRun,
  type MultiStartRunResult,
} from "@/core/refinement/multiStart";

const freeParam = (id: string, value: number, extra: Partial<RefinementParameter> = {}): RefinementParameter => ({
  id, label: id, kind: "scale", value, initialValue: value, fixed: false, ...extra,
});

describe("refineMultiStart — escapes local minima", () => {
  // A mock local optimizer over one parameter x with two basins: x<3 descends to
  // the local min (x=1, χ²=10); x≥3 descends to the global min (x=5, χ²=1).
  const mockRun: MultiStartRun = (start) => {
    const x0 = start.find((p) => p.id === "x")!.value;
    const landAt = x0 < 3 ? 1 : 5;
    const cost = landAt === 1 ? 10 : 1;
    const parameters = start.map((p) => (p.id === "x" ? { ...p, value: landAt, esd: 1 } : { ...p }));
    const final: RefinementResult = {
      status: "converged",
      parameters: { x: landAt },
      esd: { x: 1 },
      agreement: { rFactor: cost },
      history: [{ iteration: 1, chiSquared: cost, agreement: { rFactor: cost } }],
      message: "mock",
    };
    return { parameters, final };
  };

  it("finds the global basin a plain refine misses", async () => {
    // Baseline start x=0 → stuck in the local basin (χ²=10). esd=1, escapeSigma=4
    // ⇒ kicks up to ±4 from x=1 reach past the x=3 barrier.
    const res = await refineMultiStart([freeParam("x", 0)], mockRun, { restarts: 12, escapeSigma: 4, seed: 7 });
    expect(res.costByStart[0]).toBe(10); // baseline landed in the local minimum
    expect(res.improved).toBe(true);
    expect(res.bestStartIndex).toBeGreaterThan(0);
    expect(refinementCost(res.final)).toBeCloseTo(1, 9);
    expect(res.parameters.find((p) => p.id === "x")!.value).toBeCloseTo(5, 9);
  });

  it("restarts=0 returns the baseline unchanged", async () => {
    const res = await refineMultiStart([freeParam("x", 0)], mockRun, { restarts: 0 });
    expect(res.restartsRun).toBe(0);
    expect(res.bestStartIndex).toBe(0);
    expect(res.improved).toBe(false);
    expect(refinementCost(res.final)).toBe(10);
  });
});

describe("perturbParameters", () => {
  const rng = () => 0.75; // deterministic: kick = (0.75*2-1)=+0.5 of scale
  it("never moves fixed or tied parameters, kicks free ones, respects bounds", () => {
    const params: RefinementParameter[] = [
      freeParam("a", 2, { esd: 0.1 }),
      freeParam("b", 5, { fixed: true }),
      freeParam("c", 1, { expression: "a+1" }),
      freeParam("d", 0.9, { esd: 1, min: 0, max: 1 }), // scale capped at 0.5*(1-0)=0.5
    ];
    const out = perturbParameters(params, { a: 0.1, d: 1 }, rng, { escapeSigma: 4, relFraction: 0.05 });
    expect(out.find((p) => p.id === "b")!.value).toBe(5); // fixed untouched
    expect(out.find((p) => p.id === "c")!.value).toBe(1); // tied untouched
    // a: scale = max(0.1*4, 2*0.05) = 0.4; kick = +0.5*0.4 = 0.2 ⇒ 2.2
    expect(out.find((p) => p.id === "a")!.value).toBeCloseTo(2.2, 9);
    // d: scale = min(max(1*4, 0.045), 0.5) = 0.5; kick = +0.25 ⇒ 1.15 → clamped to max 1
    expect(out.find((p) => p.id === "d")!.value).toBe(1);
  });
});

describe("refineMultiStart — real LM engine on a tilted double well", () => {
  // χ²(p) = (p²−1)² + 0.09(p−1)²  (residuals r₁=p²−1, r₂=0.3(p−1)): a local
  // minimum near p=−1 (χ²≈0.36) and the global minimum at p=+1 (χ²=0).
  const build = (params: readonly RefinementParameter[]): RefinementProblem => ({
    parameters: params,
    observations: Float64Array.from([0, 0]),
    weights: Float64Array.from([1, 1]),
    calculate: (v) => {
      const p = v["p"] ?? 0;
      return Float64Array.from([p * p - 1, 0.3 * (p - 1)]);
    },
  });
  const runOnce = (start: readonly RefinementParameter[]): MultiStartRunResult => {
    const r = refine(build(start), { maxIterations: 60 });
    const parameters = start.map((pp) => {
      const e = r.esd[pp.id];
      return { ...pp, value: r.parameters[pp.id] ?? pp.value, ...(e !== undefined ? { esd: e } : {}) };
    });
    return { parameters, final: r };
  };

  it("crosses the barrier the baseline is trapped behind", async () => {
    // Start at p=−1.5 (left basin) — a plain refine stays near the local min.
    const baseline = runOnce([freeParam("p", -1.5)]);
    expect(baseline.parameters.find((p) => p.id === "p")!.value).toBeLessThan(0);
    expect(refinementCost(baseline.final)).toBeGreaterThan(0.2);

    const res = await refineMultiStart([freeParam("p", -1.5)], runOnce, {
      restarts: 20, escapeSigma: 6, relFraction: 2, seed: 3,
    });
    expect(res.improved).toBe(true);
    expect(res.parameters.find((p) => p.id === "p")!.value).toBeCloseTo(1, 2); // global basin
    expect(refinementCost(res.final)).toBeLessThan(0.02);
  });
});
