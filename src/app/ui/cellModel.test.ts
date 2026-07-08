import { describe, it, expect } from "vitest";
import { buildCellAtoms, displayMoment, magneticSupercell } from "@/app/ui/cellModel";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseMagneticSymmetryOperation, parseSymmetryOperation } from "@/core/crystal/symmetry";

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

/** The arrows must match the structure factor: m′ = θ·det(R)·R·m with the k-phase. */
describe("displayMoment — θ-signed arrows", () => {
  const close = (a: Vec3, b: Vec3): void => {
    expect(a[0]).toBeCloseTo(b[0]!, 6);
    expect(a[1]).toBeCloseTo(b[1]!, 6);
    expect(a[2]).toBeCloseTo(b[2]!, 6);
  };
  const mn3ga = (ops: StructureModel["spaceGroup"]["operations"]): StructureModel => ({
    id: "t", name: "t",
    cell: { a: 5.42, b: 4.34, c: 5.32, alpha: 90, beta: 60.7, gamma: 90 },
    spaceGroup: { operations: ops },
    sites: [{ label: "Mn1", element: "Mn", oxidationState: 2, position: [0.343, 0.25, 0.833], occupancy: 1, adp: iso }],
  });
  // Mn₃Ga P2₁'/m': 2₁ and m primed, inversion not. A 2e site (y = ¼) with an
  // ac-plane moment: the orbit partner carries the SAME moment.
  const nuclear = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);
  const magnetic = ["x,y,z,+1", "-x,1/2+y,-z,-1", "-x,-y,-z,+1", "x,1/2-y,z,-1"].map(parseMagneticSymmetryOperation);
  const m: Vec3 = [-1.577, 0, -1.349];

  it("P2₁'/m' 2e pair is ferromagnetically aligned (the type-III θ regression)", () => {
    const atoms = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], magnetic);
    expect(atoms).toHaveLength(2);
    for (const at of atoms) close(displayMoment(at, m)!, m);
  });

  it("the arrow does not depend on which magnetic op reaches the atom", () => {
    // The partner is reached both by 2₁′ (θ=−1) and by unprimed inversion; a
    // symmetry-allowed moment gives the same arrow either way. Reversing the op
    // list changes which op is found first — the arrangement must not change.
    const a1 = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], magnetic);
    const a2 = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], [...magnetic].reverse());
    for (const at1 of a1) {
      const at2 = a2.find((a) => Math.hypot(a.xyz[0] - at1.xyz[0], a.xyz[1] - at1.xyz[1], a.xyz[2] - at1.xyz[2]) < 1e-6)!;
      close(displayMoment(at1, m)!, displayMoment(at2, m)!);
    }
  });

  it("type-III primed 2-fold flips the partner arrow (AFM); unprimed keeps it (FM)", () => {
    const nuc = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,z")];
    const s = { ...cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]), spaceGroup: { operations: nuc } };
    const mz: Vec3 = [0, 0, 2];
    const partnerArrow = (ops: SymmetryOperation[]): Vec3 => {
      const atoms = buildCellAtoms(s, [1, 1, 1], ops);
      expect(atoms).toHaveLength(2);
      const partner = atoms.find((a) => a.mag!.rot[0]![0]! === -1)!; // placed by the 2-fold
      return displayMoment(partner, mz)!;
    };
    close(partnerArrow(["x,y,z,+1", "-x,-y,z,+1"].map(parseMagneticSymmetryOperation)), [0, 0, 2]);
    close(partnerArrow(["x,y,z,+1", "-x,-y,z,-1"].map(parseMagneticSymmetryOperation)), [0, 0, -2]);
  });

  it("nuclear-orbit atoms unreachable by the magnetic ops carry no arrow", () => {
    const nuc = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,z")];
    const s = { ...cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]), spaceGroup: { operations: nuc } };
    const atoms = buildCellAtoms(s, [1, 1, 1], [parseMagneticSymmetryOperation("x,y,z,+1")]);
    expect(atoms).toHaveLength(2);
    expect(atoms.filter((a) => displayMoment(a, [0, 0, 1]) !== null)).toHaveLength(1);
  });
});

describe("displayMoment — commensurate k-phase", () => {
  it("k = (0,0,½): the copy in the next cell along c is reversed", () => {
    const s = cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]);
    const atoms = buildCellAtoms(s, [1, 1, 2]);
    expect(atoms).toHaveLength(2);
    const arrow = (n: number): Vec3 => displayMoment(atoms.find((a) => a.cellIndex[2] === n)!, [0, 0, 1.5], [0, 0, 0.5])!;
    expect(arrow(0)[2]).toBeCloseTo(1.5, 6);
    expect(arrow(1)[2]).toBeCloseTo(-1.5, 6);
  });

  it("k = (0,0,½): a z≈0 boundary duplicate drawn at z=1 belongs to the next cell", () => {
    const s = cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0], occupancy: 1, adp: iso }]);
    const atoms = buildCellAtoms(s); // z = 0 atom + its z = 1 face duplicate
    expect(atoms).toHaveLength(2);
    const xs = atoms.map((a) => displayMoment(a, [1, 0, 0], [0, 0, 0.5])![0]).sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-1, 6);
    expect(xs[1]).toBeCloseTo(1, 6);
  });
});
