import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import { cos2Psi, uniaxialSizeFwhmDeg, uniaxialSizeDimensions } from "@/core/diffraction/anisoSize";

const tetragonal: UnitCell = { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 };
const wavelength = 1.5406;
const cAxis = [0, 0, 1] as [number, number, number];

describe("cos2Psi", () => {
  it("is 1 along the axis and 0 perpendicular to it (orthogonal cell)", () => {
    expect(cos2Psi(tetragonal, 0, 0, 1, cAxis)).toBeCloseTo(1, 10); // (00l) ‖ c*
    expect(cos2Psi(tetragonal, 1, 0, 0, cAxis)).toBeCloseTo(0, 10); // (h00) ⊥ c*
  });

  it("is between 0 and 1 for an oblique reflection", () => {
    const c2 = cos2Psi(tetragonal, 1, 0, 1, cAxis);
    expect(c2).toBeGreaterThan(0);
    expect(c2).toBeLessThan(1);
  });
});

describe("uniaxialSizeFwhmDeg", () => {
  it("reduces to the isotropic X/(100·cosθ) when X_∥ = X_⊥", () => {
    const size = { xPerp: 8, xPar: 8, axis: cAxis };
    for (const [h, k, l] of [[1, 0, 0], [0, 0, 2], [1, 1, 2]] as const) {
      const d = 1 / Math.sqrt((h * h + k * k) / 16 + (l * l) / 36);
      const theta = Math.asin(wavelength / (2 * d));
      const expected = 8 / (100 * Math.cos(theta));
      expect(uniaxialSizeFwhmDeg(h, k, l, tetragonal, wavelength, size)).toBeCloseTo(expected, 10);
    }
  });

  it("gives (00l) the polar coefficient and (h00) the equatorial one", () => {
    const size = { xPerp: 4, xPar: 12, axis: cAxis };
    // (002): cos²ψ = 1 ⇒ X = X_∥ = 12.
    const d002 = 1 / Math.sqrt(4 / 36);
    const t002 = Math.asin(wavelength / (2 * d002));
    expect(uniaxialSizeFwhmDeg(0, 0, 2, tetragonal, wavelength, size)).toBeCloseTo(12 / (100 * Math.cos(t002)), 8);
    // (200): cos²ψ = 0 ⇒ X = X_⊥ = 4.
    const d200 = 1 / Math.sqrt(4 / 16);
    const t200 = Math.asin(wavelength / (2 * d200));
    expect(uniaxialSizeFwhmDeg(2, 0, 0, tetragonal, wavelength, size)).toBeCloseTo(4 / (100 * Math.cos(t200)), 8);
  });

  it("a needle (large X_∥) broadens axial reflections more than equatorial", () => {
    const size = { xPerp: 3, xPar: 15, axis: cAxis };
    const axial = uniaxialSizeFwhmDeg(0, 0, 4, tetragonal, wavelength, size);
    const equat = uniaxialSizeFwhmDeg(4, 0, 0, tetragonal, wavelength, size);
    expect(axial).toBeGreaterThan(equat);
  });
});

describe("uniaxialSizeDimensions", () => {
  it("converts each coefficient through the Scherrer relation", () => {
    const dims = uniaxialSizeDimensions({ xPerp: 10, xPar: 5, axis: cAxis }, 1.5406, 0.9);
    expect(dims.perpendicularNm).toBeCloseTo((18000 * 0.9 * 1.5406) / (Math.PI * 10) / 10, 6);
    expect(dims.parallelNm).toBeCloseTo((18000 * 0.9 * 1.5406) / (Math.PI * 5) / 10, 6);
    // Smaller X ⇒ larger dimension.
    expect(dims.parallelNm).toBeGreaterThan(dims.perpendicularNm);
  });
});
