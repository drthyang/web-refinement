import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import {
  EIGHT_PI_SQUARED,
  bIsoFromUAniso,
  toAnisotropic,
  toIsotropic,
  uIsoFromBIso,
  withAdpModel,
} from "@/core/crystal/adp";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import type { PowderPattern } from "@/core/diffraction/types";

describe("B_iso ↔ U_iso conversion", () => {
  it("uses U_iso = B_iso / 8π²", () => {
    expect(uIsoFromBIso(EIGHT_PI_SQUARED)).toBeCloseTo(1, 12);
    expect(uIsoFromBIso(0.5)).toBeCloseTo(0.5 / (8 * Math.PI ** 2), 12);
  });
  it("round-trips B → spherical U → B via the equivalent isotropic U", () => {
    const b = 0.83;
    const aniso = toAnisotropic({ kind: "isotropic", bIso: b });
    expect(aniso.kind).toBe("anisotropic");
    if (aniso.kind === "anisotropic") {
      const u = uIsoFromBIso(b);
      expect(aniso.uAniso).toEqual([u, u, u, 0, 0, 0]);
      expect(bIsoFromUAniso(aniso.uAniso)).toBeCloseTo(b, 12);
    }
  });
  it("passes an already-anisotropic tensor through unchanged", () => {
    const adp = { kind: "anisotropic", uAniso: [0.01, 0.02, 0.015, 0.001, 0, -0.002] } as const;
    expect(toAnisotropic(adp)).toBe(adp);
  });
  it("demotes an anisotropic tensor to its equivalent B_iso (trace/3)", () => {
    const adp = { kind: "anisotropic", uAniso: [0.01, 0.02, 0.03, 0, 0, 0] } as const;
    const iso = toIsotropic(adp);
    expect(iso.kind).toBe("isotropic");
    if (iso.kind === "isotropic") expect(iso.bIso).toBeCloseTo(EIGHT_PI_SQUARED * 0.02, 12);
  });
});

describe("withAdpModel + refinement wiring", () => {
  const structure: StructureModel = {
    id: "t",
    name: "t",
    cell: { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: buildSpaceGroup(225), // Fm-3m: Wyckoff 4a at origin → cubic site symmetry
    sites: [{ label: "Na1", element: "Na", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.6 } }],
  };
  const pattern: PowderPattern = {
    id: "p", name: "p", xUnit: "twoTheta",
    radiation: { kind: "xray", wavelength: 1.54 }, wavelength: 1.54,
    points: Array.from({ length: 50 }, (_, i) => ({ x: 10 + i, yObs: 0 })),
  };

  it("promotes every site to anisotropic, seeding U from B_iso", () => {
    const promoted = withAdpModel(structure, "anisotropic");
    expect(promoted.sites[0]!.adp.kind).toBe("anisotropic");
    if (promoted.sites[0]!.adp.kind === "anisotropic") {
      const u = 0.6 / EIGHT_PI_SQUARED;
      expect(promoted.sites[0]!.adp.uAniso).toEqual([u, u, u, 0, 0, 0]);
    }
  });

  it("isotropic build emits a bIso row; anisotropic build emits symmetry-allowed U modes", () => {
    const iso = buildStructureRefinement(structure, pattern, { scale: 1 });
    expect(iso.params.filter((p) => p.kind === "bIso")).toHaveLength(1);
    expect(iso.params.filter((p) => p.kind === "uAniso")).toHaveLength(0);

    const promoted = withAdpModel(structure, "anisotropic");
    const ani = buildStructureRefinement(promoted, pattern, { scale: 1 });
    expect(ani.params.filter((p) => p.kind === "bIso")).toHaveLength(0);
    const uModes = ani.params.filter((p) => p.kind === "uAniso");
    // A cubic 4a site (m-3m) allows only the single isotropic U mode (U11=U22=U33).
    expect(uModes.length).toBe(1);
    // Its seed equals the promoted U_iso.
    expect(uModes[0]!.value).toBeCloseTo(0.6 / EIGHT_PI_SQUARED, 6);
  });
});
