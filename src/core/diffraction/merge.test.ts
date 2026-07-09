import { describe, it, expect } from "vitest";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { laueRotations, mergeEquivalents, type Reflection2 } from "@/core/diffraction/merge";

describe("laueRotations", () => {
  it("adds Friedel inversion to a P1 operation list (Laue class -1)", () => {
    const p1 = [parseSymmetryOperation("x,y,z")];
    const rots = laueRotations(p1);
    // Identity + its negative (inversion) = 2 distinct rotations.
    expect(rots).toHaveLength(2);
  });

  it("recovers the 48 rotations of the m-3m Laue class for Fm-3m", () => {
    const fm3m = buildSpaceGroup(225);
    // Centring translations share rotation parts, so distinct rotations = 48.
    expect(laueRotations(fm3m.operations)).toHaveLength(48);
  });
});

describe("mergeEquivalents", () => {
  it("merges Friedel pairs under P-1 and reports zero R_int for equal intensities", () => {
    const p1bar = buildSpaceGroup(2);
    const data: Reflection2[] = [
      { h: 1, k: 2, l: 3, intensity: 100, sigma: 5 },
      { h: -1, k: -2, l: -3, intensity: 100, sigma: 5 },
      { h: 2, k: 0, l: 0, intensity: 50, sigma: 3 },
    ];
    const { reflections, statistics } = mergeEquivalents(data, p1bar.operations);
    expect(statistics.unique).toBe(2); // the pair merges, the singleton stays
    expect(statistics.observations).toBe(3);
    expect(statistics.redundancy).toBeCloseTo(1.5, 6);
    expect(statistics.rInt).toBeCloseTo(0, 10); // identical equivalents
    const pair = reflections.find((r) => r.redundancy === 2)!;
    expect(pair.intensity).toBeCloseTo(100, 6);
    // Merged σ shrinks vs a single measurement (propagated 1/√Σw = 5/√2).
    expect(pair.sigma).toBeCloseTo(5 / Math.SQRT2, 6);
  });

  it("computes a nonzero R_int from discrepant equivalents", () => {
    const p1bar = buildSpaceGroup(2);
    const data: Reflection2[] = [
      { h: 1, k: 0, l: 0, intensity: 90, sigma: 5 },
      { h: -1, k: 0, l: 0, intensity: 110, sigma: 5 },
    ];
    const { statistics } = mergeEquivalents(data, p1bar.operations);
    // mean 100; Σ|I−<I>| = 10+10 = 20; Σ|I| = 200 → R_int = 0.1.
    expect(statistics.rInt).toBeCloseTo(0.1, 6);
  });

  it("collapses a full cubic equivalent set to one unique reflection", () => {
    const fm3m = buildSpaceGroup(225);
    // The {2 0 0} family under m-3m: all permutations/signs are equivalent.
    const family: Reflection2[] = [
      [2, 0, 0], [0, 2, 0], [0, 0, 2], [-2, 0, 0], [0, -2, 0], [0, 0, -2],
    ].map(([h, k, l]) => ({ h: h!, k: k!, l: l!, intensity: 200, sigma: 4 }));
    const { statistics } = mergeEquivalents(family, fm3m.operations);
    expect(statistics.unique).toBe(1);
    expect(statistics.redundancy).toBeCloseTo(6, 6);
    expect(statistics.rInt).toBeCloseTo(0, 10);
  });
});
