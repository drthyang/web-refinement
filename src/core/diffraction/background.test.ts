import { describe, expect, it } from "vitest";
import { chebyshevBackground, cosineBackground, powerSeriesBackground, polynomialBackground, linInterpolateBackground, logInterpolateBackground, evaluateBackground } from "@/core/diffraction/background";

describe("chebyshevBackground", () => {
  it("reduces to c0 for a single term", () => {
    expect(chebyshevBackground(1234, [7], 0, 5000)).toBe(7);
  });

  it("matches the closed form T1=t, T2=2t²−1 at the endpoints and centre", () => {
    // On [0,10]: x=0 → t=−1, x=10 → t=+1, x=5 → t=0.
    const c = [2, 3, 4]; // 2 + 3·T1 + 4·T2
    expect(chebyshevBackground(0, c, 0, 10)).toBeCloseTo(2 + 3 * -1 + 4 * (2 * 1 - 1), 10); // t=−1
    expect(chebyshevBackground(10, c, 0, 10)).toBeCloseTo(2 + 3 * 1 + 4 * (2 * 1 - 1), 10); // t=+1
    expect(chebyshevBackground(5, c, 0, 10)).toBeCloseTo(2 + 3 * 0 + 4 * (2 * 0 - 1), 10); // t=0
  });

  it("stays finite and O(coeffs) over a wide TOF abscissa where raw powers overflow", () => {
    const c = [100, 20, 5, 1];
    // Raw polynomial with x ~ 1e5 and 4 terms overflows into ~1e20; Chebyshev does not.
    const cheb = chebyshevBackground(90000, c, 3000, 100000);
    expect(Number.isFinite(cheb)).toBe(true);
    expect(Math.abs(cheb)).toBeLessThan(200); // bounded by Σ|cₙ| = 126
    expect(Math.abs(polynomialBackground(90000, c))).toBeGreaterThan(1e14);
  });
});

describe("cosineBackground (Fourier)", () => {
  it("reduces to c0 for a single term and matches cos(nπs) at endpoints/centre", () => {
    expect(cosineBackground(3, [7], 0, 10)).toBe(7);
    const c = [2, 3, 4]; // 2 + 3·cos(πs) + 4·cos(2πs)
    // s=0 (x=0): cos0=1, cos0=1 → 2+3+4=9
    expect(cosineBackground(0, c, 0, 10)).toBeCloseTo(9, 10);
    // s=1 (x=10): cos π=−1, cos 2π=1 → 2−3+4=3
    expect(cosineBackground(10, c, 0, 10)).toBeCloseTo(3, 10);
    // s=0.5 (x=5): cos(π/2)=0, cos(π)=−1 → 2+0−4=−2
    expect(cosineBackground(5, c, 0, 10)).toBeCloseTo(-2, 10);
  });

  it("stays bounded on a wide TOF abscissa", () => {
    const v = cosineBackground(90000, [100, 20, 5, 1], 3000, 100000);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(126); // Σ|cₙ|
  });
});

describe("linInterpolateBackground (GSAS-II lin interpolate)", () => {
  const c = [10, 30, 20, 40]; // heights at 4 evenly-spaced points over [0, 60]
  it("passes exactly through each coefficient at its anchor (endpoints + interior)", () => {
    expect(linInterpolateBackground(0, c, 0, 60)).toBeCloseTo(10, 10); // anchor 0 = xMin
    expect(linInterpolateBackground(20, c, 0, 60)).toBeCloseTo(30, 10); // anchor 1
    expect(linInterpolateBackground(40, c, 0, 60)).toBeCloseTo(20, 10); // anchor 2
    expect(linInterpolateBackground(60, c, 0, 60)).toBeCloseTo(40, 10); // anchor 3 = xMax
  });
  it("linearly interpolates between anchors and is flat past the ends", () => {
    expect(linInterpolateBackground(10, c, 0, 60)).toBeCloseTo(20, 10); // midway 10→30
    expect(linInterpolateBackground(30, c, 0, 60)).toBeCloseTo(25, 10); // midway 30→20
    expect(linInterpolateBackground(-5, c, 0, 60)).toBe(10); // clamps to first
    expect(linInterpolateBackground(100, c, 0, 60)).toBe(40); // clamps to last
  });
  it("reduces to the constant for one coefficient", () => {
    expect(linInterpolateBackground(37, [7], 0, 60)).toBe(7);
  });
});

describe("logInterpolateBackground (GSAS-II log interpolate)", () => {
  it("hits each coefficient at its log-spaced anchor; endpoints pinned to the range", () => {
    const c = [1, 2, 3]; // anchors at x = 1, 10, 100 (log-even over [1,100])
    expect(logInterpolateBackground(1, c, 1, 100)).toBeCloseTo(1, 10);
    expect(logInterpolateBackground(10, c, 1, 100)).toBeCloseTo(2, 6); // middle log anchor
    expect(logInterpolateBackground(100, c, 1, 100)).toBeCloseTo(3, 10);
  });
  it("places anchors denser at low x than linear (differs mid-range)", () => {
    const c = [0, 100];
    // Two points → both schemes are a straight line xMin→xMax, so equal here;
    // with 3 points the middle anchor differs.
    const c3 = [0, 50, 100];
    const atLin = linInterpolateBackground(10, c3, 1, 100);
    const atLog = logInterpolateBackground(10, c3, 1, 100);
    expect(atLin).not.toBeCloseTo(atLog, 3);
    expect(atLog).toBeCloseTo(50, 6); // x=10 is the middle log anchor → coeff 50
    void c;
  });
  it("falls back to linear spacing when xMin ≤ 0", () => {
    const c = [0, 10, 20];
    expect(logInterpolateBackground(15, c, -5, 25)).toBeCloseTo(linInterpolateBackground(15, c, -5, 25), 10);
  });
});

describe("evaluateBackground dispatches the interpolation types", () => {
  it("routes linInterpolate/logInterpolate", () => {
    const c = [5, 15, 25];
    expect(evaluateBackground(10, c, "linInterpolate", 0, 20)).toBeCloseTo(15, 10);
    expect(evaluateBackground(10, c, "logInterpolate", 1, 100)).toBeCloseTo(15, 6);
  });
});

describe("powerSeriesBackground (normalized)", () => {
  it("is a monomial series in t ∈ [−1,1] and stays finite on a wide abscissa", () => {
    const c = [2, 3, 4]; // 2 + 3t + 4t²
    expect(powerSeriesBackground(0, c, 0, 10)).toBeCloseTo(2 + 3 * -1 + 4 * 1, 10); // t=−1
    expect(powerSeriesBackground(5, c, 0, 10)).toBeCloseTo(2, 10); // t=0
    const wide = powerSeriesBackground(90000, [100, 20, 5, 1], 3000, 100000);
    expect(Number.isFinite(wide)).toBe(true);
    expect(Math.abs(wide)).toBeLessThanOrEqual(126);
  });
});

describe("evaluateBackground", () => {
  it("dispatches by type and returns 0 for empty coeffs", () => {
    expect(evaluateBackground(5, [], "chebyshev", 0, 10)).toBe(0);
    expect(evaluateBackground(5, undefined, "polynomial", 0, 10)).toBe(0);
    expect(evaluateBackground(2, [1, 1, 1], "polynomial", 0, 10)).toBe(1 + 2 + 4);
    expect(evaluateBackground(0, [2, 3], "cosine", 0, 10)).toBeCloseTo(5, 10);
    expect(evaluateBackground(5, [2, 3], "powerSeries", 0, 10)).toBeCloseTo(2, 10);
  });
});
