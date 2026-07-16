import { describe, it, expect } from "vitest";
import { detectExtraPeaks, annotateExtraPeaks } from "@/core/magnetic/extraPeaks";
import { searchPropagationVector, satelliteMatchDeltas } from "@/core/magnetic/kSearch";
import type { UnitCell } from "@/core/crystal/types";

const ortho: UnitCell = { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 };

/** Synthetic residual: flat background with one clean Gaussian extra peak. */
function syntheticResidual(): { d: number[]; yObs: number[]; yCalc: number[]; sigma: number[] } {
  const n = 200;
  const d = Array.from({ length: n }, (_, i) => 1 + (i * 4) / n);
  const yCalc = d.map(() => 100);
  const yObs = d.map((x, i) => 100 + 80 * Math.exp(-((x - 2.5) ** 2) / (2 * 0.02 ** 2)) + (i % 2 ? 1 : -1));
  const sigma = yObs.map((y) => Math.sqrt(y));
  return { d, yObs, yCalc, sigma };
}

describe("extra-peak criteria", () => {
  it("records the statistical significance of each detected peak", () => {
    const { d, yObs, yCalc, sigma } = syntheticResidual();
    const peaks = detectExtraPeaks(d, yObs, yCalc, { pointSigma: sigma });
    expect(peaks.length).toBe(1);
    expect(peaks[0]!.d).toBeCloseTo(2.5, 1);
    // height ≈ 80, σ ≈ √180 ≈ 13.4 → significance ≈ 6.
    expect(peaks[0]!.significance).toBeGreaterThan(4);
    expect(peaks[0]!.significance).toBeLessThan(8);
    // Without per-point σ the field stays absent.
    expect(detectExtraPeaks(d, yObs, yCalc)[0]!.significance).toBeUndefined();
  });

  it("annotates peaks that coincide with a nuclear reflection", () => {
    const peaks = [
      { d: 2.573, height: 10 }, // 0.08 % from MnO-like 2.5728 → flagged
      { d: 3.4, height: 5 }, // isolated → untouched
    ];
    const nuclear = [
      { d: 2.5728, hkl: "1 1 1", phaseLabel: "MnO" },
      { d: 2.2281, hkl: "2 0 0", phaseLabel: "MnO" },
    ];
    const out = annotateExtraPeaks(peaks, nuclear, 0.01);
    expect(out[0]!.nearNuclear).toBeDefined();
    expect(out[0]!.nearNuclear!.phaseLabel).toBe("MnO");
    expect(out[0]!.nearNuclear!.hkl).toBe("1 1 1");
    expect(out[1]!.nearNuclear).toBeUndefined();
  });

  it("k-search weights steer the ranking toward the significant peak", () => {
    // d = 10 Å is a (½ 0 0) satellite of the a = 5 Å axis; d = 12 Å is a
    // (0 ½ 0) satellite of b = 6 Å. Neither k explains the other's peak.
    const peaks = [10, 12];
    const heavyA = searchPropagationVector(ortho, peaks, { tolerance: 0.005, weights: [10, 1] })[0]!;
    const heavyB = searchPropagationVector(ortho, peaks, { tolerance: 0.005, weights: [1, 10] })[0]!;
    expect(satelliteMatchDeltas(ortho, heavyA.k, [10])[0]!).toBeLessThan(0.005);
    expect(satelliteMatchDeltas(ortho, heavyB.k, [12])[0]!).toBeLessThan(0.005);
    expect(heavyA.label).not.toBe(heavyB.label);
  });

  it("candidates report WHICH peaks they explain (original input indices)", () => {
    const peaks = [10, 12];
    const heavyA = searchPropagationVector(ortho, peaks, { tolerance: 0.005, weights: [10, 1] })[0]!;
    // The top candidate explains the 10 Å peak (index 0) but not 12 Å (index 1).
    expect(heavyA.matches.map((m) => m.index)).toContain(0);
    expect(heavyA.matches.map((m) => m.index)).not.toContain(1);
    for (const m of heavyA.matches) expect(m.delta).toBeLessThanOrEqual(0.005);
  });

  it("satelliteMatchDeltas is ~0 for the generating k and large for a wrong one", () => {
    // Satellites of k = (0 ½ 0): (0 ½ 0) → 12 Å, (1 ½ 0) → 4.615 Å, (0 ½ 1) → 6.047 Å.
    const obs = [12, 4.615, 6.047];
    const right = satelliteMatchDeltas(ortho, [0, 0.5, 0], obs);
    expect(Math.max(...right)).toBeLessThan(0.01);
    const wrong = satelliteMatchDeltas(ortho, [0.5, 0, 0], obs);
    expect(Math.max(...wrong)).toBeGreaterThan(0.01);
  });
});
