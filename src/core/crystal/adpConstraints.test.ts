import { describe, expect, it } from "vitest";
import { allowedAnisotropicAdpModes } from "@/core/crystal/adpConstraints";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

const ops = (...xyz: string[]) => xyz.map(parseSymmetryOperation);

describe("allowedAnisotropicAdpModes", () => {
  it("allows six independent tensor components for a general position", () => {
    const allowed = allowedAnisotropicAdpModes(
      ops("x,y,z", "z,x,y", "-x,-y,-z"),
      [0.1, 0.2, 0.3],
      [0.01, 0.02, 0.03, 0.001, 0.002, 0.003],
    );
    expect(allowed.dimension).toBe(6);
  });

  it("couples U11/U22/U33 and U12/U13/U23 on a threefold (x,x,x) site", () => {
    const allowed = allowedAnisotropicAdpModes(
      ops("x,y,z", "z,x,y", "y,z,x"),
      [0.2, 0.2, 0.2],
      [0.004, 0.004, 0.004, 0.0005, 0.0005, 0.0005],
    );
    expect(allowed.dimension).toBe(2);
    const bases = allowed.modes.map((m) => m.basis);
    expect(bases.some((b) => b[0] === 1 && b[1] === 1 && b[2] === 1)).toBe(true);
    expect(bases.some((b) => b[3] === 1 && b[4] === 1 && b[5] === 1)).toBe(true);
    expect(allowed.modes.map((m) => m.coefficient).sort((a, b) => a - b))
      .toEqual([0.0005, 0.004]);
  });

  it("reduces an origin inversion center to a symmetric tensor", () => {
    const allowed = allowedAnisotropicAdpModes(
      ops("x,y,z", "-x,-y,-z"),
      [0, 0, 0],
      [0.01, 0.02, 0.03, 0.001, 0.002, 0.003],
    );
    // U is a second-rank polar tensor, so inversion imposes no extra constraint.
    expect(allowed.dimension).toBe(6);
  });
});
