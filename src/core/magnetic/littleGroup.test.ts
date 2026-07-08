import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import {
  littleGroup,
  transformK,
  generateMagneticCandidates,
  generateMagneticCandidatesForK,
} from "@/core/magnetic/magneticGroups";

// mmm (D2h, order 8): the eight diagonal operations diag(±1,±1,±1).
const MMM = [
  "x,y,z", "-x,y,z", "x,-y,z", "x,y,-z",
  "-x,-y,z", "-x,y,-z", "x,-y,-z", "-x,-y,-z",
].map(parseSymmetryOperation);

describe("little group of k (group of the wavevector)", () => {
  it("transforms k by Rᵀ (this codebase's reciprocal convention)", () => {
    const inv = parseSymmetryOperation("-x,-y,-z");
    const kp = transformK(inv, [0.25, 0, 0]);
    expect(kp[0]).toBeCloseTo(-0.25, 10);
    expect(kp[1]).toBeCloseTo(0, 10);
    expect(kp[2]).toBeCloseTo(0, 10);
  });

  it("is the whole group at k = 0", () => {
    expect(littleGroup(MMM, [0, 0, 0])).toHaveLength(8);
  });

  it("keeps all mmm operations for a zone-boundary k = (½,0,0)", () => {
    // −½ ≡ ½ (mod 1), so every diag(±1,…) leaves (½,0,0) invariant.
    expect(littleGroup(MMM, [0.5, 0, 0])).toHaveLength(8);
  });

  it("drops the operations that reverse kx for an interior k = (¼,0,0)", () => {
    // Only R with R₀₀ = +1 keep (¼,0,0): x,y,z · x,-y,z · x,y,-z · x,-y,-z.
    const lg = littleGroup(MMM, [0.25, 0, 0]);
    expect(lg).toHaveLength(4);
    for (const op of lg) expect(op.rotation[0][0]).toBe(1);
  });
});

describe("magnetic candidates for a commensurate k", () => {
  it("reduces to the k = 0 enumeration at Γ", () => {
    const atGamma = generateMagneticCandidatesForK(MMM, [0, 0, 0]);
    const k0 = generateMagneticCandidates(MMM);
    expect(atGamma).toHaveLength(k0.length);
    expect(atGamma.some((c) => c.isTypeI)).toBe(true);
  });

  it("enumerates candidates on the reduced little group for k = (¼,0,0)", () => {
    const cands = generateMagneticCandidatesForK(MMM, [0.25, 0, 0]);
    // Little group has 4 operations (order-4 abelian) → several θ: G→±1 maps,
    // and the type-I (all-unprimed) candidate is always present.
    expect(cands.length).toBeGreaterThan(1);
    expect(cands.some((c) => c.isTypeI)).toBe(true);
    // Every candidate's operation set matches the little group's size.
    for (const c of cands) expect(c.operations).toHaveLength(4);
  });
});
