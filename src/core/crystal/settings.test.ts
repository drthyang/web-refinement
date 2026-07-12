import { describe, it, expect } from "vitest";
import {
  cellFromMetric, transformCell, transformPosition, transformOperation,
  transformSpaceGroup, transformStructure, RHOMB_TO_HEX, HEX_TO_RHOMB,
} from "@/core/crystal/settings";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { metricTensor } from "@/core/crystal/unitCell";
import { composeOperations, operationKey, siteMultiplicity, parseSymmetryOperation } from "@/core/crystal/symmetry";
import { determinant, inverse } from "@/core/math/mat3";
import { analyzeSiteSymmetry } from "@/core/crystal/siteSymmetry";
import { exampleStructure } from "@/examples/mn3ga";
import type { Mat3, Vec3 } from "@/core/math/types";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";

const keySet = (sg: SpaceGroup) => new Set(sg.operations.map(operationKey));
function isClosed(sg: SpaceGroup): boolean {
  const keys = keySet(sg);
  for (const a of sg.operations) for (const b of sg.operations) {
    if (!keys.has(operationKey(composeOperations(a, b)))) return false;
  }
  return true;
}
const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// A non-trivial unimodular basis change (b, c, a cyclic permutation + shear) —
// enough to exercise the transform without changing the lattice.
const P: Mat3 = [[1, 1, 0], [0, 1, 0], [0, 0, 1]];

describe("setting / origin transforms (F2.4)", () => {
  const triclinic: UnitCell = { a: 5.1, b: 6.2, c: 7.3, alpha: 82, beta: 97, gamma: 103 };

  it("cellFromMetric inverts metricTensor", () => {
    const back = cellFromMetric(metricTensor(triclinic));
    for (const k of ["a", "b", "c", "alpha", "beta", "gamma"] as const) {
      expect(back[k]).toBeCloseTo(triclinic[k], 8);
    }
  });

  it("transformCell by the identity is a no-op", () => {
    const c = transformCell(triclinic, IDENTITY);
    expect(c.a).toBeCloseTo(triclinic.a, 8);
    expect(c.gamma).toBeCloseTo(triclinic.gamma, 8);
  });

  it("rhombohedral ⇄ hexagonal cell conversion round-trips, and the hex cell is 3× the volume", () => {
    expect(determinant(RHOMB_TO_HEX)).toBeCloseTo(3, 8); // hexagonal R cell = 3 × primitive
    const rhomb: UnitCell = { a: 5, b: 5, c: 5, alpha: 60, beta: 60, gamma: 60 };
    const hex = transformCell(rhomb, RHOMB_TO_HEX);
    expect(hex.a).toBeCloseTo(hex.b, 6);
    expect(hex.gamma).toBeCloseTo(120, 4);
    expect(hex.alpha).toBeCloseTo(90, 4);
    const back = transformCell(hex, HEX_TO_RHOMB);
    expect(back.a).toBeCloseTo(rhomb.a, 6);
    expect(back.alpha).toBeCloseTo(rhomb.alpha, 4);
  });

  it("transformPosition round-trips through P and P⁻¹", () => {
    const x: Vec3 = [0.137, 0.241, 0.311];
    const y = transformPosition(x, P);
    const back = transformPosition(y, inverse(P));
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(x[i]!, 8);
  });

  it("the identity operation is invariant; a general op round-trips", () => {
    const e = transformOperation(parseSymmetryOperation("x,y,z"), P);
    expect(operationKey(e)).toBe(operationKey(parseSymmetryOperation("x,y,z")));
    const op = parseSymmetryOperation("-x,y+1/2,-z+1/2");
    const there = transformOperation(op, P);
    const back = transformOperation(there, inverse(P));
    expect(operationKey(back)).toBe(operationKey(op));
  });

  it("transforming a space group preserves order and closure, and round-trips", () => {
    for (const id of [14, 216, 225]) {
      const sg = buildSpaceGroup(id);
      const t = transformSpaceGroup(sg, P);
      expect(t.operations.length).toBe(sg.operations.length);
      expect(isClosed(t)).toBe(true);
      const back = transformSpaceGroup(t, inverse(P));
      expect(keySet(back)).toEqual(keySet(sg));
    }
  });

  it("an origin shift is undone by the opposite shift", () => {
    const sg = buildSpaceGroup(14);
    const shift: Vec3 = [0.25, 0, 0.25];
    const shifted = transformSpaceGroup(sg, IDENTITY, shift);
    const back = transformSpaceGroup(shifted, IDENTITY, [-0.25, 0, -0.25]);
    expect(keySet(back)).toEqual(keySet(sg));
  });

  it("site symmetry is invariant under a setting change (multiplicities preserved)", () => {
    const s = exampleStructure(); // Mn₃Ga, P6₃/mmc
    const t = transformStructure(s, P);
    // Same op count, and each atom keeps its multiplicity in the new frame.
    expect(t.spaceGroup.operations.length).toBe(s.spaceGroup.operations.length);
    for (let i = 0; i < s.sites.length; i++) {
      expect(siteMultiplicity(t.spaceGroup.operations, t.sites[i]!.position))
        .toBe(siteMultiplicity(s.spaceGroup.operations, s.sites[i]!.position));
    }
    // The site-symmetry point groups are unchanged (an invariant of the setting).
    const before = analyzeSiteSymmetry(s).map((x) => x.siteSymmetry).sort();
    const after = analyzeSiteSymmetry(t).map((x) => x.siteSymmetry).sort();
    expect(after).toEqual(before);
  });
});
