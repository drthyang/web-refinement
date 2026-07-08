import { describe, it, expect } from "vitest";
import { buildCellAtoms, magneticSupercell } from "@/app/ui/cellModel";
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

describe("magneticSupercell", () => {
  it("is the denominator of each k component", () => {
    expect(magneticSupercell([0, 0, 0])).toEqual([1, 1, 1]);
    expect(magneticSupercell([0, 0, 0.5])).toEqual([1, 1, 2]);
    expect(magneticSupercell([1 / 3, 0, 0])).toEqual([3, 1, 1]);
    expect(magneticSupercell([0.25, 0.5, 0])).toEqual([4, 2, 1]);
  });
});

describe("buildCellAtoms — supercell tiling", () => {
  it("tiles the cell N times, tagging each copy with its cell index", () => {
    const atoms = buildCellAtoms(
      cubicP1([{ label: "A1", element: "Fe", position: [0.25, 0.5, 0.75], occupancy: 1, adp: iso }]),
      [1, 1, 2],
    );
    expect(atoms).toHaveLength(2); // two cells stacked along c
    const zs = atoms.map((a) => a.xyz[2]).sort((x, y) => x - y);
    expect(zs[0]).toBeCloseTo(0.75 * 5, 6); // cell 0
    expect(zs[1]).toBeCloseTo(0.75 * 5 + 5, 6); // cell 1 (+c)
    expect(atoms.map((a) => a.cellIndex[2]).sort()).toEqual([0, 1]);
  });
});

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
