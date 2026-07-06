import { describe, it, expect } from "vitest";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import { xrayFormFactor } from "@/core/scattering/xray";
import { magneticFormFactorJ0 } from "@/core/scattering/magnetic";

describe("neutron scattering lengths (match GSAS-II .lst)", () => {
  it("Mn, O, Ga match GSAS-II printed values (fm)", () => {
    expect(neutronScatteringLength("Mn")).toBeCloseTo(-3.73, 2);
    expect(neutronScatteringLength("O")).toBeCloseTo(5.803, 2);
    expect(neutronScatteringLength("Ga")).toBeCloseTo(7.288, 2);
  });
  it("throws for an unknown element", () => {
    expect(() => neutronScatteringLength("Xx")).toThrow();
  });
});

describe("X-ray form factors (Cromer-Mann)", () => {
  it("equals the electron count Z at s = 0", () => {
    // f(0) = Σ a_i + c. Mn → 25 e⁻, O → 8 e⁻, Ga → 31 e⁻.
    expect(xrayFormFactor("Mn", 0)).toBeCloseTo(25, 1);
    expect(xrayFormFactor("O", 0)).toBeCloseTo(8, 1);
    expect(xrayFormFactor("Ga", 0)).toBeCloseTo(31, 1);
  });
  it("decreases with increasing s", () => {
    expect(xrayFormFactor("Mn", 0.5)).toBeLessThan(xrayFormFactor("Mn", 0));
  });
});

describe("magnetic form factor ⟨j0⟩", () => {
  it("is normalized to 1 at s = 0", () => {
    expect(magneticFormFactorJ0("Mn2", 0)).toBeCloseTo(1, 2);
    expect(magneticFormFactorJ0("Fe3", 0)).toBeCloseTo(1, 2);
  });
  it("decreases with increasing s", () => {
    expect(magneticFormFactorJ0("Mn2", 0.5)).toBeLessThan(magneticFormFactorJ0("Mn2", 0));
  });
});
