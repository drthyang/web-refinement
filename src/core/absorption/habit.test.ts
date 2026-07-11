import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { dot } from "@/core/math/vec3";
import { linearAbsorptionCoefficient } from "@/core/scattering/neutronAbsorption";
import { crystalHabit, faceNormalCartesian, type CrystalFace } from "@/core/absorption/habit";
import { transmissionFactor } from "@/core/absorption/transmission";
import { boxShape } from "@/core/absorption/shape";

const cubic = (a: number): UnitCell => ({ a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });

/** The six {100} faces of a cube, each `d` from the centre. */
function cubeFaces(d: number): CrystalFace[] {
  return [
    { hkl: [1, 0, 0], distance: d },
    { hkl: [-1, 0, 0], distance: d },
    { hkl: [0, 1, 0], distance: d },
    { hkl: [0, -1, 0], distance: d },
    { hkl: [0, 0, 1], distance: d },
    { hkl: [0, 0, -1], distance: d },
  ];
}

describe("faceNormalCartesian", () => {
  it("points along the reciprocal direction for an orthogonal cell", () => {
    const cell = { a: 2, b: 3, c: 4, alpha: 90, beta: 90, gamma: 90 };
    const expectVec = (got: readonly number[], want: readonly number[]) =>
      want.forEach((w, i) => expect(got[i]!).toBeCloseTo(w, 12));
    expectVec(faceNormalCartesian(cell, [1, 0, 0]), [1, 0, 0]);
    expectVec(faceNormalCartesian(cell, [0, 0, 1]), [0, 0, 1]);
    const n111 = faceNormalCartesian(cubic(5), [1, 1, 1]);
    const s = 1 / Math.sqrt(3);
    expect(n111[0]).toBeCloseTo(s, 12);
    expect(n111[1]).toBeCloseTo(s, 12);
    expect(n111[2]).toBeCloseTo(s, 12);
  });

  it("handles a non-orthogonal (hexagonal) cell: (100)∧(010) reciprocal angle is 60°", () => {
    const hex: UnitCell = { a: 3, b: 3, c: 5, alpha: 90, beta: 90, gamma: 120 };
    const cos = dot(faceNormalCartesian(hex, [1, 0, 0]), faceNormalCartesian(hex, [0, 1, 0]));
    expect(cos).toBeCloseTo(0.5, 10); // γ* = 60° ⇒ cos = 0.5
  });
});

describe("crystalHabit", () => {
  it("builds a cube from {100} faces (bounding box and geometry)", () => {
    const shape = crystalHabit(cubic(4), cubeFaces(0.3));
    expect(shape.min).toEqual([-0.3, -0.3, -0.3]);
    expect(shape.max).toEqual([0.3, 0.3, 0.3]);
    // Transmission must match the equivalent boxShape (edge = 2·distance).
    const a = crystalHabit(cubic(4), cubeFaces(0.25));
    const b = boxShape([0.5, 0.5, 0.5]);
    const beam: [number, number, number] = [1, 0, 0];
    const out: [number, number, number] = [0, 1, 0];
    expect(transmissionFactor(a, 2, beam, out)).toBeCloseTo(transmissionFactor(b, 2, beam, out), 10);
  });

  it("rejects too-few or non-enclosing faces", () => {
    expect(() => crystalHabit(cubic(4), cubeFaces(0.3).slice(0, 3))).toThrow(/at least 4 faces/);
    // Four faces all facing +x cannot enclose a volume.
    const open: CrystalFace[] = [
      { hkl: [1, 0, 0], distance: 0.3 },
      { hkl: [2, 1, 0], distance: 0.3 },
      { hkl: [2, -1, 0], distance: 0.3 },
      { hkl: [2, 0, 1], distance: 0.3 },
    ];
    expect(() => crystalHabit(cubic(4), open)).toThrow(/unbounded or degenerate/);
  });
});

describe("end to end: μ → habit → transmission", () => {
  const identity = parseSymmetryOperation("x,y,z");
  const iso = { kind: "isotropic", bIso: 0.4 } as const;
  const site = (label: string, element: string, position: [number, number, number]): AtomSite => ({
    label,
    element,
    position,
    occupancy: 1,
    adp: iso,
  });
  // bcc Fe, an absorbing structure.
  const feBcc: StructureModel = {
    id: "fe",
    name: "Fe",
    cell: cubic(2.87),
    spaceGroup: { hermannMauguin: "P 1", operations: [identity] },
    sites: [site("Fe1", "Fe", [0, 0, 0]), site("Fe2", "Fe", [0.5, 0.5, 0.5])],
  };

  it("composes the three layers into a physical transmission factor", () => {
    const muPerCm = linearAbsorptionCoefficient(feBcc, 1.5);
    const muPerMm = muPerCm / 10; // shape distances are in mm
    expect(muPerMm).toBeGreaterThan(0);

    const small = crystalHabit(feBcc.cell, cubeFaces(0.15)); // 0.3 mm cube
    const large = crystalHabit(feBcc.cell, cubeFaces(0.5)); // 1.0 mm cube
    const A_small = transmissionFactor(small, muPerMm, [1, 0, 0], [0, 1, 0]);
    const A_large = transmissionFactor(large, muPerMm, [1, 0, 0], [0, 1, 0]);

    expect(A_small).toBeGreaterThan(0);
    expect(A_small).toBeLessThan(1);
    expect(A_large).toBeLessThan(A_small); // a bigger crystal absorbs more
  });
});
