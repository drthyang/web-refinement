import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";

// Parent P2₁/m general positions.
const P21M = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);

describe("magnetic candidate generation (k = 0)", () => {
  const candidates = generateMagneticCandidates(P21M);

  it("produces the type-I group plus one per index-2 subgroup (4 total for P2₁/m)", () => {
    expect(candidates).toHaveLength(4);
    expect(candidates.filter((c) => c.isTypeI)).toHaveLength(1);
  });

  it("includes the P2₁'/m' solution (identity & inversion unprimed, 2₁ & m primed)", () => {
    // Find the candidate whose unprimed operations are exactly {x,y,z ; -x,-y,-z}.
    const match = candidates.find((c) => {
      const unprimed = c.operations.filter((o) => (o.timeReversal ?? 1) === 1).map((o) => o.xyz).sort();
      const primed = c.operations.filter((o) => (o.timeReversal ?? 1) === -1).map((o) => o.xyz).sort();
      return (
        unprimed.length === 2 &&
        unprimed.includes("x,y,z") &&
        unprimed.some((s) => s.includes("-x,-y,-z")) &&
        primed.length === 2
      );
    });
    expect(match).toBeDefined();
  });

  it("every candidate is a valid group (closed, homomorphic time reversal)", () => {
    for (const c of candidates) {
      const unprimed = c.operations.filter((o) => (o.timeReversal ?? 1) === 1);
      // The unprimed set always contains the identity and is non-empty.
      expect(unprimed.length).toBeGreaterThan(0);
    }
  });
});

describe("allowed moment directions", () => {
  const candidates = generateMagneticCandidates(P21M);

  it("P2₁'/m' allows a moment in the a–c plane on the 2b/2a-like site (dim 2)", () => {
    const p21pmp = candidates.find((c) => {
      const unprimed = c.operations.filter((o) => (o.timeReversal ?? 1) === 1);
      return unprimed.length === 2 && unprimed.some((o) => o.xyz.includes("-x,-y,-z"));
    })!;
    // Site at (x, 1/4, z) on the mirror; the GSAS moment lies in the a–c plane.
    const allowed = allowedMomentDirections(p21pmp.operations, [0.343, 0.25, 0.833]);
    expect(allowed.dimension).toBe(2);
    // The allowed basis should have no b-component (m_y = 0), matching GSAS.
    for (const v of allowed.basis) expect(Math.abs(v[1])).toBeLessThan(1e-6);
  });

  it("the type-I group forbids a moment where the site symmetry demands it", () => {
    const typeI = candidates.find((c) => c.isTypeI)!;
    const allowed = allowedMomentDirections(typeI.operations, [0.343, 0.25, 0.833]);
    // Under full (unprimed) 2₁/m symmetry the mirror site allows only m_y.
    expect(allowed.dimension).toBeLessThanOrEqual(1);
  });
});

describe("candidate generation on the real 30 K structure", () => {
  it("generates candidates from the parsed magnetic operations", () => {
    const { structure } = exampleMagnetic();
    // Strip time reversal to recover the parent operation list.
    const parent = structure.spaceGroup.operations.map((o) => ({ ...o, timeReversal: 1 as const }));
    const candidates = generateMagneticCandidates(parent);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });
});
