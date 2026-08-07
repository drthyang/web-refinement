/**
 * Moment-SIZE consistency between the two shipped descriptions of one physical
 * structure: the parent cell + propagation vector k = (0,0,1/2), and the
 * explicit 1x1x2 commensurate supercell with antiparallel moments written out.
 *
 * The invariant: |F_M|^2 at matched indices (parent (h,k,l+1/2) <-> supercell
 * (h,k,2l+1)) must agree up to ONE constant across every reflection. The
 * constant is N^2 (coherent addition over N = 2 cells) and is absorbed by the
 * histogram scale; a VARYING ratio would mean the two descriptions disagree
 * about the physical moment, i.e. a refined moment would depend on which
 * description the user happened to load. This is the concern behind the
 * long-standing momentModel.ts caveat about a "convention-dependent factor" —
 * pinned here so it can never regress silently.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";

const iso = { kind: "isotropic", bIso: 0 } as const;
const ident = parseSymmetryOperation("x,y,z");
const M: Vec3 = [2.5, 0, 0];           // the SAME physical moment in both descriptions
const c = 6;

// (A) PARENT cell + propagation vector k = (0,0,1/2): one magnetic atom, whose
//     moment alternates from cell to cell by virtue of k.
const parent: StructureModel = {
  id: "p", name: "p",
  cell: { a: 4, b: 4, c, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [ident] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const parentMag: MagneticModel = {
  id: "p-mag", structureId: "p", propagation: [[0, 0, 0.5]],
  moments: [{ siteLabel: "Fe1", frame: "crystallographic", components: M, formFactorId: "Fe3" }],
  operations: [ident],
};

// (B) The equivalent COMMENSURATE SUPERCELL (c' = 2c), written out explicitly as
//     an ordinary k = 0 structure with two antiparallel atoms.
const superC: StructureModel = {
  id: "s", name: "s",
  cell: { a: 4, b: 4, c: 2 * c, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [ident] },
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso },
    { label: "Fe2", element: "Fe", oxidationState: 3, position: [0, 0, 0.5], occupancy: 1, adp: iso },
  ],
};
const superMag: MagneticModel = {
  id: "s-mag", structureId: "s", propagation: [[0, 0, 0]],
  moments: [
    { siteLabel: "Fe1", frame: "crystallographic", components: M, formFactorId: "Fe3" },
    { siteLabel: "Fe2", frame: "crystallographic", components: [-M[0], -M[1], -M[2]], formFactorId: "Fe3" },
  ],
  operations: [ident],
};

/** Parent satellite (h,k,l±1/2) ↔ supercell (h,k,2l±1). */
const PAIRS: [Vec3, Vec3][] = [
  [[0, 0, 0.5], [0, 0, 1]],
  [[0, 0, 1.5], [0, 0, 3]],
  [[0, 0, 2.5], [0, 0, 5]],
  [[1, 0, 0.5], [1, 0, 1]],
  [[1, 1, 0.5], [1, 1, 1]],
  [[2, 1, 1.5], [2, 1, 3]],
  [[0, 2, 2.5], [0, 2, 5]],
];

describe("moment-size consistency: propagation-vector vs commensurate supercell", () => {
  it("the two shipped descriptions of ONE structure agree up to a constant", () => {
    console.log("parent satellite     supercell        |F|²_parent      |F|²_super     ratio");
    const ratios: number[] = [];
    for (const [pi, si] of PAIRS) {
      const fp = magneticStructureFactor(parent, parentMag, pi[0], pi[1], pi[2]).squared;
      const fs = magneticStructureFactor(superC, superMag, si[0], si[1], si[2]).squared;
      ratios.push(fs / fp);
      console.log(
        `(${pi.join(",").padEnd(11)})   (${si.join(",").padEnd(7)})  ${fp.toExponential(5).padStart(13)}  ${fs.toExponential(5).padStart(13)}  ${(fs / fp).toFixed(6)}`,
      );
    }
    // A CONSTANT ratio means both descriptions encode the same physical moment:
    // the factor is pure normalization (absorbed by the scale factor), not a
    // moment-size disagreement. A varying ratio would mean the two disagree.
    const first = ratios[0]!;
    for (const r of ratios) expect(r).toBeCloseTo(first, 9);
    console.log(`constant ratio = ${first.toFixed(6)}  (N² for N = 2 cells)`);
  });
});
