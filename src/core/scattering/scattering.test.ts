import { describe, it, expect } from "vitest";
import { neutronScatteringLength, NEUTRON_B } from "@/core/scattering/neutron";
import { xrayFormFactor, CROMER_MANN } from "@/core/scattering/xray";
import {
  magneticFormFactorJ0,
  magneticFormFactorJ2,
  magneticFormFactorDipole,
  magneticTable,
} from "@/core/scattering/magnetic";
import { J0_COEFFS, J2_COEFFS } from "@/core/scattering/magneticFormFactorData";

// Atomic numbers, for asserting the X-ray f(0) = Z normalization table-wide.
const Z: Readonly<Record<string, number>> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10, Na: 11,
  Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20, Sc: 21,
  Ti: 22, V: 23, Cr: 24, Mn: 25, Fe: 26, Co: 27, Ni: 28, Cu: 29, Zn: 30, Ga: 31,
  Ge: 32, As: 33, Se: 34, Br: 35, Kr: 36, Rb: 37, Sr: 38, Y: 39, Zr: 40, Nb: 41,
  Mo: 42, Tc: 43, Ru: 44, Rh: 45, Pd: 46, Ag: 47, Cd: 48, In: 49, Sn: 50,
  Sb: 51, Te: 52, I: 53, Xe: 54, Cs: 55, Ba: 56, La: 57, Ce: 58, Pr: 59, Nd: 60,
  Pm: 61, Sm: 62, Eu: 63, Gd: 64, Tb: 65, Dy: 66, Ho: 67, Er: 68, Tm: 69,
  Yb: 70, Lu: 71, Hf: 72, Ta: 73, W: 74, Re: 75, Os: 76, Ir: 77, Pt: 78, Au: 79,
  Hg: 80, Tl: 81, Pb: 82, Bi: 83, Po: 84, At: 85, Rn: 86, Fr: 87, Ra: 88,
  Ac: 89, Th: 90, Pa: 91, U: 92, Np: 93, Am: 95, Cm: 96, Bk: 97, Cf: 98,
};

describe("neutron scattering lengths (match GSAS-II .lst)", () => {
  it("Mn, O, Ga match GSAS-II printed values (fm)", () => {
    expect(neutronScatteringLength("Mn")).toBeCloseTo(-3.73, 2);
    expect(neutronScatteringLength("O")).toBeCloseTo(5.803, 2);
    expect(neutronScatteringLength("Ga")).toBeCloseTo(7.288, 2);
  });
  it("throws for an unknown element", () => {
    expect(() => neutronScatteringLength("Xx")).toThrow();
  });
  it("covers the periodic table, not just a handful of elements", () => {
    // The table used to hold ~50 curated elements; it now spans the full range.
    expect(Object.keys(NEUTRON_B).length).toBeGreaterThanOrEqual(90);
    // Common elements that were previously missing must resolve.
    for (const el of ["B", "Sc", "Ag", "Cd", "In", "Sb", "I", "Gd", "Hf", "Ta", "Re", "U"]) {
      expect(NEUTRON_B[el], el).toBeDefined();
    }
    // A few authoritative Sears/ITC values (fm).
    expect(neutronScatteringLength("B")).toBeCloseTo(5.3, 1);
    expect(neutronScatteringLength("Ag")).toBeCloseTo(5.922, 2);
    expect(neutronScatteringLength("Gd")).toBeCloseTo(6.5, 1);
    expect(neutronScatteringLength("U")).toBeCloseTo(8.417, 2);
  });
  it("keeps the GSAS-II-pinned values after regeneration", () => {
    expect(neutronScatteringLength("Ti")).toBeCloseTo(-3.438, 3);
    expect(neutronScatteringLength("Mn")).toBeCloseTo(-3.73, 3);
    expect(neutronScatteringLength("Zn")).toBeCloseTo(5.68, 3);
    expect(neutronScatteringLength("Au")).toBeCloseTo(7.9, 3);
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
  it("covers the periodic table with every row normalized to Z at s = 0", () => {
    expect(Object.keys(CROMER_MANN).length).toBeGreaterThanOrEqual(97);
    // Previously-missing common elements must resolve now.
    for (const el of ["H", "Ca", "Zn", "Ge", "Sr", "Zr", "Ba", "La", "Ce", "W", "Pb", "U"]) {
      expect(CROMER_MANN[el], el).toBeDefined();
    }
    // Every tabulated neutral atom must give f(0) = Z (the physical
    // constraint); the Cromer-Mann least-squares fit holds it to < 0.1 e.
    for (const el of Object.keys(CROMER_MANN)) {
      const z = Z[el];
      expect(z, `Z for ${el}`).toBeDefined();
      expect(Math.abs(xrayFormFactor(el, 0) - z!), el).toBeLessThan(0.1);
    }
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
  it("is the complete ITC-C ⟨j0⟩/⟨j2⟩ set, every ion normalized correctly", () => {
    // Full table (3d/4d transition metals + lanthanides + actinides).
    expect(Object.keys(J0_COEFFS).length).toBeGreaterThanOrEqual(97);
    expect(Object.keys(J2_COEFFS).length).toBeGreaterThanOrEqual(95);
    // Every ⟨j0⟩ ion is normalized to 1 at s = 0; every ⟨j2⟩ has ⟨j0⟩ too.
    for (const ion of Object.keys(J0_COEFFS)) {
      expect(magneticFormFactorJ0(ion, 0), ion).toBeCloseTo(1, 2);
    }
    for (const ion of Object.keys(J2_COEFFS)) {
      expect(J0_COEFFS[ion], `${ion} has ⟨j2⟩ but no ⟨j0⟩`).toBeDefined();
    }
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
