import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { abelianIrreps, decomposeMagneticRepresentation, projectIrrepModes } from "@/core/magnetic/irreps";

const E = parseSymmetryOperation("x,y,z");
const twoZ = parseSymmetryOperation("-x,-y,z");
const twoX = parseSymmetryOperation("x,-y,-z");
const twoY = parseSymmetryOperation("-x,y,-z");
const inv = parseSymmetryOperation("-x,-y,-z");
const fourZ = parseSymmetryOperation("-y,x,z"); // 4-fold ∥ z (cyclic C4)
const iso = { kind: "isotropic", bIso: 0.3 } as const;

function atOrigin(ops: SymmetryOperation[], cell = { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 }): StructureModel {
  return {
    id: "t", name: "t", cell,
    spaceGroup: { operations: ops },
    sites: [{ label: "M", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
  };
}
const k0: Vec3 = [0, 0, 0];
/** Total multiplicity across all appearing irreps = the representation dimension. */
const totalMult = (terms: { multiplicity: number }[]): number => terms.reduce((s, t) => s + t.multiplicity, 0);
/** Round a mode vector's components for comparison. */
const rd = (v: Vec3): number[] => v.map((x) => Math.round(Math.abs(x) < 1e-6 ? 0 : x));

describe("abelianIrreps — 1-D irreps of an abelian little group", () => {
  it("trivial group {E} → one irrep", () => {
    const irr = abelianIrreps([E])!;
    expect(irr).toHaveLength(1);
    expect(irr[0]!.characters.map((c) => c.re)).toEqual([1]);
  });

  it("C2 → two irreps A(+) and B(−)", () => {
    const irr = abelianIrreps([E, twoZ])!;
    expect(irr).toHaveLength(2);
    const sigs = irr.map((x) => x.characters.map((c) => Math.round(c.re)));
    expect(sigs).toContainEqual([1, 1]);
    expect(sigs).toContainEqual([1, -1]);
  });

  it("D2 (222) → four real irreps", () => {
    const irr = abelianIrreps([E, twoX, twoY, twoZ])!;
    expect(irr).toHaveLength(4);
    expect(irr.every((x) => x.real)).toBe(true);
  });

  it("C4 → four irreps, two of them complex", () => {
    const irr = abelianIrreps([E, fourZ, twoZ, parseSymmetryOperation("y,-x,z")])!;
    expect(irr).toHaveLength(4);
    expect(irr.filter((x) => !x.real)).toHaveLength(2); // the ±i pair
  });

  it("returns null for a non-abelian group (4-fold and 2-fold ⊥ don't commute)", () => {
    expect(abelianIrreps([E, fourZ, twoX])).toBeNull();
  });
});

describe("decomposeMagneticRepresentation — which irreps carry the order", () => {
  it("P1, one atom, k=0 → 3× the trivial irrep", () => {
    const d = decomposeMagneticRepresentation(atOrigin([E]), k0, ["M"], [E]);
    expect(d.abelian).toBe(true);
    expect(d.dimension).toBe(3);
    expect(d.terms).toHaveLength(1);
    expect(d.terms[0]!.multiplicity).toBe(3);
    expect(d.integerConsistent).toBe(true);
  });

  it("C2 (∥z) → A×1 + B×2", () => {
    const ops = [E, twoZ];
    const d = decomposeMagneticRepresentation(atOrigin(ops), k0, ["M"], ops);
    expect(d.dimension).toBe(3);
    expect(totalMult([...d.terms])).toBe(3);
    const a = d.terms.find((t) => t.irrep.characters.every((c) => c.re > 0))!;
    const b = d.terms.find((t) => t.irrep.characters.some((c) => c.re < 0))!;
    expect(a.multiplicity).toBe(1); // A = Mz
    expect(b.multiplicity).toBe(2); // B = Mx, My
  });

  it("inversion centre → 3 Ag, 0 Au (moment even under inversion)", () => {
    const ops = [E, inv];
    const d = decomposeMagneticRepresentation(atOrigin(ops), k0, ["M"], ops);
    // Only the even (Ag) irrep appears, with multiplicity 3.
    expect(d.terms).toHaveLength(1);
    expect(d.terms[0]!.multiplicity).toBe(3);
    expect(d.terms[0]!.irrep.characters.map((c) => Math.round(c.re))).toEqual([1, 1]);
  });

  it("D2 (222) → the three non-trivial irreps, each once", () => {
    const ops = [E, twoX, twoY, twoZ];
    const d = decomposeMagneticRepresentation(atOrigin(ops), k0, ["M"], ops);
    expect(d.dimension).toBe(3);
    expect(d.terms).toHaveLength(3);
    expect(d.terms.every((t) => t.multiplicity === 1)).toBe(true);
    // The all-plus (trivial) irrep does NOT appear (a moment is odd under each 2-fold).
    expect(d.terms.some((t) => t.irrep.characters.every((c) => c.re > 0))).toBe(false);
  });
});

describe("projectIrrepModes — the refinable moment basis per irrep", () => {
  it("C2: A → Mz only; B → Mx, My", () => {
    const ops = [E, twoZ];
    const d = decomposeMagneticRepresentation(atOrigin(ops), k0, ["M"], ops);
    const a = d.terms.find((t) => t.irrep.characters.every((c) => c.re > 0))!;
    const b = d.terms.find((t) => t.irrep.characters.some((c) => c.re < 0))!;
    const aModes = projectIrrepModes(atOrigin(ops), k0, ["M"], ops, a.irrep);
    const bModes = projectIrrepModes(atOrigin(ops), k0, ["M"], ops, b.irrep);
    expect(aModes).toHaveLength(1);
    expect(rd(aModes[0]!)).toEqual([0, 0, 1]); // Mz
    expect(bModes).toHaveLength(2); // in-plane Mx, My
    expect(bModes.every((m) => Math.abs(m[2]) < 1e-6)).toBe(true);
  });

  it("inversion: Ag carries all three moment directions", () => {
    const ops = [E, inv];
    const d = decomposeMagneticRepresentation(atOrigin(ops), k0, ["M"], ops);
    const modes = projectIrrepModes(atOrigin(ops), k0, ["M"], ops, d.terms[0]!.irrep);
    expect(modes).toHaveLength(3);
  });

  it("P1: the trivial irrep carries all three DOF", () => {
    const modes = projectIrrepModes(atOrigin([E]), k0, ["M"], [E], abelianIrreps([E])![0]!);
    expect(modes).toHaveLength(3);
  });
});
