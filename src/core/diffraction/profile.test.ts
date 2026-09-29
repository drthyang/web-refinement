import { describe, it, expect } from "vitest";
import {
  tchPseudoVoigt, lorentzianFwhm, cagliotiFwhm, fcjSubPeaks, gaussian, pseudoVoigt, synthesizePattern,
  PEAK_WINDOW_FWHM, type ProfileOptions, type ProfilePeak,
} from "@/core/diffraction/profile";

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

describe("finite peak support", () => {
  // A strong pseudo-Voigt with a large Lorentzian fraction: at the ±20 Γ edge
  // its tail is still ~3·10⁻⁴ of the peak height, which a hard cutoff dropped
  // at once — a jump in y whenever the moving edge crossed a data point.
  const peak: ProfilePeak = { center: 50, intensity: 1e6, fwhm: 0.3, eta: 0.6 };
  const opts: ProfileOptions = { shape: "pseudoVoigt" };
  const edge = peak.center + PEAK_WINDOW_FWHM * peak.fwhm;
  /** A 0.02° grid over the whole support with one point exactly on the upper edge. */
  const grid = Array.from({ length: 701 }, (_, i) => (i === 600 ? edge : edge + (i - 600) * 0.02));

  it("fades each peak to exactly zero at the edge of its support", () => {
    const top = synthesizePattern([peak.center], [peak], opts)[0]!;
    const tail = peak.intensity * pseudoVoigt(edge, peak.center, peak.fwhm, peak.eta!);
    expect(tail / top).toBeGreaterThan(1e-4); // what a hard cutoff dropped here
    const [inside, onEdge] = synthesizePattern([edge - 1e-6, edge], [peak], opts);
    expect(onEdge).toBe(0);
    expect(inside! / top).toBeLessThan(1e-15);
  });

  it("has a width derivative that matches the analytic one at every finite-difference step", () => {
    // ∂/∂Γ of the untruncated pseudo-Voigt at fixed η. The fade changes it only
    // in the outer 20 % of the support, where the profile is already ≲ 10⁻³ of the peak.
    const analytic = grid.map((x) => {
      const d = x - peak.center;
      const g = peak.fwhm;
      const q = d * d + (g * g) / 4;
      const dL = (d * d - (g * g) / 4) / (2 * Math.PI * q * q);
      const dG = gaussian(x, peak.center, g) * (-1 / g + (8 * Math.LN2 * d * d) / (g * g * g));
      return peak.intensity * (peak.eta! * dL + (1 - peak.eta!) * dG);
    });
    const scale = Math.max(...analytic.map(Math.abs));
    for (const rel of [1e-2, 1e-4, 1e-6, 1e-8]) {
      const h = peak.fwhm * rel;
      const yF = synthesizePattern(grid, [{ ...peak, fwhm: peak.fwhm + h }], opts);
      const yB = synthesizePattern(grid, [{ ...peak, fwhm: peak.fwhm - h }], opts);
      let worst = 0;
      for (let i = 0; i < grid.length; i++) worst = Math.max(worst, Math.abs((yF[i]! - yB[i]!) / (2 * h) - analytic[i]!));
      // A hard cutoff put jump/2h on the edge point: 1.6 % of the scale at 10⁻², 1.6·10⁴ at 10⁻⁸.
      expect(worst / scale, `h = ${rel}·Γ`).toBeLessThan(5e-3);
    }
  });

  it("gives the same pattern on ascending, descending and unordered grids", () => {
    const peaks: ProfilePeak[] = [peak, { center: 53, intensity: 4e5, fwhm: 0.4, eta: 0.3 }];
    const asc = synthesizePattern(grid, peaks, opts);
    const desc = synthesizePattern([...grid].reverse(), peaks, opts).reverse();
    const order = grid.map((_, i) => (i * 263) % grid.length); // a fixed permutation (263 ⊥ 701)
    const mixed = synthesizePattern(order.map((i) => grid[i]!), peaks, opts);
    for (let i = 0; i < grid.length; i++) {
      expect(desc[i]).toBe(asc[i]);
      expect(Math.abs(mixed[order.indexOf(i)]! - asc[i]!)).toBeLessThanOrEqual(1e-12 * Math.abs(asc[i]!));
    }
  });
});
