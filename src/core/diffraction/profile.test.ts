import { describe, it, expect } from "vitest";
import { tchPseudoVoigt, lorentzianFwhm, cagliotiFwhm } from "@/core/diffraction/profile";

describe("Thompson–Cox–Hastings pseudo-Voigt", () => {
  it("reduces to a pure Gaussian when Γ_L = 0", () => {
    const { fwhm, eta } = tchPseudoVoigt(0.5, 0);
    expect(fwhm).toBeCloseTo(0.5, 10);
    expect(eta).toBeCloseTo(0, 10);
  });

  it("reduces to a pure Lorentzian when Γ_G → 0", () => {
    const { fwhm, eta } = tchPseudoVoigt(1e-9, 0.5);
    expect(fwhm).toBeCloseTo(0.5, 6);
    expect(eta).toBeCloseTo(1, 4);
  });

  it("matches the standard mixing for Γ_G = Γ_L = 1", () => {
    const { fwhm, eta } = tchPseudoVoigt(1, 1);
    expect(fwhm).toBeCloseTo(1.6346, 3);
    expect(eta).toBeCloseTo(0.6825, 3);
  });

  it("the total FWHM exceeds either component (a convolution broadens)", () => {
    const { fwhm } = tchPseudoVoigt(0.3, 0.4);
    expect(fwhm).toBeGreaterThan(0.4);
    expect(fwhm).toBeLessThan(0.3 + 0.4); // but less than the naive sum
  });
});

describe("Lorentzian size–strain width (GSAS-II X, Y)", () => {
  it("X is the zero-angle size (1/cosθ) term", () => {
    expect(lorentzianFwhm(0, { x: 0.5, y: 0 })).toBeCloseTo(0.5, 6);
  });

  it("Y is the tanθ microstrain term", () => {
    // 2θ = 90° → θ = 45° → tanθ = 1.
    expect(lorentzianFwhm(90, { x: 0, y: 1 })).toBeCloseTo(1, 6);
  });

  it("floors at zero (a negative Y cannot make the width negative)", () => {
    expect(lorentzianFwhm(120, { x: 0.1, y: -5 })).toBe(0);
  });
});

describe("Caglioti Gaussian width (sanity, unchanged)", () => {
  it("returns √W at zero angle", () => {
    expect(cagliotiFwhm(0, { u: 0, v: 0, w: 4 })).toBeCloseTo(2, 6);
  });
});
