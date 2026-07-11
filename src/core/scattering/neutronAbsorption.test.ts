import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import {
  THERMAL_WAVELENGTH,
  absorptionCrossSection,
  scatteringCrossSection,
  totalCrossSection,
  cellContents,
  absorptionBreakdown,
  linearAbsorptionCoefficient,
} from "@/core/scattering/neutronAbsorption";

const identity = parseSymmetryOperation("x,y,z");
const iso = { kind: "isotropic", bIso: 0.4 } as const;

function site(label: string, element: string, position: [number, number, number], occupancy = 1, multiplicity?: number): AtomSite {
  const base = { label, element, position, occupancy, adp: iso };
  return multiplicity === undefined ? base : { ...base, multiplicity };
}

/** P1 structure with the given sites and a cubic cell of edge `a`. */
function p1(a: number, sites: AtomSite[]): StructureModel {
  return {
    id: "t",
    name: "t",
    cell: { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P 1", operations: [identity] },
    sites,
  };
}

describe("neutron cross-sections", () => {
  it("scales absorption with the 1/v law", () => {
    // At the thermal reference the tabulated value is returned unchanged.
    expect(absorptionCrossSection("Mn", THERMAL_WAVELENGTH)).toBeCloseTo(13.3, 6);
    // Double the wavelength ⇒ double σ_a (1/v).
    expect(absorptionCrossSection("Mn", 2 * THERMAL_WAVELENGTH)).toBeCloseTo(26.6, 6);
    // Scattering is wavelength-independent.
    expect(scatteringCrossSection("Mn")).toBeCloseTo(1.75 + 0.4, 6);
    expect(totalCrossSection("Mn", THERMAL_WAVELENGTH)).toBeCloseTo(13.3 + 1.75 + 0.4, 6);
  });

  it("throws, naming the element, when cross-sections are missing", () => {
    expect(() => linearAbsorptionCoefficient(p1(4, [site("X1", "Xx", [0, 0, 0])]), THERMAL_WAVELENGTH)).toThrow(/Xx/);
  });
});

describe("cell contents (atoms per cell)", () => {
  it("sums multiplicity × occupancy per element", () => {
    // Explicit multiplicity 4 at half occupancy ⇒ 2 atoms; a full site adds 1.
    const s = p1(5, [site("Fe1", "Fe", [0, 0, 0], 0.5, 4), site("O1", "O", [0.5, 0.5, 0.5], 1, 1)]);
    const counts = cellContents(s);
    expect(counts.get("Fe")).toBeCloseTo(2, 6);
    expect(counts.get("O")).toBeCloseTo(1, 6);
  });

  it("derives multiplicity from symmetry when not given", () => {
    // Two independent P1 sites (general positions, multiplicity 1 each).
    const s = p1(3, [site("V1", "V", [0, 0, 0]), site("V2", "V", [0.5, 0.5, 0.5])]);
    expect(cellContents(s).get("V")).toBeCloseTo(2, 6);
  });
});

describe("linear absorption coefficient μ(λ)", () => {
  it("gives μ = σ_tot / V for a single atom in the cell", () => {
    // One O atom in a 2 Å cubic cell (V = 8 Å³): μ = (σ_a + σ_coh + σ_incoh) / V.
    const sigma = 0.00019 + 4.232 + 0.0008;
    const mu = linearAbsorptionCoefficient(p1(2, [site("O1", "O", [0, 0, 0])]), THERMAL_WAVELENGTH);
    expect(mu).toBeCloseTo(sigma / 8, 6);
  });

  it("reproduces vanadium's macroscopic scattering cross-section (~0.37 cm⁻¹)", () => {
    // bcc V, a = 3.024 Å, 2 atoms/cell. The scattering-only part of μ is the
    // textbook value Σ_s ≈ 0.37 cm⁻¹ (mean free path ~2.7 cm) — an external
    // anchor on both the σ(V) data and the number-density arithmetic.
    const v = p1(3.024, [site("V1", "V", [0, 0, 0]), site("V2", "V", [0.5, 0.5, 0.5])]);
    const b = absorptionBreakdown(v, THERMAL_WAVELENGTH);
    const muScatter = b.terms.reduce((s, t) => s + (t.atomsPerCell * t.sigmaScattering) / b.cellVolume, 0);
    expect(muScatter).toBeCloseTo(0.369, 2);
  });

  it("matches the convenience wrapper and orders the breakdown by contribution", () => {
    // Mn + O: Mn's large σ_a dominates, so it must be the leading term.
    const s = p1(4, [site("Mn1", "Mn", [0, 0, 0]), site("O1", "O", [0.5, 0.5, 0.5])]);
    const b = absorptionBreakdown(s, THERMAL_WAVELENGTH);
    expect(linearAbsorptionCoefficient(s, THERMAL_WAVELENGTH)).toBeCloseTo(b.mu, 10);
    expect(b.terms[0]!.element).toBe("Mn");
    expect(b.mu).toBeGreaterThan(0);
  });
});

describe("resonance-absorber warnings", () => {
  it("warns for a resonance absorber only away from the thermal reference", () => {
    const gd = p1(5, [site("Gd1", "Gd", [0, 0, 0])]);
    // Far from 1.798 Å the 1/v extrapolation is unreliable → warn.
    expect(absorptionBreakdown(gd, 4.0).resonanceWarnings).toContain("Gd");
    // At the reference wavelength the tabulated value stands on its own.
    expect(absorptionBreakdown(gd, THERMAL_WAVELENGTH).resonanceWarnings).toHaveLength(0);
  });

  it("does not warn for ordinary 1/v absorbers", () => {
    const s = p1(4, [site("Mn1", "Mn", [0, 0, 0])]);
    expect(absorptionBreakdown(s, 4.0).resonanceWarnings).toHaveLength(0);
  });
});
