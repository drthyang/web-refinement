import { describe, it, expect } from "vitest";
import { interpretStructure } from "@/core/diagnostics/interpret";
import type { StructureModel } from "@/core/crystal/types";
import type { RefinementParameter } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";

/** A minimal cubic structure with one fully-occupied Fe site. */
function structure(over: Partial<StructureModel> = {}): StructureModel {
  return {
    id: "t",
    name: "test",
    cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P m -3 m", operations: [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" }] },
    sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
    ...over,
  } as StructureModel;
}

function param(id: string, kind: RefinementParameter["kind"], value: number, initialValue = value): RefinementParameter {
  return { id, label: id, kind, value, initialValue, fixed: false };
}

describe("interpretStructure", () => {
  it("reads partial occupancy as off-stoichiometry / vacancies", () => {
    const s = structure({ sites: [{ label: "Li1", element: "Li", position: [0, 0, 0], occupancy: 0.82, adp: { kind: "isotropic", bIso: 1 } }] as StructureModel["sites"] });
    const r = interpretStructure({ structure: s });
    const f = r.findings.find((x) => x.category === "stoichiometry");
    expect(f).toBeDefined();
    expect(f?.summary).toMatch(/82.*%|vacant/i);
    expect(f?.detail).toMatch(/vacan|dopant|off-stoichiometry/i);
  });

  it("converts refined profile coefficients into a crystallite size + microstrain reading", () => {
    const params = [param("profX", "profileX", 4, 0.5), param("profY", "profileY", 8, 1)];
    const r = interpretStructure({ structure: structure(), parameters: params, wavelength: 1.54 });
    expect(r.findings.some((f) => f.category === "microstructure")).toBe(true);
  });

  it("flags a large B_iso as possible disorder", () => {
    const r = interpretStructure({ structure: structure(), parameters: [param("Fe1_B", "bIso", 5.5)] });
    const f = r.findings.find((x) => x.category === "displacement");
    expect(f?.detail).toMatch(/disorder|thermal|split/i);
  });

  it("reads an antiferromagnetic arrangement (moments cancel) with the magnitude caveat", () => {
    const magnetic: MagneticModel = {
      id: "m",
      structureId: "t",
      propagation: [[0, 0, 0]],
      moments: [
        { siteLabel: "Fe1", frame: "cartesian", components: [0, 0, 3] },
        { siteLabel: "Fe2", frame: "cartesian", components: [0, 0, -3] },
      ],
    } as MagneticModel;
    const r = interpretStructure({ structure: structure(), magnetic });
    const f = r.findings.find((x) => x.category === "magnetism");
    expect(f?.summary).toMatch(/antiferromagnetic/i);
    expect(f?.detail).toMatch(/cross-check|convention|GSAS/i);
  });

  it("a clean stoichiometric structure yields no alarming materials findings", () => {
    const r = interpretStructure({ structure: structure() });
    expect(r.summary).toMatch(/No notable|well-ordered/i);
  });
});
