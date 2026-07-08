import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import {
  axialCharacter,
  magneticRepresentationCharacter,
  irrepMultiplicity,
  magneticRepresentationDimension,
} from "@/core/magnetic/magneticRepresentation";

const E = parseSymmetryOperation("x,y,z");
const twoZ = parseSymmetryOperation("-x,-y,z");
const inv = parseSymmetryOperation("-x,-y,-z");
const iso = { kind: "isotropic", bIso: 0.3 } as const;

/** One magnetic atom at the origin with the given little group. */
function atOrigin(ops: SymmetryOperation[]): StructureModel {
  return {
    id: "t", name: "t",
    cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: ops },
    sites: [{ label: "M", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
  };
}
const re = (t: { re: number }[]) => t.map((x) => Math.round(x.re));
const c1 = (v: number) => [{ re: v, im: 0 }];
const c2 = (a: number, b: number) => [{ re: a, im: 0 }, { re: b, im: 0 }];

describe("axialCharacter χ_axial(R) = det(R)·tr(R)", () => {
  it("is +3 for E, −1 for a 2-fold, −1 for a mirror, +3 for inversion", () => {
    expect(axialCharacter(E.rotation)).toBe(3);
    expect(axialCharacter(twoZ.rotation)).toBe(-1);
    expect(axialCharacter(parseSymmetryOperation("x,y,-z").rotation)).toBe(-1); // mirror ⊥ z
    expect(axialCharacter(inv.rotation)).toBe(3);
  });
});

describe("magnetic representation character + irrep decomposition", () => {
  it("P1, one atom, k=0 → 3× the trivial irrep (3 magnetic DOF)", () => {
    const chars = magneticRepresentationCharacter(atOrigin([E]), [0, 0, 0], ["M"], [E]);
    expect(re(chars)).toEqual([3]);
    expect(irrepMultiplicity(chars, c1(1))).toBeCloseTo(3, 6);
  });

  it("C2 (2-fold ∥ z), one atom → A + 2B (Mz = A, Mx,My = B)", () => {
    const chars = magneticRepresentationCharacter(atOrigin([E, twoZ]), [0, 0, 0], ["M"], [E, twoZ]);
    expect(re(chars)).toEqual([3, -1]);
    expect(irrepMultiplicity(chars, c2(1, 1))).toBeCloseTo(1, 6); // A: (E,2)=(1,1)
    expect(irrepMultiplicity(chars, c2(1, -1))).toBeCloseTo(2, 6); // B: (E,2)=(1,-1)
  });

  it("inversion centre → 3 Ag, 0 Au (a moment is even under inversion)", () => {
    const chars = magneticRepresentationCharacter(atOrigin([E, inv]), [0, 0, 0], ["M"], [E, inv]);
    expect(re(chars)).toEqual([3, 3]);
    expect(irrepMultiplicity(chars, c2(1, 1))).toBeCloseTo(3, 6); // Ag: (E,−1)=(1,1)
    expect(irrepMultiplicity(chars, c2(1, -1))).toBeCloseTo(0, 6); // Au: (E,−1)=(1,−1)
  });

  it("total representation dimension is 3N", () => {
    expect(magneticRepresentationDimension(atOrigin([E]), ["M"])).toBe(3);
    // 2-fold at origin keeps one atom → still 3.
    expect(magneticRepresentationDimension(atOrigin([E, twoZ]), ["M"])).toBe(3);
  });
});
