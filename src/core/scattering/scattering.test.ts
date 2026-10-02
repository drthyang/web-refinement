import { describe, it, expect } from "vitest";
import {
  boundCoherentLength,
  NEUTRON_B,
  NEUTRON_B_ISOTOPES,
  tabulatedIsotopes,
} from "@/core/scattering/neutron";
import { NEUTRON_CROSS_SECTIONS } from "@/core/scattering/neutronCrossSectionData";

/** Real part b′ of the bound coherent length (fm). */
const bRe = (element: string, isotope?: number): number => boundCoherentLength(element, isotope).re;
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
  Ac: 89, Th: 90, Pa: 91, U: 92, Np: 93, Pu: 94, Am: 95, Cm: 96, Bk: 97, Cf: 98,
};

describe("neutron scattering lengths (Sears 1992, via NIST)", () => {
  it("Mn, O, Ga match GSAS-II printed values (fm)", () => {
    expect(bRe("Mn")).toBeCloseTo(-3.73, 2);
    expect(bRe("O")).toBeCloseTo(5.803, 2);
    expect(bRe("Ga")).toBeCloseTo(7.288, 2);
  });
  it("throws for an unknown element", () => {
    expect(() => bRe("Xx")).toThrow();
  });
  it("covers the periodic table, not just a handful of elements", () => {
    expect(Object.keys(NEUTRON_B).length).toBeGreaterThanOrEqual(89);
    for (const el of ["B", "Sc", "Ag", "Cd", "In", "Sb", "I", "Gd", "Hf", "Ta", "Re", "U"]) {
      expect(NEUTRON_B[el], el).toBeDefined();
    }
    expect(bRe("Ag")).toBeCloseTo(5.922, 3);
    expect(bRe("U")).toBeCloseTo(8.417, 3);
  });
  it("is the Neutron News 1992 evaluation, without GSAS-II's per-element pins", () => {
    // Ti, Mn, Zn: Sears (1992), which the ITC Vol. C edition revises
    // (−3.37, −3.75, 5.6). Au: Sears (1992) 7.63, not the 7.90 of Rauch &
    // Waschkowski (2003) that GSAS-II's AtmBlens carries.
    expect(bRe("Ti")).toBe(-3.438);
    expect(bRe("Mn")).toBe(-3.73);
    expect(bRe("Zn")).toBe(5.68);
    expect(bRe("Au")).toBe(7.63);
  });
  it("Hf is 7.77: NIST's 7.7 contradicts its own σ_coh = 7.6 b", () => {
    // 4π·7.7²/100 = 7.45 b; 4π·7.77²/100 = 7.59 b. The ITC edition and Rauch
    // (2003) both give 7.77, so 7.7 is read as an entry error.
    expect(bRe("Hf")).toBe(7.77);
    expect((4 * Math.PI * 7.77 ** 2) / 100).toBeCloseTo(NEUTRON_CROSS_SECTIONS.Hf!.coherent, 1);
  });
  it("In is 4.065 − 0.0539i fm (2.08 is In's σ_coh in barn, not b)", () => {
    expect(boundCoherentLength("In")).toEqual({ re: 4.065, im: -0.0539 });
  });
  it("stores b = b′ − i·b″ as printed: absorbers carry a negative imaginary part", () => {
    expect(boundCoherentLength("B")).toEqual({ re: 5.3, im: -0.213 });
    expect(boundCoherentLength("Cd")).toEqual({ re: 4.87, im: -0.7 });
    expect(boundCoherentLength("Sm")).toEqual({ re: 0.8, im: -1.65 });
    expect(boundCoherentLength("Eu")).toEqual({ re: 7.22, im: -1.26 });
    expect(boundCoherentLength("Gd")).toEqual({ re: 6.5, im: -13.82 });
    expect(boundCoherentLength("Dy")).toEqual({ re: 16.9, im: -0.276 });
    expect(boundCoherentLength("He", 3)).toEqual({ re: 5.74, im: -1.483 });
    for (const [key, b] of [...Object.entries(NEUTRON_B), ...Object.entries(NEUTRON_B_ISOTOPES)]) {
      expect(b.im, key).toBeLessThanOrEqual(0);
    }
  });
  it("agrees with the tabulated σ_coh = 4π|b|²/100 (catches a b/σ mix-up like In)", () => {
    // Sears' own printed b and σ_coh disagree beyond rounding for Xe and Eu
    // (Hf's 7.7 did too; it is corrected to 7.77, which fits).
    const printedInconsistency = new Set(["Xe", "Eu"]);
    let checked = 0;
    for (const [el, xs] of Object.entries(NEUTRON_CROSS_SECTIONS)) {
      const b = NEUTRON_B[el];
      if (!b || printedInconsistency.has(el)) continue;
      const sigma = (4 * Math.PI * (b.re * b.re + b.im * b.im)) / 100;
      expect(Math.abs(sigma - xs.coherent) / xs.coherent, el).toBeLessThan(0.02);
      checked++;
    }
    expect(checked).toBeGreaterThan(70);
  });
  it("Pu, Cm and Am need an explicit isotope", () => {
    // Sears gives no element value for Pu and Cm; its Am row carries ²⁴³Am's
    // half-life (7.37E3 a), so it is the ²⁴³Am value, not ²⁴¹Am's.
    expect(NEUTRON_B.Pu).toBeUndefined();
    expect(NEUTRON_B.Cm).toBeUndefined();
    expect(NEUTRON_B.Am).toBeUndefined();
    expect(() => bRe("Am")).toThrow(/Am has no natural-abundance.*isotope.*Am 243/);
    expect(bRe("Am", 243)).toBe(8.3);
    expect(() => bRe("Am", 241)).toThrow(/241Am/);
    expect(() => bRe("Pu")).toThrow(/isotope.*238, 239, 240, 242/);
    expect(() => bRe("Cm")).toThrow(/isotope.*244, 246, 248/);
    expect(bRe("Pu", 238)).toBe(14.1);
    expect(bRe("Pu", 239)).toBe(7.7);
    expect(bRe("Pu", 242)).toBe(8.1);
    expect(bRe("Cm", 244)).toBe(9.5);
    expect(tabulatedIsotopes("Pu")).toEqual([238, 239, 240, 242]);
  });
  it("resolves isotopes, and never falls back to the natural value", () => {
    expect(bRe("H", 2)).toBe(6.671);
    expect(bRe("D")).toBe(6.671);
    expect(bRe("Ni", 62)).toBe(-8.7);
    expect(bRe("Li", 7)).toBe(-2.22);
    expect(() => bRe("Fe", 99)).toThrow(/99Fe.*54, 56, 57, 58/);
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
    expect(Object.keys(CROMER_MANN).length).toBe(98); // H–Cf, no gaps
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
  it("carries the ITC Pu row, not DABAX's shuffled one", () => {
    // DABAX f0_InterTables prints the ITC Np4+ row under "Pu" (f0(0) = 89), so
    // the generator takes Pu from the cctbx transcription of ITC Vol. C Table
    // 6.1.1.4 — the row gemmi and GSAS-II also carry.
    expect(CROMER_MANN.Pu).toEqual({
      a: [36.5254, 23.8083, 16.7707, 3.47947],
      b: [0.499384, 3.26371, 14.9455, 105.98],
      c: 13.3812,
    });
    expect(xrayFormFactor("Pu", 0)).toBeCloseTo(93.96507, 5);
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
  it("adds the (2/g − 1)·⟨j2⟩ term for g ≠ 2 when ⟨j2⟩ is tabulated", () => {
    const s = 0.4;
    const g = 1.8;
    const expected = magneticFormFactorJ0("Fe3", s) + (2 / g - 1) * magneticFormFactorJ2("Fe3", s);
    expect(magneticFormFactorDipole("Fe3", s, g)).toBeCloseTo(expected, 10);
    // …and the orbital term actually changes the value.
    expect(magneticFormFactorDipole("Fe3", s, g)).not.toBeCloseTo(magneticFormFactorJ0("Fe3", s), 6);
  });
  it("pins Tb³⁺ (g = 3/2) to the Lovesey eq. 11.110 / Mantid sign", () => {
    // The ⟨j2⟩ weight is the orbital fraction (2 − g)/g = +1/3, so for g < 2 the
    // orbital term raises f above ⟨j0⟩. The opposite sign gives 0.383 here.
    const g = 1.5;
    const s = 5 / (4 * Math.PI); // Q = 5 Å⁻¹, s = Q/4π
    expect(magneticFormFactorDipole("Tb3", 0, g)).toBeCloseTo(1, 3);
    expect(Math.abs(magneticFormFactorDipole("Tb3", s, g) - 0.499)).toBeLessThanOrEqual(0.002);
    expect(magneticFormFactorDipole("Tb3", s, g)).toBeGreaterThan(magneticFormFactorJ0("Tb3", s));
  });
  it("falls back to ⟨j0⟩ when the ion has no tabulated ⟨j2⟩ (any g)", () => {
    expect(magneticFormFactorDipole("Pr3", 0.4, 1.8)).toBeCloseTo(magneticFormFactorJ0("Pr3", 0.4), 10);
    expect(magneticTable.hasJ2?.("Pr3")).toBe(false);
    expect(magneticTable.has("Pr3")).toBe(true);
    expect(magneticTable.hasJ2?.("Fe3")).toBe(true);
  });
});
