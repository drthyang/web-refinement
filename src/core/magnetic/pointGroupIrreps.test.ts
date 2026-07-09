import { describe, it, expect } from "vitest";
import type { SymmetryOperation } from "@/core/crystal/types";
import { parseSymmetryOperation, composeOperations, operationKey } from "@/core/crystal/symmetry";
import { pointGroupIrreps } from "@/core/magnetic/pointGroupIrreps";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";

/** Close a generator set into a full (rotation) group. */
function closure(gens: string[]): SymmetryOperation[] {
  const ops = gens.map(parseSymmetryOperation);
  const seen = new Map<string, SymmetryOperation>();
  const queue = [...ops, parseSymmetryOperation("x,y,z")];
  for (const op of queue) seen.set(operationKey(op), op);
  while (queue.length > 0) {
    const a = queue.pop()!;
    for (const b of [...seen.values()]) {
      for (const c of [composeOperations(a, b), composeOperations(b, a)]) {
        const key = operationKey(c);
        if (!seen.has(key)) { seen.set(key, c); queue.push(c); }
      }
    }
  }
  return [...seen.values()];
}

const dims = (irr: { dim: number }[]): number[] => irr.map((x) => x.dim).sort((a, b) => a - b);

describe("pointGroupIrreps — induced irreps of non-abelian point groups", () => {
  it("4mm (C4v): 5 irreps, dims 1,1,1,1,2", () => {
    const ops = closure(["-y,x,z", "x,-y,z"]);
    expect(ops).toHaveLength(8);
    const irr = pointGroupIrreps(ops);
    expect(dims(irr)).toEqual([1, 1, 1, 1, 2]);
  });

  it("6/mmm (D6h, the Mn₃Ga co-group): 12 irreps, dims 1×8 + 2×4", () => {
    const ops = mn3gaPowgenExample().structure.spaceGroup.operations;
    const irr = pointGroupIrreps(ops);
    expect(irr).toHaveLength(12);
    expect(dims(irr)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
    // χ(E) = dim for every irrep.
    for (const x of irr) {
      expect(Math.round(x.characters[0]!.re)).toBe(x.dim);
    }
  });

  it("432 (O): 5 irreps, dims 1,1,2,3,3 — a 3-dim + index-3 case", () => {
    const ops = closure(["-y,x,z", "z,x,y"]);
    expect(ops).toHaveLength(24);
    const irr = pointGroupIrreps(ops);
    expect(dims(irr)).toEqual([1, 1, 2, 3, 3]);
  });

  it("m-3 (Th): 8 irreps, dims 1×6 + 3×2 (complex conjugate 1-dim pairs)", () => {
    const ops = closure(["z,x,y", "-x,-y,z", "-x,-y,-z"]);
    expect(ops).toHaveLength(24);
    const irr = pointGroupIrreps(ops);
    expect(dims(irr)).toEqual([1, 1, 1, 1, 1, 1, 3, 3]);
    // The Eg/Eu partners are complex (ω, ω²) — at least two complex 1-dims.
    expect(irr.filter((x) => x.dim === 1 && !x.real).length).toBeGreaterThanOrEqual(2);
  });

  it("m-3m (Oh, order 48): 10 irreps, dims 1,1,1,1,2,2,3,3,3,3", () => {
    const ops = closure(["-y,x,z", "z,x,y", "-x,-y,-z"]);
    expect(ops).toHaveLength(48);
    const irr = pointGroupIrreps(ops);
    expect(dims(irr)).toEqual([1, 1, 1, 1, 2, 2, 3, 3, 3, 3]);
  });

  it("abelian groups reproduce the abelian counts (mmm → 8 real 1-dims)", () => {
    const ops = closure(["-x,-y,z", "x,-y,-z", "-x,-y,-z"]);
    expect(ops).toHaveLength(8);
    const irr = pointGroupIrreps(ops);
    expect(dims(irr)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(irr.every((x) => x.real)).toBe(true);
  });

  it("Mn₃Ga at k = 0: Γ_mag decomposes over 6/mmm and the 1-D irreps are the maximal Shubnikov candidates", async () => {
    const { decomposeMagneticRepresentation, shubnikovCandidateIndex } = await import("@/core/magnetic/irreps");
    const { littleGroup, generateMagneticCandidates } = await import("@/core/magnetic/magneticGroups");
    const { structure } = mn3gaPowgenExample();
    const lg = littleGroup(structure.spaceGroup.operations, [0, 0, 0]);
    const mnSite = structure.sites.find((s) => s.element === "Mn")!.label;
    const dec = decomposeMagneticRepresentation(structure, [0, 0, 0], [mnSite], lg);

    expect(dec.abelian).toBe(false);
    expect(dec.available).toBe(true);       // the induced route kicked in at Γ
    expect(dec.method).toBe("induced");
    expect(dec.integerConsistent).toBe(true); // ordinary irreps are exact at Γ
    // Σ multiplicity·dim = dim Γ_mag = 3 × (orbit atoms).
    const total = dec.terms.reduce((s, t) => s + t.multiplicity * (t.irrep.dim ?? 1), 0);
    expect(total).toBe(dec.dimension);
    expect(dec.dimension).toBeGreaterThan(0);

    // Every real 1-D irrep of 6/mmm is a θ-homomorphism = one maximal
    // Shubnikov candidate; distinct irreps map to distinct candidates.
    const candidates = generateMagneticCandidates(lg);
    expect(candidates).toHaveLength(8); // 2³ homomorphisms of 6/mmm
    const irr = pointGroupIrreps(lg);
    const oneDims = irr.filter((x) => x.dim === 1);
    expect(oneDims).toHaveLength(8);
    const mapped = oneDims.map((x) =>
      shubnikovCandidateIndex({ label: x.label, characters: x.characters, real: x.real, dim: x.dim }, lg, candidates),
    );
    expect(mapped.every((m) => m !== null)).toBe(true);
    expect(new Set(mapped).size).toBe(8);
  });

  it("characters satisfy second orthogonality on a spot-checked pair of classes", () => {
    // Column orthogonality in 6/mmm: Σ_irreps χ(E)·χ(g)* = 0 for g ≠ E.
    const ops = mn3gaPowgenExample().structure.spaceGroup.operations;
    const irr = pointGroupIrreps(ops);
    for (let e = 1; e < Math.min(ops.length, 6); e++) {
      let re = 0;
      for (const x of irr) re += x.characters[0]!.re * x.characters[e]!.re + x.characters[0]!.im * x.characters[e]!.im;
      expect(Math.abs(re)).toBeLessThan(1e-6);
    }
  });
});
