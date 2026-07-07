import { describe, it, expect } from "vitest";
import { cylinderAbsorption, marchDollase } from "@/core/diffraction/intensity";
import type { UnitCell } from "@/core/crystal/types";

describe("cylinderAbsorption (GSAS-II Debye–Scherrer)", () => {
  it("is unity with no absorber and decreases as μR grows", () => {
    expect(cylinderAbsorption(0, 10)).toBe(1);
    const a05 = cylinderAbsorption(0.5, 10);
    const a1 = cylinderAbsorption(1.0, 10);
    const a2 = cylinderAbsorption(2.0, 10);
    expect(a05).toBeLessThan(1);
    expect(a1).toBeLessThan(a05);
    expect(a2).toBeLessThan(a1);
    expect(a2).toBeGreaterThan(0);
  });

  it("stays finite and positive across the μR=3 branch boundary", () => {
    for (const muR of [2.9, 3.0, 3.1, 5, 8]) {
      const a = cylinderAbsorption(muR, 20);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThan(1);
    }
  });

  it("is angle-dependent (cylinder path length varies with 2θ)", () => {
    expect(cylinderAbsorption(1.5, 5)).not.toBeCloseTo(cylinderAbsorption(1.5, 60), 4);
  });
});

describe("marchDollase preferred orientation", () => {
  const cubic: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };
  it("returns 1 for a random distribution (r=1)", () => {
    expect(marchDollase(cubic, [0, 0, 1], 1, 1, 1, 1)).toBe(1);
  });
  it("enhances the axis reflection and suppresses the perpendicular for r<1", () => {
    // Platy crystallites (r<1): the (00l) parallel to the MD axis is enhanced,
    // (h00) perpendicular is suppressed — opposite sides of 1.
    const parallel = marchDollase(cubic, [0, 0, 1], 0, 0, 2, 0.7);
    const perpendicular = marchDollase(cubic, [0, 0, 1], 2, 0, 0, 0.7);
    expect(parallel).toBeGreaterThan(1);
    expect(perpendicular).toBeLessThan(1);
  });
});
