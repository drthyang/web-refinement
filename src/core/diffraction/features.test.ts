import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { marchDollase } from "@/core/diffraction/intensity";

const neutron: Radiation = { kind: "neutron", wavelength: 1.54 };
const ops = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("1/2+x,1/2+y,1/2+z")];
const cell = { a: 2.8665, b: 2.8665, c: 2.8665, alpha: 90, beta: 90, gamma: 90 };

describe("anisotropic ADP", () => {
  it("reduces to the isotropic case when U is isotropic (U11=U22=U33, off-diag 0)", () => {
    const bIso = 0.6;
    const u = bIso / (8 * Math.PI * Math.PI);
    const iso: StructureModel = {
      id: "fe", name: "Fe", cell, spaceGroup: { operations: ops },
      sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso } }],
    };
    const aniso: StructureModel = {
      ...iso,
      sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "anisotropic", uAniso: [u, u, u, 0, 0, 0] } }],
    };
    for (const [h, k, l] of [[1, 1, 0], [2, 0, 0], [2, 1, 1]] as const) {
      expect(nuclearStructureFactorSquared(aniso, neutron, h, k, l)).toBeCloseTo(
        nuclearStructureFactorSquared(iso, neutron, h, k, l), 6,
      );
    }
  });
});

describe("March–Dollase preferred orientation", () => {
  it("returns 1 for ratio = 1 (no texture)", () => {
    expect(marchDollase(cell, [0, 0, 1], 1, 0, 0, 1)).toBe(1);
  });
  it("enhances reflections along the PO axis and suppresses perpendicular ones (r < 1)", () => {
    // r < 1 (plate texture): (00l) parallel to axis enhanced vs (h00) perpendicular.
    const parallel = marchDollase(cell, [0, 0, 1], 0, 0, 1, 0.7);
    const perpendicular = marchDollase(cell, [0, 0, 1], 1, 0, 0, 0.7);
    expect(parallel).toBeGreaterThan(perpendicular);
  });
  it("is symmetric about r = 1 in the sense P(axis, r) increases as r decreases", () => {
    const a = marchDollase(cell, [0, 0, 1], 0, 0, 1, 0.5);
    const b = marchDollase(cell, [0, 0, 1], 0, 0, 1, 0.8);
    expect(a).toBeGreaterThan(b);
  });
});
