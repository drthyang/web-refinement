import { describe, it, expect } from "vitest";
import { residualPeaks } from "@/core/diagnostics/assessment";

/** A d grid with a flat model, and obs = model + bumps (Gaussian in d, width ~ 0.004 Å). */
function pattern(bumps: { d: number; height: number }[], noiseAt?: { from: number; to: number }) {
  const d: number[] = [];
  for (let x = 1; x <= 5; x += 0.0005) d.push(x);
  const yCalc = d.map(() => 100);
  const yObs = d.map((x, i) => {
    let y = 100 + bumps.reduce((s, b) => s + b.height * Math.exp(-(((x - b.d) / 0.004) ** 2)), 0);
    // A sparse, low-count stretch: lone points 3σ high (σ = 10 there), never a peak.
    if (noiseAt && x >= noiseAt.from && x <= noiseAt.to && i % 7 === 0) y += 30;
    return y;
  });
  const sigma = d.map((x) => (noiseAt && x >= noiseAt.from && x <= noiseAt.to ? 10 : 1));
  return { d, yObs, yCalc, sigma };
}

describe("residual peaks", () => {
  const reflections = [{ d: 3.199, hkl: "1 0 1", phaseLabel: "Mn3Ga" }, { d: 2.709, hkl: "1 1 0", phaseLabel: "Mn3Ga" }];

  it("tells a misfit of a known reflection, and a tail beside one, from intensity no phase explains", () => {
    const { between, beside, onReflection } = residualPeaks({ ...pattern([{ d: 3.2, height: 60 }, { d: 2.735, height: 30 }, { d: 2.0, height: 40 }]), reflections });
    expect(onReflection.map((p) => [Number(p.d.toFixed(3)), p.nearNuclear?.hkl])).toEqual([[3.2, "1 0 1"]]);
    // 1% beyond 1 1 0: its tail or shoulder, not a new phase.
    expect(beside.map((p) => [Number(p.d.toFixed(3)), p.nearNuclear?.hkl])).toEqual([[2.735, "1 1 0"]]);
    expect(between.map((p) => Number(p.d.toFixed(3)))).toEqual([2]);
  });

  it("does not read lone noisy points in a low-count region as peaks, given each point's σ", () => {
    const data = pattern([{ d: 2.0, height: 40 }], { from: 4.6, to: 5 });
    expect(residualPeaks(data).between.map((p) => Number(p.d.toFixed(3)))).toEqual([2]);
    // Without σ the same noise passes the global threshold.
    const { sigma: _s, ...noSigma } = data;
    expect(residualPeaks(noSigma).between.length).toBeGreaterThan(1);
  });
});
