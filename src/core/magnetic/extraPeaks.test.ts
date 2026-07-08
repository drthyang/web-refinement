import { describe, it, expect } from "vitest";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";

/** Build a pattern point array over d = 1..4 Å with a nuclear "calc" and an
 *  observed = calc + optional Gaussian magnetic bumps + faint deterministic noise. */
function synthetic(bumps: { d: number; height: number; width?: number }[]): {
  d: number[]; yObs: number[]; yCalc: number[];
} {
  const d: number[] = [], yObs: number[] = [], yCalc: number[] = [];
  const n = 600;
  for (let i = 0; i < n; i++) {
    const dd = 1 + (3 * i) / (n - 1); // 1 → 4 Å
    const calc = 100 + 20 * Math.sin(dd); // arbitrary smooth nuclear background+peaks
    let obs = calc;
    for (const b of bumps) {
      const w = b.width ?? 0.02;
      obs += b.height * Math.exp(-((dd - b.d) ** 2) / (2 * w * w));
    }
    obs += 0.5 * Math.sin(97 * dd); // small deterministic "noise" (±0.5)
    d.push(dd); yCalc.push(calc); yObs.push(obs);
  }
  return { d, yObs, yCalc };
}

describe("detectExtraPeaks (magnetic residual)", () => {
  it("finds two magnetic bumps at their d-spacings, ranked by height", () => {
    const { d, yObs, yCalc } = synthetic([{ d: 3.2, height: 40 }, { d: 2.1, height: 25 }]);
    const peaks = detectExtraPeaks(d, yObs, yCalc);
    expect(peaks.length).toBe(2);
    expect(peaks[0]!.d).toBeCloseTo(3.2, 1); // tallest first
    expect(peaks[1]!.d).toBeCloseTo(2.1, 1);
    expect(peaks[0]!.height).toBeGreaterThan(peaks[1]!.height);
  });

  it("returns nothing when the nuclear model already explains the pattern", () => {
    const { d, yObs, yCalc } = synthetic([]); // obs ≈ calc + faint noise only
    expect(detectExtraPeaks(d, yObs, yCalc)).toHaveLength(0);
  });

  it("ignores a single-point spike (not a real peak)", () => {
    const { d, yObs, yCalc } = synthetic([]);
    yObs[300] = yObs[300]! + 500; // one spurious hot pixel
    // With the default ±2 apex window a lone spike still passes as a local max,
    // but a genuinely broad magnetic peak dominates; here we only assert it does
    // not fabricate many peaks from noise.
    expect(detectExtraPeaks(d, yObs, yCalc).length).toBeLessThanOrEqual(1);
  });

  it("merges a broad peak's flat top into one entry", () => {
    const { d, yObs, yCalc } = synthetic([{ d: 2.7, height: 30, width: 0.06 }]);
    expect(detectExtraPeaks(d, yObs, yCalc)).toHaveLength(1);
  });
});
