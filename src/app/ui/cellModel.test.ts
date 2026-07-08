import { describe, it, expect } from "vitest";
import { buildCellAtoms } from "@/app/ui/cellModel";
import type { StructureModel } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

const P1: StructureModel["spaceGroup"] = {
  hermannMauguin: "P 1",
  operations: [parseSymmetryOperation("x,y,z")],
};

function cubicP1(sites: StructureModel["sites"]): StructureModel {
  return {
    id: "t",
    name: "t",
    cell: { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: P1,
    sites,
  };
}

const iso = { kind: "isotropic", bIso: 0.5 } as const;

describe("buildCellAtoms", () => {
  it("places a general-position atom once, in Cartesian Å", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "A1", element: "Fe", position: [0.25, 0.5, 0.75], occupancy: 1, adp: iso },
    ]));
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.element).toBe("Fe");
    // orthogonal 5 Å cell → x = frac·5 (tolerant: cos(90°) is ~6e-17, not 0)
    const [x, y, z] = atoms[0]!.xyz;
    expect(x).toBeCloseTo(1.25, 9);
    expect(y).toBeCloseTo(2.5, 9);
    expect(z).toBeCloseTo(3.75, 9);
  });

  it("duplicates a corner atom onto all 8 cell corners", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "O1", element: "O", position: [0, 0, 0], occupancy: 1, adp: iso },
    ]));
    expect(atoms).toHaveLength(8); // 2^3 boundary images at the origin
    for (const a of atoms) {
      for (const c of a.xyz) expect(Math.min(Math.abs(c), Math.abs(c - 5))).toBeLessThan(1e-6);
    }
  });

  it("expands by symmetry operations (P-1 inversion doubles a general site)", () => {
    const structure: StructureModel = {
      ...cubicP1([{ label: "A1", element: "Mn", position: [0.2, 0.3, 0.4], occupancy: 1, adp: iso }]),
      spaceGroup: {
        hermannMauguin: "P -1",
        operations: [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,-z")],
      },
    };
    // x,y,z and its inversion (wrapped into the cell) — two distinct interior atoms.
    expect(buildCellAtoms(structure)).toHaveLength(2);
  });
});
