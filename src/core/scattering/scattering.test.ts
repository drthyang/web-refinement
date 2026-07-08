import { describe, it, expect } from "vitest";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import { xrayFormFactor } from "@/core/scattering/xray";
import {
  magneticFormFactorJ0,
  magneticFormFactorJ2,
  magneticFormFactorDipole,
  magneticTable,
} from "@/core/scattering/magnetic";

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

describe("magnetic form factor ⟨j0⟩ (ITC-C Vol. C §4.4.5)", () => {
  it("is normalized to 1 at s = 0", () => {
    // Every tabulated ion must satisfy ⟨j0⟩(0) = A + B + C + D = 1.
    for (const ion of ["Mn2", "Fe3", "Cr3", "Ce2", "U4", "Ni2", "Co2"]) {
      expect(magneticFormFactorJ0(ion, 0)).toBeCloseTo(1, 2);
    }
  });
  it("decreases with increasing s", () => {
    expect(magneticFormFactorJ0("Mn2", 0.5)).toBeLessThan(magneticFormFactorJ0("Mn2", 0));
  });
  it("matches the periodictable Fe²⁺ reference values", () => {
    // periodictable's doctest: Fe.ion[2].M_Q([0, 0.1, 0.2]) = [1, 0.99935, 0.99741],
    // where its Q maps to our s = Q/(4π). Locks the coefficients + convention.
    expect(magneticFormFactorJ0("Fe2", 0)).toBeCloseTo(1.0, 5);
    expect(magneticFormFactorJ0("Fe2", 0.1 / (4 * Math.PI))).toBeCloseTo(0.99935, 4);
    expect(magneticFormFactorJ0("Fe2", 0.2 / (4 * Math.PI))).toBeCloseTo(0.99741, 4);
  });
  it("covers 3d, rare-earth, and actinide ions", () => {
    for (const ion of ["Mn2", "Fe3", "Cr3", "V3", "Ce2", "Nd3", "Gd3", "U4", "Np5"]) {
      expect(magneticTable.has(ion)).toBe(true);
    }
    expect(magneticTable.has("Zz9")).toBe(false);
  });
});

describe("magnetic form factor ⟨j2⟩", () => {
  it("vanishes at s = 0 (s² prefactor)", () => {
    expect(magneticFormFactorJ2("Mn2", 0)).toBe(0);
    expect(magneticFormFactorJ2("Fe3", 0)).toBe(0);
  });
  it("returns NaN for an ion without tabulated ⟨j2⟩", () => {
    // Pr³⁺ has ⟨j0⟩ but no ⟨j2⟩ in the CrysFML table.
    expect(Number.isNaN(magneticFormFactorJ2("Pr3", 0.3))).toBe(true);
  });
});

describe("magnetic form factor — dipole approximation", () => {
  it("reduces to spin-only ⟨j0⟩ for g = 2", () => {
    for (const s of [0, 0.25, 0.5]) {
      expect(magneticFormFactorDipole("Fe3", s, 2)).toBeCloseTo(magneticFormFactorJ0("Fe3", s), 10);
    }
  });
  it("adds the (1 − 2/g)·⟨j2⟩ term for g ≠ 2 when ⟨j2⟩ is tabulated", () => {
    const s = 0.4;
    const g = 1.8;
    const expected = magneticFormFactorJ0("Fe3", s) + (1 - 2 / g) * magneticFormFactorJ2("Fe3", s);
    expect(magneticFormFactorDipole("Fe3", s, g)).toBeCloseTo(expected, 10);
    // …and the orbital term actually changes the value.
    expect(magneticFormFactorDipole("Fe3", s, g)).not.toBeCloseTo(magneticFormFactorJ0("Fe3", s), 6);
  });
  it("falls back to ⟨j0⟩ when the ion has no tabulated ⟨j2⟩ (any g)", () => {
    expect(magneticFormFactorDipole("Pr3", 0.4, 1.8)).toBeCloseTo(magneticFormFactorJ0("Pr3", 0.4), 10);
    expect(magneticTable.hasJ2?.("Pr3")).toBe(false);
    expect(magneticTable.has("Pr3")).toBe(true);
    expect(magneticTable.hasJ2?.("Fe3")).toBe(true);
  });
});
