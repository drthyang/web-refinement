import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";

const ops = (...xyz: string[]) => xyz.map(parseSymmetryOperation);

describe("allowedPositionShifts", () => {
  it("gives three free modes for a general position (only identity fixes it)", () => {
    const g = allowedPositionShifts(ops("x,y,z", "z,x,y", "-x,-y,-z"), [0.1, 0.2, 0.3]);
    expect(g.dimension).toBe(3);
  });

  it("couples (x,x,x) into a single [1,1,1] mode under a 3-fold along [111]", () => {
    // The 3-fold cycles the axes and fixes the body diagonal.
    const g = allowedPositionShifts(ops("x,y,z", "z,x,y", "y,z,x"), [0.2, 0.2, 0.2]);
    expect(g.dimension).toBe(1);
    const [ax] = g.basis;
    expect(ax![0]).toBeCloseTo(1, 6);
    expect(ax![1]).toBeCloseTo(1, 6);
    expect(ax![2]).toBeCloseTo(1, 6);
  });

  it("frees only x for a site on a 2-fold axis along x", () => {
    const g = allowedPositionShifts(ops("x,y,z", "x,-y,-z"), [0.3, 0, 0]);
    expect(g.dimension).toBe(1);
    expect(g.basis[0]).toEqual([1, 0, 0]);
  });

  it("frees the [1,1,1] mode for a general (x,x,x) site with x > 0.5", () => {
    // Regression: the periodic-distance check must wrap shifts of >1 cell, else
    // a coordinate > 0.5 spuriously counts extra stabilizer ops and over-fixes
    // the site (e.g. Se at 16e (0.8845,0.8845,0.8845) in F-4̄3m).
    const g = allowedPositionShifts(ops("x,y,z", "z,x,y", "y,z,x", "-x,-y,z", "y,x,z"), [0.8845, 0.8845, 0.8845]);
    expect(g.dimension).toBe(1);
    expect(g.basis[0]![0]).toBeCloseTo(1, 6);
    expect(g.basis[0]![1]).toBeCloseTo(1, 6);
    expect(g.basis[0]![2]).toBeCloseTo(1, 6);
  });

  it("fully fixes the origin under inversion", () => {
    const g = allowedPositionShifts(ops("x,y,z", "-x,-y,-z"), [0, 0, 0]);
    expect(g.dimension).toBe(0);
    expect(g.basis).toEqual([]);
  });
});
