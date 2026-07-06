import { describe, expect, it } from "vitest";
import type { StructureModel, UnitCell } from "@/core/crystal/types";
import { crystalSystem, independentCellParameters } from "@/core/crystal/cellConstraints";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

function structure(cell: UnitCell, number?: number): StructureModel {
  return {
    id: "s", name: "s", cell,
    spaceGroup: { operations: [], ...(number !== undefined ? { number } : {}) },
    sites: [],
  };
}

/** A structure whose constraints must come from the given symmetry xyz ops. */
function fromOps(cell: UnitCell, xyz: string[]): StructureModel {
  return { id: "s", name: "s", cell, spaceGroup: { operations: xyz.map(parseSymmetryOperation) }, sites: [] };
}
const cubic: UnitCell = { a: 10.4, b: 10.4, c: 10.4, alpha: 90, beta: 90, gamma: 90 };
const hex: UnitCell = { a: 5.42, b: 5.42, c: 4.38, alpha: 90, beta: 90, gamma: 120 };
const tet: UnitCell = { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 };
const ortho: UnitCell = { a: 4, b: 5, c: 6, alpha: 90, beta: 90, gamma: 90 };
const mono: UnitCell = { a: 4, b: 5, c: 6, alpha: 90, beta: 104, gamma: 90 };
const tri: UnitCell = { a: 4, b: 5, c: 6, alpha: 85, beta: 95, gamma: 100 };

describe("crystalSystem", () => {
  it("uses the IT number when present", () => {
    expect(crystalSystem({ operations: [], number: 216 }, cubic)).toBe("cubic"); // F-43m
    expect(crystalSystem({ operations: [], number: 194 }, hex)).toBe("hexagonal"); // P6_3/mmc
    expect(crystalSystem({ operations: [], number: 14 }, mono)).toBe("monoclinic"); // P2_1/c
  });
  it("falls back to the cell metric with no number", () => {
    expect(crystalSystem({ operations: [] }, cubic)).toBe("cubic");
    expect(crystalSystem({ operations: [] }, hex)).toBe("hexagonal");
    expect(crystalSystem({ operations: [] }, tet)).toBe("tetragonal");
    expect(crystalSystem({ operations: [] }, ortho)).toBe("orthorhombic");
    expect(crystalSystem({ operations: [] }, mono)).toBe("monoclinic");
    expect(crystalSystem({ operations: [] }, tri)).toBe("triclinic");
  });
});

describe("independentCellParameters", () => {
  it("cubic exposes only a, driving a,b,c", () => {
    const specs = independentCellParameters(structure(cubic, 216));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("cell_a");
    expect(specs[0]!.targets).toEqual(["a", "b", "c"]); // c is NOT independently refinable
  });
  it("hexagonal exposes a and c (a→a,b; c→c)", () => {
    const specs = independentCellParameters(structure(hex, 194));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_c"]);
    expect(specs[0]!.targets).toEqual(["a", "b"]);
    expect(specs[1]!.targets).toEqual(["c"]);
  });
  it("tetragonal exposes a and c", () => {
    expect(independentCellParameters(structure(tet, 123)).map((s) => s.id)).toEqual(["cell_a", "cell_c"]);
  });
  it("orthorhombic exposes a, b, c independently", () => {
    const specs = independentCellParameters(structure(ortho, 62));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_b", "cell_c"]);
    expect(specs.every((s) => s.targets.length === 1)).toBe(true);
  });
  it("monoclinic adds the free β angle", () => {
    const specs = independentCellParameters(structure(mono, 14));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_b", "cell_c", "cell_beta"]);
    expect(specs[3]!.kind).toBe("cellAngle");
    expect(specs[3]!.targets).toEqual(["beta"]);
  });
  it("triclinic exposes all six", () => {
    expect(independentCellParameters(structure(tri, 2))).toHaveLength(6);
  });
});

// The important case: constraints derived from the CIF's symmetry operations,
// with NO IT number and a deliberately general (triclinic-looking) cell metric —
// so only the operations can produce the correct reduction.
describe("independentCellParameters — from symmetry operations", () => {
  const generic: UnitCell = { a: 4.1, b: 5.2, c: 6.3, alpha: 88, beta: 93, gamma: 97 };

  it("cubic ops (3-fold [111] + 2-fold z) reduce to a single 'a'", () => {
    const specs = independentCellParameters(fromOps(generic, ["x,y,z", "z,x,y", "-x,-y,z"]));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.id).toBe("cell_a");
    expect(specs[0]!.targets).toEqual(["a", "b", "c"]);
  });

  it("4-fold along z gives tetragonal (a→a,b ; c free ; angles fixed)", () => {
    const specs = independentCellParameters(fromOps(generic, ["x,y,z", "-y,x,z"]));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_c"]);
    expect(specs[0]!.targets).toEqual(["a", "b"]);
  });

  it("6-fold along z gives hexagonal (a→a,b ; c free ; γ=120 fixed)", () => {
    const specs = independentCellParameters(fromOps(generic, ["x,y,z", "x-y,x,z"]));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_c"]);
    expect(specs.every((s) => s.kind === "cellLength")).toBe(true);
  });

  it("2-fold along b gives monoclinic with a free β only", () => {
    const specs = independentCellParameters(fromOps(generic, ["x,y,z", "-x,y,-z"]));
    expect(specs.map((s) => s.id)).toEqual(["cell_a", "cell_b", "cell_c", "cell_beta"]);
    expect(specs.find((s) => s.id === "cell_beta")!.kind).toBe("cellAngle");
  });

  it("identity-only leaves all six free (nothing to constrain)", () => {
    expect(independentCellParameters(fromOps(generic, ["x,y,z"]))).toHaveLength(6);
  });
});
