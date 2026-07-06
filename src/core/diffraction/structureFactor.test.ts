import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import {
  nuclearStructureFactor,
  nuclearStructureFactorSquared,
} from "@/core/diffraction/structureFactor";
import { neutronScatteringLength } from "@/core/scattering/neutron";

// Body-centred cell, one atom at the origin: identity + (½,½,½).
const bccFe: StructureModel = {
  id: "fe",
  name: "bcc Fe",
  cell: { a: 2.8665, b: 2.8665, c: 2.8665, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: {
    operations: [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("1/2+x,1/2+y,1/2+z")],
  },
  sites: [
    { label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0 } },
  ],
};
const neutron: Radiation = { kind: "neutron", wavelength: 1.54 };

describe("nuclear structure factor — analytic golden (I-centring)", () => {
  const b = neutronScatteringLength("Fe");

  it("F = 2b when h+k+l is even", () => {
    // (110): F = b[1 + e^{2πi·1}] = 2b.
    const f = nuclearStructureFactor(bccFe, neutron, 1, 1, 0);
    expect(f.re).toBeCloseTo(2 * b, 6);
    expect(f.im).toBeCloseTo(0, 6);
    expect(nuclearStructureFactorSquared(bccFe, neutron, 1, 1, 0)).toBeCloseTo((2 * b) ** 2, 5);
  });

  it("F = 0 when h+k+l is odd (body-centring absence)", () => {
    // (100): F = b[1 + e^{iπ}] = 0.
    expect(nuclearStructureFactorSquared(bccFe, neutron, 1, 0, 0)).toBeCloseTo(0, 8);
  });

  it("Debye-Waller factor reduces |F| at higher angle", () => {
    const hot: StructureModel = {
      ...bccFe,
      sites: [{ ...bccFe.sites[0]!, adp: { kind: "isotropic", bIso: 1.0 } }],
    };
    const f2cold = nuclearStructureFactorSquared(bccFe, neutron, 2, 2, 0);
    const f2hot = nuclearStructureFactorSquared(hot, neutron, 2, 2, 0);
    expect(f2hot).toBeLessThan(f2cold);
  });
});
