import { describe, it, expect } from "vitest";
import { invNormalCdf, normalProbabilityPlot, weightedResiduals } from "@/core/refinement/diagnostics";

describe("invNormalCdf (probit)", () => {
  it("matches known quantiles", () => {
    expect(invNormalCdf(0.5)).toBeCloseTo(0, 6);
    expect(invNormalCdf(0.975)).toBeCloseTo(1.959964, 4); // 95% two-sided
    expect(invNormalCdf(0.025)).toBeCloseTo(-1.959964, 4);
    expect(invNormalCdf(0.8413447)).toBeCloseTo(1, 4); // +1σ
  });
});

describe("normalProbabilityPlot", () => {
  it("gives slope 1, intercept 0 for perfectly normal residuals", () => {
    // Residuals equal to the theoretical quantiles → exactly the ideal line.
    const n = 500;
    const deltas = Array.from({ length: n }, (_, i) => invNormalCdf((i + 0.5) / n));
    const p = normalProbabilityPlot(deltas);
    expect(p.slope).toBeCloseTo(1, 6);
    expect(p.intercept).toBeCloseTo(0, 6);
    expect(p.n).toBe(n);
  });

  it("recovers the slope when σ is under/over-estimated (residuals scaled)", () => {
    const n = 400;
    const base = Array.from({ length: n }, (_, i) => invNormalCdf((i + 0.5) / n));
    // Residuals twice too large (σ underestimated by 2×) → slope ≈ 2.
    expect(normalProbabilityPlot(base.map((d) => 2 * d)).slope).toBeCloseTo(2, 6);
    // A constant offset (systematic error) → nonzero intercept.
    expect(normalProbabilityPlot(base.map((d) => d + 0.5)).intercept).toBeCloseTo(0.5, 6);
  });

  it("downsamples the plotted points but keeps the endpoints", () => {
    const deltas = Array.from({ length: 5000 }, (_, i) => invNormalCdf((i + 0.5) / 5000));
    const p = normalProbabilityPlot(deltas, 300);
    expect(p.points.length).toBeLessThanOrEqual(302);
    expect(p.points.length).toBeGreaterThan(100);
  });
});

describe("weightedResiduals", () => {
  it("computes (obs − calc)/σ", () => {
    const r = weightedResiduals([10, 20], [8, 26], [1, 2]);
    expect(r).toEqual([2, -3]);
  });
  it("falls back to √obs when no σ given", () => {
    expect(weightedResiduals([100], [90])).toEqual([1]); // (100−90)/√100
  });
});
