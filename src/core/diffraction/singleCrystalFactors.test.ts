import { describe, it, expect } from "vitest";
import {
  singleCrystalLorentz,
  polarizationFactor,
  extinctionFactor,
  shelxWeights,
  singleCrystalAgreement,
} from "@/core/diffraction/singleCrystalFactors";
import type { Radiation } from "@/core/diffraction/types";

const xray: Radiation = { kind: "xray", wavelength: 0.71073 };
const neutron: Radiation = { kind: "neutron", wavelength: 1.54 };

describe("single-crystal Lorentz / polarization", () => {
  it("L = 1/sin2θ matches a hand computation", () => {
    // d = 2 Å, λ = 0.71073 → sinθ = λ/2d, θ, then 1/sin2θ.
    const d = 2;
    const sinT = xray.wavelength / (2 * d);
    const theta = Math.asin(sinT);
    expect(singleCrystalLorentz(xray, d)).toBeCloseTo(1 / Math.sin(2 * theta), 10);
  });

  it("polarization is 1 for neutrons, <1 for X-rays away from 2θ=0", () => {
    expect(polarizationFactor(neutron, 2)).toBe(1);
    expect(polarizationFactor(xray, 2)).toBeLessThan(1);
  });

  it("TOF has unit Lorentz here (no single θ)", () => {
    expect(singleCrystalLorentz({ kind: "neutron-tof" }, 2)).toBe(1);
  });
});

describe("extinction", () => {
  it("is 1 when the parameter is 0 and damps strong low-angle reflections", () => {
    expect(extinctionFactor(0, 1000, xray, 3)).toBe(1);
    const y = extinctionFactor(0.5, 1000, xray, 3);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(1);
    // A stronger reflection is damped more.
    expect(extinctionFactor(0.5, 5000, xray, 3)).toBeLessThan(y);
  });
});

describe("SHELX F² weights and agreement", () => {
  it("reduces to 1/σ² when a = b = 0", () => {
    const w = shelxWeights([100], [100], [4], 0, 0);
    expect(w[0]).toBeCloseTo(1 / 16, 10);
  });

  it("R1/wR2/GooF are zero for a perfect fit", () => {
    const fo = [100, 50, 25];
    const w = shelxWeights(fo, fo, [2, 2, 2]);
    const ag = singleCrystalAgreement(fo, fo, [2, 2, 2], w, 1);
    expect(ag.r1).toBeCloseTo(0, 10);
    expect(ag.wr2).toBeCloseTo(0, 10);
    expect(ag.goof).toBeCloseTo(0, 10);
  });

  it("counts observed reflections above the σ cutoff", () => {
    const fo = [100, 1]; // second is weak: 1 < 2·σ(=2)
    const fc = [100, 1];
    const w = shelxWeights(fo, fc, [2, 2]);
    const ag = singleCrystalAgreement(fo, fc, [2, 2], w, 1, 2);
    expect(ag.observed).toBe(1);
    expect(ag.total).toBe(2);
  });

  it("wR2 matches its definition on a mismatched fit", () => {
    const fo = [100, 40];
    const fc = [90, 44];
    const sig = [5, 3];
    const w = shelxWeights(fo, fc, sig);
    const ag = singleCrystalAgreement(fo, fc, sig, w, 1);
    let num = 0, den = 0;
    for (let i = 0; i < 2; i++) {
      num += w[i]! * (fo[i]! - fc[i]!) ** 2;
      den += w[i]! * fo[i]! * fo[i]!;
    }
    expect(ag.wr2).toBeCloseTo(Math.sqrt(num / den), 10);
  });
});
