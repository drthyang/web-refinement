import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation, operationKey } from "@/core/crystal/symmetry";
import { abelianIrreps, decomposeMagneticRepresentation, shubnikovCandidateIndex } from "@/core/magnetic/irreps";
import { generateMagneticCandidates, littleGroup } from "@/core/magnetic/magneticGroups";
import { isotropySubgroup, type IrrepSelection } from "@/core/magnetic/isotropy";

const iso = { kind: "isotropic", bIso: 0.3 } as const;
const k0: Vec3 = [0, 0, 0];

// P2/m: E, 2y, -1, my (order 4, exponent 2 ⇒ all irreps real).
const P2M = ["x,y,z", "-x,y,-z", "-x,-y,-z", "x,-y,z"].map(parseSymmetryOperation);
// P2₁/m (the Mn₃Ga-type parent).
const P21M = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);

function structureWith(ops: SymmetryOperation[], position: Vec3): StructureModel {
  return {
    id: "t",
    name: "t",
    cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: ops },
    sites: [{ label: "M", element: "Mn", oxidationState: 2, position, occupancy: 1, adp: iso }],
  };
}

const opSig = (ops: readonly SymmetryOperation[]): string =>
  [...new Set(ops.map((o) => `${operationKey(o)}|${o.timeReversal ?? 1}`))].sort().join(" ");

describe("isotropySubgroup — single real irrep reproduces its Shubnikov kernel", () => {
  it("every real irrep of P2/m on a general site maps to its θ = χ candidate", () => {
    const structure = structureWith(P2M, [0.13, 0.27, 0.41]);
    const lg = littleGroup(P2M, k0);
    const candidates = generateMagneticCandidates(lg);
    const dec = decomposeMagneticRepresentation(structure, k0, ["M"], lg);
    expect(dec.abelian).toBe(true);
    expect(dec.terms.length).toBeGreaterThan(0);

    for (const term of dec.terms) {
      if (!term.irrep.real) continue;
      const candIdx = shubnikovCandidateIndex(term.irrep, lg, candidates);
      const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: term.irrep }]);
      expect("failure" in result).toBe(false);
      if ("failure" in result) continue;
      // The stabilizer of a generic single-irrep structure is the kernel-with-
      // θ = χ group — exactly the Shubnikov candidate the irrep maps to.
      expect(candIdx).not.toBeNull();
      expect(opSig(result.operations)).toBe(opSig([...candidates[candIdx!]!.operations]));
      expect(result.standard?.bnsNumber).toBe(candidates[candIdx!]!.standard?.bnsNumber);
    }
  });

  it("P2₁/m: the Bg-type irrep (2₁, m primed) names P2₁'/m' — the Mn₃Ga ground state", () => {
    const structure = structureWith(P21M, [0.343, 0.25, 0.833]); // on the mirror
    const lg = littleGroup(P21M, k0);
    const irreps = abelianIrreps(lg)!;
    // The irrep with χ(2₁) = −1, χ(-1) = +1, χ(m) = −1.
    const target = irreps.find((ir) => {
      const chi = ir.characters.map((c) => Math.round(c.re));
      return chi[0] === 1 && chi[1] === -1 && chi[2] === 1 && chi[3] === -1;
    })!;
    const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: target }]);
    expect("failure" in result).toBe(false);
    if ("failure" in result) return;
    expect(result.standard?.bnsSymbol).toBe("P2_1'/m'");
  });
});

