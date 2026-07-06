import { describe, expect, it } from "vitest";
import { chebyshevBackground, polynomialBackground, evaluateBackground } from "@/core/diffraction/background";

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

describe("evaluateBackground", () => {
  it("dispatches by type and returns 0 for empty coeffs", () => {
    expect(evaluateBackground(5, [], "chebyshev", 0, 10)).toBe(0);
    expect(evaluateBackground(5, undefined, "polynomial", 0, 10)).toBe(0);
    expect(evaluateBackground(2, [1, 1, 1], "polynomial", 0, 10)).toBe(1 + 2 + 4);
  });
});
