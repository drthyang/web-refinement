import { describe, it, expect } from "vitest";
import {
  POINT_GROUP_GENERATORS, pointGroupFromGenerators, pointGroupSignature, classifyPointGroup, operationType,
} from "@/core/crystal/pointGroup";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

/**
 * The point-group table is only trustworthy if every generator set closes to the
 * right group. These tests are the derivation's guardrail: correct orders, unique
 * signatures (so the classification is well-defined), and round-trip naming.
 */
describe("crystallographic point groups", () => {
  it("has all 32 groups, each closing to its known order", () => {
    expect(POINT_GROUP_GENERATORS.length).toBe(32);
    for (const pg of POINT_GROUP_GENERATORS) {
      const ops = pointGroupFromGenerators(pg.generators);
      expect(ops.length, pg.symbol).toBe(pg.order);
    }
  });

  it("gives every point group a DISTINCT element-type signature (well-defined classification)", () => {
    const sigs = new Map<string, string>();
    for (const pg of POINT_GROUP_GENERATORS) {
      const sig = pointGroupSignature(pointGroupFromGenerators(pg.generators));
      expect(sigs.has(sig), `${pg.symbol} collides with ${sigs.get(sig)}`).toBe(false);
      sigs.set(sig, pg.symbol);
    }
    expect(sigs.size).toBe(32);
  });

  it("classifies each generated group back to its own symbol (round-trip)", () => {
    for (const pg of POINT_GROUP_GENERATORS) {
      const result = classifyPointGroup(pointGroupFromGenerators(pg.generators));
      expect(result.symbol, pg.symbol).toBe(pg.symbol);
      expect(result.order).toBe(pg.order);
    }
  });

  it("operationType reads det/trace correctly for the canonical elements", () => {
    expect(operationType(parseSymmetryOperation("x,y,z"))).toBe(1); // identity
    expect(operationType(parseSymmetryOperation("-x,-y,z"))).toBe(2); // 2-fold
    expect(operationType(parseSymmetryOperation("-y,x,z"))).toBe(4); // 4-fold
    expect(operationType(parseSymmetryOperation("-y,x-y,z"))).toBe(3); // 3-fold (hex)
    expect(operationType(parseSymmetryOperation("x-y,x,z"))).toBe(6); // 6-fold (hex)
    expect(operationType(parseSymmetryOperation("-x,-y,-z"))).toBe(-1); // inversion
    expect(operationType(parseSymmetryOperation("x,y,-z"))).toBe(-2); // mirror
    expect(operationType(parseSymmetryOperation("y,-x,-z"))).toBe(-4); // -4
  });

  it("classifies the point group of the built-in space groups (crystal class)", () => {
    // A whole space group's operation list → its crystal class (mod translation).
    expect(classifyPointGroup(buildSpaceGroup("P -1").operations).symbol).toBe("-1");
    expect(classifyPointGroup(buildSpaceGroup("P 1 21/c 1").operations).symbol).toBe("2/m");
    expect(classifyPointGroup(buildSpaceGroup("F -4 3 m").operations).symbol).toBe("-43m");
    expect(classifyPointGroup(buildSpaceGroup("F m -3 m").operations).symbol).toBe("m-3m");
    expect(classifyPointGroup(buildSpaceGroup("I 21 3").operations).symbol).toBe("23");
  });

  it("returns a null symbol (but a valid order/signature) for a non-closed op list", () => {
    // Identity + one 3-fold: NOT closed (point group 3 needs E + two 3-folds),
    // so its signature {1:1, 3:1} matches no crystallographic point group.
    const partial = classifyPointGroup(["x,y,z", "-y,x-y,z"].map(parseSymmetryOperation));
    expect(partial.symbol).toBeNull();
    expect(partial.order).toBe(2);
    expect(partial.signature).toContain("3:1");
    // Whereas the closed 3-fold group IS recognized.
    expect(classifyPointGroup(["x,y,z", "-y,x-y,z", "-x+y,-x,z"].map(parseSymmetryOperation)).symbol).toBe("3");
  });
});
