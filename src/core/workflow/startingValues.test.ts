import { describe, it, expect } from "vitest";
import { estimateBackground, evaluateBackground } from "@/core/diffraction/background";
import { estimateZeroShift } from "@/core/workflow/startingValues";
import { buildPowderSpec } from "@/app/powderSpec";
import { powderCurves } from "@/core/workflow/powder";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * Robust automatic starting values (roadmap F1.3): the background comes from
 * the data's lower envelope BEFORE the scale is estimated, and an obvious
 * zero-point offset is detected by cross-correlation — so a refinement never
 * starts in the classic false basins (over-scaled peaks absorbing the
 * background; peaks systematically displaced from the data).
 */

const gauss = (x: number, c: number, w: number): number => Math.exp((-4 * Math.LN2 * (x - c) * (x - c)) / (w * w));

describe("estimateBackground — lower envelope", () => {
  it("recovers a smooth background under sharp peaks", () => {
    const n = 3000;
    const xs = Array.from({ length: n }, (_, i) => 5 + (i * 85) / (n - 1));
    const trueBkg = (x: number): number => 120 - 0.8 * x + 0.004 * x * x;
    const yObs = xs.map((x) => {
      let y = trueBkg(x);
      for (let k = 0; k < 30; k++) y += 800 * gauss(x, 8 + k * 2.8, 0.12);
      return y;
    });
    const coeffs = estimateBackground(xs, yObs, "chebyshev", 4);
    // The fitted envelope tracks the true background to a few counts,
    // evaluated away from peaks and at both ends.
    for (const x of [6, 20, 45, 70, 88]) {
      const est = evaluateBackground(x, coeffs, "chebyshev", 5, 90);
      expect(Math.abs(est - trueBkg(x))).toBeLessThan(0.06 * trueBkg(x) + 3);
    }
  });

  it("interpolation bases take the envelope heights directly", () => {
    const n = 1200;
    const xs = Array.from({ length: n }, (_, i) => 10 + (i * 80) / (n - 1));
    const yObs = xs.map((x) => 50 + 0.5 * x + 500 * gauss(x, 40, 0.5));
    const coeffs = estimateBackground(xs, yObs, "linInterpolate", 6);
    expect(coeffs).toHaveLength(6);
    // Heights ascend with x (the background is increasing) and sit near it.
    expect(coeffs[0]!).toBeGreaterThan(40);
    expect(coeffs[5]!).toBeGreaterThan(coeffs[0]!);
    expect(coeffs[5]!).toBeLessThan(100);
  });
});

describe("estimateZeroShift — peak-position sanity", () => {
  it("detects a known displacement between observed and calculated peaks", () => {
    const n = 4000;
    const xs = Array.from({ length: n }, (_, i) => 10 + (i * 70) / (n - 1));
    const centers = [15, 22.4, 31.7, 44.2, 58.9, 66.1];
    const yCalc = xs.map((x) => centers.reduce((s, c) => s + 300 * gauss(x, c, 0.09), 0));
    const TRUE_SHIFT = 0.06; // observed peaks sit at calc + 0.06°
    const net = xs.map((x) => centers.reduce((s, c) => s + 290 * gauss(x, c + TRUE_SHIFT, 0.09), 0));
    const { shift, gain } = estimateZeroShift(xs, net, yCalc, { maxShift: 0.2, steps: 60 });
    expect(gain).toBeGreaterThan(0.05);
    expect(shift).toBeGreaterThan(0.04);
    expect(shift).toBeLessThan(0.08);
  });

  it("reports no significant shift for aligned patterns", () => {
    const n = 2000;
    const xs = Array.from({ length: n }, (_, i) => 10 + (i * 70) / (n - 1));
    const yCalc = xs.map((x) => 300 * gauss(x, 35, 0.1) + 200 * gauss(x, 52, 0.1));
    const { shift } = estimateZeroShift(xs, yCalc, yCalc, { maxShift: 0.2, steps: 60 });
    expect(Math.abs(shift)).toBeLessThan(0.01);
  });
});

describe("buildPowderSpec seeding — no false basin", () => {
  it("background seeds from the envelope and the scale from net counts", () => {
    const structure = exampleStructure();
    const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 0.2, v: -0.04, w: 0.02, x: 0.3, y: 0.05 };
    const grid = Array.from({ length: 2500 }, (_, i) => 10 + (i * 80) / 2499);
    // Truth: scale 5 with a LARGE sloping background (10× the peak tails).
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const probe = buildPowderSpec(structure, pattern, inst, true, 4, {});
    const sim = powderCurves(structure, pattern, probe.params.map((p) => (p.kind === "scale" ? { ...p, value: 5 } : p.kind === "background" ? { ...p, value: 0 } : p)), probe.bindings, probe.profile);
    const bkg = (x: number): number => 400 - 3 * x + 0.02 * x * x;
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + bkg(x) })) };

    const spec = buildPowderSpec(structure, pattern, inst, true, 4, {});
    const scale = spec.params.find((p) => p.kind === "scale")!.value;
    const bkgParams = spec.params.filter((p) => p.kind === "background");
    // Background is seeded (not zero), and the scale lands near the truth
    // instead of absorbing the background (which would inflate it several ×).
    expect(Math.abs(bkgParams[0]!.value)).toBeGreaterThan(10);
    expect(scale).toBeGreaterThan(3);
    expect(scale).toBeLessThan(8);
    // The seeded model already sits close to the data: wR of the seed < 30%.
    const seeded = powderCurves(structure, pattern, spec.params, spec.bindings, spec.profile);
    let num = 0;
    let den = 0;
    for (let i = 0; i < grid.length; i++) {
      const w = 1 / Math.max(pattern.points[i]!.yObs, 1);
      num += w * (pattern.points[i]!.yObs - seeded.yCalc[i]!) ** 2;
      den += w * pattern.points[i]!.yObs ** 2;
    }
    expect(Math.sqrt(num / den)).toBeLessThan(0.3);
  });
});
