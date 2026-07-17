import { describe, it, expect } from "vitest";
import { fOfQFromSOfQ, gOfRFromFOfQ, defaultTransformGrid } from "@/core/totalscattering/fourier";

describe("fOfQFromSOfQ", () => {
  it("F(Q) = Q·(S−1)", () => {
    const f = fOfQFromSOfQ([1, 2, 4], [1.5, 1, 0.75]);
    expect(Array.from(f)).toEqual([0.5, 0, -1]);
  });
});

describe("gOfRFromFOfQ — sine-transform quadrature", () => {
  it("a pure mode F(Q) = sin(Q·r0) transforms to a termination-kernel peak at r0", () => {
    const qmax = 25;
    const r0 = 2.5;
    const q = Array.from({ length: 2500 }, (_, i) => (i + 1) * 0.01);
    const f = q.map((qi) => Math.sin(qi * r0));
    const rGrid = defaultTransformGrid(6, 0.005);
    const g = gOfRFromFOfQ(q, f, rGrid);
    // Peak at r0…
    let best = -Infinity;
    let bestR = 0;
    for (let j = 0; j < rGrid.length; j++) {
      if (g[j]! > best) { best = g[j]!; bestR = rGrid[j]!; }
    }
    expect(bestR).toBeCloseTo(r0, 2);
    // …with the analytic peak height (2/π)·(Qmax/2) = Qmax/π…
    expect(best).toBeCloseTo(qmax / Math.PI, 1);
    // …and the sinc first zero at r0 ± π/Qmax.
    const at = (r: number): number => g[Math.round(r / 0.005) - 1]!;
    expect(Math.abs(at(r0 + Math.PI / qmax))).toBeLessThan(0.05 * best);
    expect(at(r0 + 1.43 * (Math.PI / qmax))).toBeLessThan(0); // first sidelobe
  });

  it("handles a non-uniform Q grid (trapezoid, not FFT)", () => {
    // Same mode sampled on a stretched grid: same peak location.
    const r0 = 3.0;
    const q: number[] = [];
    for (let x = 0.01; x <= 20; x *= 1.004) q.push(x);
    const f = q.map((qi) => Math.sin(qi * r0));
    const rGrid = defaultTransformGrid(5, 0.01);
    const g = gOfRFromFOfQ(q, f, rGrid);
    let bestR = 0;
    let best = -Infinity;
    for (let j = 0; j < rGrid.length; j++) {
      if (g[j]! > best) { best = g[j]!; bestR = rGrid[j]!; }
    }
    expect(bestR).toBeCloseTo(r0, 1);
  });
});
