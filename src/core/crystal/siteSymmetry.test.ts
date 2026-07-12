import { describe, it, expect } from "vitest";
import { analyzeSiteSymmetry } from "@/core/crystal/siteSymmetry";
import { classifyPointGroup } from "@/core/crystal/pointGroup";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { exampleStructure } from "@/examples/mn3ga";
import type { StructureModel } from "@/core/crystal/types";

/**
 * Site-symmetry diagnostic — the F2 "what can I refine here?" answer. The
 * governing invariant is orbit–stabilizer: multiplicity × site-symmetry order =
 * the crystal's point-group order, and the free-parameter counts follow from the
 * position type.
 */
describe("analyzeSiteSymmetry", () => {
  const structure = exampleStructure(); // Mn₃Ga, P6₃/mmc (point group 6/mmm, order 24)

  it("Mn₃Ga: Mn on 6h, Ga on 2d — multiplicities, site symmetry, and DOF", () => {
    const sites = analyzeSiteSymmetry(structure);
    const crystalOrder = classifyPointGroup(structure.spaceGroup.operations).order; // 24
    expect(crystalOrder).toBe(24);

    const mn = sites.find((s) => s.label === "Mn1")!;
    const ga = sites.find((s) => s.label === "Ga1")!;

    // Orbit–stabilizer holds for every site.
    for (const s of sites) expect(s.multiplicity * s.siteSymmetryOrder).toBe(crystalOrder);

    // Mn on 6h (x, 2x, ¼): multiplicity 6, one free coordinate (y = 2x tied, z fixed).
    expect(mn.multiplicity).toBe(6);
    expect(mn.siteSymmetryOrder).toBe(4);
    expect(mn.special).toBe(true);
    expect(mn.freePositionParams).toBe(1);

    // Ga on 2d (⅓, ⅔, ¾): multiplicity 2, fully fixed position, site symmetry -6m2.
    expect(ga.multiplicity).toBe(2);
    expect(ga.siteSymmetryOrder).toBe(12);
    expect(ga.siteSymmetry).toBe("-6m2");
    expect(ga.special).toBe(true);
    expect(ga.freePositionParams).toBe(0);
    // Every site-symmetry symbol is a recognized crystallographic point group.
    for (const s of sites) expect(s.siteSymmetry).not.toBeNull();
  });

  it("a general position has full DOF and trivial site symmetry", () => {
    const general: StructureModel = {
      ...structure,
      sites: [{ ...structure.sites[0]!, label: "G1", position: [0.11, 0.23, 0.37] }],
    };
    const [s] = analyzeSiteSymmetry(general);
    expect(s!.siteSymmetry).toBe("1");
    expect(s!.siteSymmetryOrder).toBe(1);
    expect(s!.special).toBe(false);
    expect(s!.multiplicity).toBe(24); // general multiplicity = |point group|
    expect(s!.freePositionParams).toBe(3);
    expect(s!.freeAdpModes).toBe(6);
    expect(s!.allowedMomentComponents).toBe(3);
  });

  it("a cubic special position (origin of F m -3 m) is highly constrained", () => {
    const fm3m = buildSpaceGroup("F m -3 m");
    const cubic: StructureModel = {
      ...structure,
      cell: { a: 4.2, b: 4.2, c: 4.2, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: fm3m,
      sites: [{ ...structure.sites[0]!, label: "M1", position: [0, 0, 0] }],
    };
    const [s] = analyzeSiteSymmetry(cubic);
    expect(s!.siteSymmetry).toBe("m-3m"); // full cubic site symmetry at the origin
    expect(s!.special).toBe(true);
    expect(s!.freePositionParams).toBe(0);   // origin is fixed
    expect(s!.allowedMomentComponents).toBe(0); // no moment allowed at m-3m
  });
});
