import { describe, it, expect } from "vitest";
import { tchPseudoVoigt, lorentzianFwhm, cagliotiFwhm, fcjSubPeaks } from "@/core/diffraction/profile";

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

describe("Finger–Cox–Jephcoat axial-divergence asymmetry", () => {
  it("returns a single unit-weight peak when the asymmetry is negligible", () => {
    const subs = fcjSubPeaks(30, { sl: 0, hl: 0 });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.center).toBe(30);
    expect(subs[0]!.weight).toBe(1);
  });

  it("spreads a peak into a low-angle tail with weights summing to 1", () => {
    const subs = fcjSubPeaks(4, { sl: 0.02, hl: 0.02 });
    expect(subs.length).toBeGreaterThan(1);
    for (const s of subs) expect(s.center).toBeLessThanOrEqual(4 + 1e-9); // 2θ<90 ⇒ tail below
    expect(subs.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1, 6);
  });

  it("shifts the intensity centroid to lower angle", () => {
    const subs = fcjSubPeaks(4, { sl: 0.03, hl: 0.03 });
    const centroid = subs.reduce((a, s) => a + s.center * s.weight, 0);
    expect(centroid).toBeLessThan(4);
  });

  it("produces a longer tail at lower scattering angle", () => {
    const lowTail = 4 - Math.min(...fcjSubPeaks(4, { sl: 0.03, hl: 0.03 }).map((s) => s.center));
    const highTail = 40 - Math.min(...fcjSubPeaks(40, { sl: 0.03, hl: 0.03 }).map((s) => s.center));
    expect(lowTail).toBeGreaterThan(highTail);
  });
});
