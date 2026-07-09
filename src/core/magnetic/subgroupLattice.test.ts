import { describe, it, expect } from "vitest";
import { parseSymmetryOperation, composeOperations, operationKey } from "@/core/crystal/symmetry";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";
import {
  magneticSubgroupLattice,
  latticeRepresentatives,
} from "@/core/magnetic/subgroupLattice";

// P2/m general positions (co-group 2/m, order 4, abelian).
const P2M = ["x,y,z", "-x,y,-z", "-x,-y,-z", "x,-y,z"].map(parseSymmetryOperation);
// Pmmm general positions (co-group mmm, order 8, abelian).
const PMMM = [
  "x,y,z", "-x,-y,z", "-x,y,-z", "x,-y,-z",
  "-x,-y,-z", "x,y,-z", "x,-y,z", "-x,y,z",
].map(parseSymmetryOperation);
// P4mm general positions (co-group 4mm, order 8, non-abelian ⇒ real conjugacy).
const P4MM = [
  "x,y,z", "-x,-y,z", "-y,x,z", "y,-x,z",
  "x,-y,z", "-x,y,z", "y,x,z", "-y,-x,z",
].map(parseSymmetryOperation);
// P2₁/m — the Mn₃Ga-type parent used across the magnetic tests.
const P21M = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);

const K0: [number, number, number] = [0, 0, 0];

describe("full magnetic subgroup lattice (t-subgroups × θ homomorphisms)", () => {
  it("2/m parent: 5 subgroups → 11 candidates (4 + 3·2 + 1), all normal", () => {
    // Subgroups of 2/m: {1}, {2}, {m}, {-1}, 2/m. θ-homomorphisms: Klein group
    // 2/m has 4, each order-2 subgroup 2, the trivial group 1 ⇒ 4+2+2+2+1 = 11.
    const lattice = magneticSubgroupLattice(P2M, K0);
    expect(lattice).toHaveLength(11);
    // Abelian co-group ⇒ every subgroup normal ⇒ every class is a singleton.
    expect(latticeRepresentatives(lattice)).toHaveLength(11);
    for (const c of lattice) expect(c.domainCount).toBe(1);
  });

  it("mmm parent: 16 subgroups → 51 candidates (8 + 7·4 + 7·2 + 1)", () => {
    const lattice = magneticSubgroupLattice(PMMM, K0);
    expect(lattice).toHaveLength(51);
    // Index in the grey group runs 2 (maximal, |H|=8) … 16 (triclinic {E}).
    const byIndex = new Map<number, number>();
    for (const c of lattice) byIndex.set(c.index, (byIndex.get(c.index) ?? 0) + 1);
    expect(byIndex.get(2)).toBe(8);   // θ on mmm itself: 2³ homomorphisms
    expect(byIndex.get(4)).toBe(28);  // 7 order-4 subgroups × 4 homs
    expect(byIndex.get(8)).toBe(14);  // 7 order-2 subgroups × 2 homs
    expect(byIndex.get(16)).toBe(1);  // trivial subgroup, θ trivial
  });

  it("index-2 slice reproduces the maximal-only generator exactly", () => {
    for (const parent of [P2M, PMMM, P21M]) {
      const maximal = magneticSubgroupLattice(parent, K0).filter((c) => c.index === 2);
      const legacy = generateMagneticCandidates(parent);
      const sig = (ops: readonly (typeof parent)[number][]): string =>
        ops.map((o) => `${operationKey(o)}|${o.timeReversal ?? 1}`).sort().join(" ");
      const a = new Set(maximal.map((c) => sig([...c.candidate.operations])));
      const b = new Set(legacy.map((c) => sig([...c.operations])));
      expect(a).toEqual(b);
    }
  });

  it("every candidate is a closed group with homomorphic θ", () => {
    const lattice = magneticSubgroupLattice(PMMM, K0);
    for (const { candidate } of lattice) {
      const byKey = new Map(candidate.operations.map((o) => [operationKey(o), o.timeReversal ?? 1]));
      for (const a of candidate.operations) {
        for (const b of candidate.operations) {
          const ab = composeOperations(a, b);
          const t = byKey.get(operationKey(ab));
          expect(t).toBeDefined(); // closure
          expect(t).toBe((a.timeReversal ?? 1) * (b.timeReversal ?? 1)); // θ homomorphic
        }
      }
    }
  });

  it("4mm parent: conjugate mirror subgroups are grouped as one class with 2 domains", () => {
    const lattice = magneticSubgroupLattice(P4MM, K0);
    // ⟨m_x⟩ = {E, x→−x} and ⟨m_y⟩ are conjugate under the 4-fold: their type-I
    // candidates must share a class with domainCount 2. Same for the diagonals.
    const typeIOrder2 = lattice.filter((c) => c.subgroupOrder === 2 && c.candidate.isTypeI);
    // Order-2 subgroups of 4mm: {2z}, {m_x}, {m_y}, {m_xy}, {m_x̄y} → 5 candidates
    expect(typeIOrder2).toHaveLength(5);
    const classes = new Map<number, typeof typeIOrder2>();
    for (const c of typeIOrder2) {
      classes.set(c.classId, [...(classes.get(c.classId) ?? []), c]);
    }
    // 3 classes: {2z} alone, {m_x, m_y}, {m_xy, m_x̄y}.
    expect(classes.size).toBe(3);
    const sizes = [...classes.values()].map((m) => m.length).sort();
    expect(sizes).toEqual([1, 2, 2]);
    for (const members of classes.values()) {
      for (const m of members) expect(m.domainCount).toBe(members.length);
    }
    // Representatives: exactly one per class.
    const reps = typeIOrder2.filter((c) => c.classRepresentative);
    expect(reps).toHaveLength(3);
  });

  it("BNS labels attach to proper subgroups in standard settings (P2/m ⊃ P-1)", () => {
    const lattice = magneticSubgroupLattice(P2M, K0);
    // The type-I candidate of the inversion-only subgroup is P-1 (BNS 2.4).
    const pbar1 = lattice.find(
      (c) =>
        c.subgroupOrder === 2 &&
        c.candidate.isTypeI &&
        c.candidate.operations.some((o) => o.xyz.replace(/\s/g, "") === "-x,-y,-z"),
    );
    expect(pbar1).toBeDefined();
    expect(pbar1!.candidate.standard?.bnsNumber).toBe("2.4");
  });

  it("maxIndex truncates the enumeration", () => {
    const lattice = magneticSubgroupLattice(PMMM, K0, { maxIndex: 4 });
    expect(lattice.every((c) => c.index <= 4)).toBe(true);
    expect(lattice).toHaveLength(8 + 28);
  });

  it("k ≠ 0 restricts to the little group first (P2₁/m, k = (0,0,½))", () => {
    // All P2₁/m rotations leave k = (0,0,½) invariant (b-axis 2-fold sends
    // l → −l ≡ l mod 1 for l = ½), so the little group is the full co-group
    // and the lattice again has 11 candidates.
    const lattice = magneticSubgroupLattice(P21M, [0, 0, 0.5]);
    expect(lattice).toHaveLength(11);
  });
});
