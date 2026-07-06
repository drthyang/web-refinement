import { describe, expect, it } from "vitest";
import { excludedPointMask, applyExclusionMask, weightsFromSigma, computeAgreementFactors } from "@/core/refinement/factors";

describe("excludedPointMask", () => {
  it("flags a repeated non-positive sentinel plateau", () => {
    const y = [-3, -3, -3, -3, -3, -3, 10, 250, 40, 5];
    expect(excludedPointMask(y)).toEqual([true, true, true, true, true, true, false, false, false, false]);
  });

  it("leaves scattered negatives alone (no plateau)", () => {
    const y = [-0.4, 12, -0.1, 30, 0.2, 45];
    expect(excludedPointMask(y).every((m) => m === false)).toBe(true);
  });

  it("ignores positive data entirely", () => {
    expect(excludedPointMask([1, 2, 3, 4, 5, 6]).every((m) => !m)).toBe(true);
  });
});

describe("applyExclusionMask + agreement", () => {
  it("zeroes masked weights and excludes them from R factors", () => {
    const yObs = Float64Array.from([-3, -3, -3, -3, -3, 100, 90, 110]);
    const yCalc = Float64Array.from([999, 999, 999, 999, 999, 100, 90, 110]); // perfect on real points, garbage on masked
    const mask = excludedPointMask(Array.from(yObs));
    const weights = applyExclusionMask(weightsFromSigma(Array.from({ length: yObs.length }, () => undefined)), mask);
    for (let i = 0; i < 5; i++) expect(weights[i]).toBe(0);
    const a = computeAgreementFactors(yObs, yCalc, weights, 1);
    // Masked points are excluded, so the fit reads as perfect.
    expect(a.rFactor).toBeCloseTo(0, 10);
    expect(a.rWeighted).toBeCloseTo(0, 10);
  });
});