describe("isotropySubgroup — irrep combinations intersect kernels (SARAh-style mixing)", () => {
  const structure = structureWith(P2M, [0.13, 0.27, 0.41]);
  const lg = littleGroup(P2M, k0);
  const irreps = abelianIrreps(lg)!;
  const chiOf = (ir: (typeof irreps)[number]): number[] => ir.characters.map((c) => Math.round(c.re));
  // Identify irreps by their character on (E, 2y, -1, my).
  const byChi = (want: number[]): (typeof irreps)[number] =>
    irreps.find((ir) => chiOf(ir).every((x, i) => x === want[i]))!;

  it("Ag ⊕ Bg (χ agreeing only on {E, -1}) → P-1 (BNS 2.4)", () => {
    const Ag = byChi([1, 1, 1, 1]);
    const Bg = byChi([1, -1, 1, -1]);
    const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: Ag }, { irrep: Bg }]);
    expect("failure" in result).toBe(false);
    if ("failure" in result) return;
    expect(result.subgroupOrder).toBe(2);
    expect(result.standard?.bnsNumber).toBe("2.4"); // type-I P-1
  });

  it("mixing all four irreps leaves only the identity → P1 (BNS 1.1)", () => {
    const selections: IrrepSelection[] = irreps.map((irrep) => ({ irrep }));
    const result = isotropySubgroup(structure, k0, ["M"], lg, selections);
    expect("failure" in result).toBe(false);
    if ("failure" in result) return;
    expect(result.subgroupOrder).toBe(1);
    expect(result.standard?.bnsNumber).toBe("1.1");
  });

  it("Ag ⊕ Au (agreeing on {E, 2y}) → the polar subgroup P2 (BNS 3.1)", () => {
    const Ag = byChi([1, 1, 1, 1]);
    const Au = byChi([1, 1, -1, -1]);
    const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: Ag }, { irrep: Au }]);
    expect("failure" in result).toBe(false);
    if ("failure" in result) return;
    expect(result.subgroupOrder).toBe(2);
    expect(result.standard?.bnsNumber).toBe("3.1"); // type-I P2 (b-unique)
  });

  it("the result is amplitude-independent for 1-D irreps (kernel, no epikernel)", () => {
    const Bg = byChi([1, -1, 1, -1]);
    // Restricting to a single mode of the irrep must give the same group as
    // the generic all-mode combination: 1-D irreps act by a scalar.
    const all = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: Bg }]);
    const one = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: Bg, modeIndices: [0] }]);
    expect("failure" in all).toBe(false);
    expect("failure" in one).toBe(false);
    if ("failure" in all || "failure" in one) return;
    expect(opSig(one.operations)).toBe(opSig(all.operations));
  });
});

describe("isotropySubgroup — honest failures", () => {
  it("empty selection → no-modes", () => {
    const structure = structureWith(P2M, [0.13, 0.27, 0.41]);
    const lg = littleGroup(P2M, k0);
    const result = isotropySubgroup(structure, k0, ["M"], lg, []);
    expect(result).toEqual({ failure: "no-modes" });
  });

  it("complex conjugate-pair irrep → complex-irrep failure (C4 little group)", () => {
    const C4 = ["x,y,z", "-y,x,z", "-x,-y,z", "y,-x,z"].map(parseSymmetryOperation);
    const structure = structureWith(C4, [0.2, 0.3, 0.4]);
    const lg = littleGroup(C4, k0);
    const irreps = abelianIrreps(lg)!;
    const complex = irreps.find((ir) => !ir.real)!;
    const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: complex }]);
    expect(result).toEqual({ failure: "complex-irrep" });
  });

  it("an irrep with no modes on the site → no-modes (moment-forbidden order)", () => {
    // Site at the origin of P2/m (site symmetry = whole co-group): the axial
    // projection kills Au on this site? Use whichever irrep projects to zero.
    const structure = structureWith(P2M, [0, 0, 0]);
    const lg = littleGroup(P2M, k0);
    const irreps = abelianIrreps(lg)!;
    const dec = decomposeMagneticRepresentation(structure, k0, ["M"], lg);
    const appearing = new Set(dec.terms.map((t) => t.irrep.label));
    const absent = irreps.find((ir) => !appearing.has(ir.label));
    if (!absent) return; // all irreps appear — nothing to assert here
    const result = isotropySubgroup(structure, k0, ["M"], lg, [{ irrep: absent }]);
    expect(result).toEqual({ failure: "no-modes" });
  });
});
