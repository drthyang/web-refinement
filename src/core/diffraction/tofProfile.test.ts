import { describe, it, expect } from "vitest";
import { erfc, erfcxNonneg, tofBackToBack, type TofShape } from "@/core/diffraction/profile";

/** Numerically integrate H(Δ) over a wide, fine grid (trapezoid). */
function area(shape: TofShape, halfWidth = 4000, n = 400001): number {
  const h = (2 * halfWidth) / (n - 1);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const delta = -halfWidth + i * h;
    const w = i === 0 || i === n - 1 ? 0.5 : 1;
    sum += w * tofBackToBack(delta, shape);
  }
  return sum * h;
}

describe("error functions", () => {
  it("erfc matches known values", () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.15729920, 6);
    expect(erfc(-1)).toBeCloseTo(1.84270079, 6);
    expect(erfc(2)).toBeCloseTo(0.00467773, 6);
  });

  it("erfcxNonneg = exp(x²)·erfc(x) and stays finite in the tail", () => {
    for (const x of [0, 0.5, 2, 5, 20]) {
      expect(erfcxNonneg(x)).toBeCloseTo(Math.exp(x * x) * erfc(x), 5);
    }
    // Large x: erfcx(x) → 1/(x√π); must not overflow (exp(x²) would).
    expect(erfcxNonneg(30)).toBeCloseTo(1 / (30 * Math.sqrt(Math.PI)), 4);
    expect(Number.isFinite(erfcxNonneg(200))).toBe(true);
  });
});

describe("TOF back-to-back-exponential ⊗ Gaussian", () => {
  it("is normalized to unit area", () => {
    expect(area({ alpha: 0.5, beta: 0.05, sigma: 30 })).toBeCloseTo(1, 3);
    expect(area({ alpha: 1.0, beta: 0.02, sigma: 15 })).toBeCloseTo(1, 3);
  });

  it("is asymmetric — the β (decay) tail is longer than the α (rise) edge", () => {
    const shape: TofShape = { alpha: 1.0, beta: 0.03, sigma: 10 };
    // Same distance either side of the nominal position: the falling side (Δ>0)
    // carries more intensity than the rising side (Δ<0).
    const rise = tofBackToBack(-80, shape);
    const fall = tofBackToBack(80, shape);
    expect(fall).toBeGreaterThan(rise);
  });

  it("peaks near the nominal position and is everywhere non-negative", () => {
    const shape: TofShape = { alpha: 0.8, beta: 0.04, sigma: 20 };
    const peak = tofBackToBack(0, shape);
    for (const d of [-500, -100, -10, 0, 10, 100, 500, 3000]) {
      expect(tofBackToBack(d, shape)).toBeGreaterThanOrEqual(0);
    }
    // The mode sits on the long-tail (falling) side of nominal, so H(+ε) ≳ H(−ε).
    expect(tofBackToBack(5, shape)).toBeGreaterThan(tofBackToBack(-5, shape));
    expect(peak).toBeGreaterThan(0);
  });

  it("approaches a symmetric Gaussian when α, β are large (sharp edges)", () => {
    // Large rates ⇒ negligible exponential broadening ⇒ near-symmetric.
    const shape: TofShape = { alpha: 50, beta: 50, sigma: 12 };
    const left = tofBackToBack(-15, shape);
    const right = tofBackToBack(15, shape);
    expect(left).toBeCloseTo(right, 4);
    expect(area(shape)).toBeCloseTo(1, 3);
  });
});
