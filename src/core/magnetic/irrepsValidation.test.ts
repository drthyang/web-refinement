/**
 * Independent validation of the representation-analysis framework against
 * group-theory identities and textbook results — checks that hold regardless
 * of implementation details:
 *
 *  1. `abelianIrreps` returns a valid character table: |irreps| = |co-group|,
 *     every character unimodular, each irrep a homomorphism χ(g)χ(h) = χ(gh),
 *     and the rows orthonormal under the group inner product.
 *  2. The decomposition exactly reconstructs the reducible character:
 *     Σᵢ nᵢ·χᵢ(g) = χ_mag(g) for every g.
 *  3. The classic Pnma 4b (LaMnO₃-type) result: Γ_mag = 3Γ⊕3Γ⊕3Γ⊕3Γ over the
 *     four gerade irreps of mmm, three basis modes each.
 *  4. Orbit counting is robust to the 0/1 fractional-coordinate wrap
 *     (⅓ + ⅔ = 0.999…): atoms reached at ~1.0 and at exactly 0.0 are the same.
 */

import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { applyOperation, parseSymmetryOperation } from "@/core/crystal/symmetry";
import { determinant, mulMat } from "@/core/math/mat3";
import {
  magneticRepresentationCharacter,
  magneticRepresentationDimension,
} from "@/core/magnetic/magneticRepresentation";
import { abelianIrreps, decomposeMagneticRepresentation, projectIrrepModes, shubnikovCandidateIndex } from "@/core/magnetic/irreps";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";

const ops = (...xyz: string[]): SymmetryOperation[] => xyz.map(parseSymmetryOperation);
const iso = { kind: "isotropic", bIso: 0.3 } as const;

function structure(operations: SymmetryOperation[], positions: Vec3[], cell = { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 }): StructureModel {
  return {
    id: "v", name: "v", cell,
    spaceGroup: { operations },
    sites: positions.map((position, i) => ({
      label: `M${i + 1}`, element: "Mn", oxidationState: 3, position, occupancy: 1, adp: iso,
    })),
  };
}

const K0: Vec3 = [0, 0, 0];
const matKey = (m: readonly (readonly number[])[]): string => m.flat().map((x) => Math.round(x)).join(",");

/** Abelian little groups spanning the crystal systems this route covers. */
const GROUPS: Record<string, SymmetryOperation[]> = {
  "2/m": ops("x,y,z", "-x,-y,z", "-x,-y,-z", "x,y,-z"),
  "mmm": ops(
    "x,y,z", "-x,-y,z", "x,-y,-z", "-x,y,-z",
    "-x,-y,-z", "x,y,-z", "-x,y,z", "x,-y,z",
  ),
  "4/m": ops(
    "x,y,z", "-y,x,z", "-x,-y,z", "y,-x,z",
    "-x,-y,-z", "y,-x,-z", "x,y,-z", "-y,x,-z",
  ),
  "6 (C6)": ops("x,y,z", "x-y,x,z", "-y,x-y,z", "-x,-y,z", "-x+y,-x,z", "y,-x+y,z"),
  "-3 (S6)": ops("x,y,z", "-y,x-y,z", "-x+y,-x,z", "-x,-y,-z", "y,-x+y,-z", "x-y,x,-z"),
  "6/m": ops(
    "x,y,z", "x-y,x,z", "-y,x-y,z", "-x,-y,z", "-x+y,-x,z", "y,-x+y,z",
    "-x,-y,-z", "-x+y,-x,-z", "y,-x+y,-z", "x,y,-z", "x-y,x,-z", "-y,x-y,-z",
  ),
};

describe("abelianIrreps — character-table identities", () => {
  for (const [name, g] of Object.entries(GROUPS)) {
    it(`${name}: complete, unimodular, homomorphic, orthonormal`, () => {
      const irreps = abelianIrreps(g);
      expect(irreps).not.toBeNull();
      // Complete: one 1-D irrep per group element.
      expect(irreps!).toHaveLength(g.length);

      // Character lookup by rotation matrix for homomorphism products.
      const idx = new Map<string, number>(g.map((op, i) => [matKey(op.rotation), i]));

      for (const irrep of irreps!) {
        // Unimodular (1-D unitary): |χ(g)| = 1 for every element.
        for (const c of irrep.characters) {
          expect(Math.hypot(c.re, c.im)).toBeCloseTo(1, 9);
        }
        // Homomorphism: χ(g)·χ(h) = χ(g·h).
        for (let a = 0; a < g.length; a++) {
          for (let b = 0; b < g.length; b++) {
            const prod = idx.get(matKey(mulMat(g[a]!.rotation, g[b]!.rotation)));
            expect(prod).toBeDefined();
            const ca = irrep.characters[a]!;
            const cb = irrep.characters[b]!;
            const cp = irrep.characters[prod!]!;
            expect(ca.re * cb.re - ca.im * cb.im).toBeCloseTo(cp.re, 9);
            expect(ca.re * cb.im + ca.im * cb.re).toBeCloseTo(cp.im, 9);
          }
        }
      }

      // Orthonormality: (1/|G|) Σ_g χ_a(g)·χ_b(g)* = δ_ab (⇒ all irreps distinct).
      for (let a = 0; a < irreps!.length; a++) {
        for (let b = 0; b < irreps!.length; b++) {
          let re = 0;
          let im = 0;
          for (let i = 0; i < g.length; i++) {
            const x = irreps![a]!.characters[i]!;
            const y = irreps![b]!.characters[i]!;
            re += x.re * y.re + x.im * y.im;
            im += x.im * y.re - x.re * y.im;
          }
          expect(re / g.length).toBeCloseTo(a === b ? 1 : 0, 9);
          expect(im / g.length).toBeCloseTo(0, 9);
        }
      }
    });
  }
});

/** Σᵢ nᵢ·χᵢ(g) must reproduce χ_mag(g) exactly when the decomposition is valid. */
function expectReconstruction(s: StructureModel, k: Vec3, labels: string[], lg: SymmetryOperation[]): void {
  const dec = decomposeMagneticRepresentation(s, k, labels, lg);
  expect(dec.abelian).toBe(true);
  expect(dec.integerConsistent).toBe(true);
  const chi = magneticRepresentationCharacter(s, k, labels, lg);
  const rebuilt: { re: number; im: number }[] = chi.map(() => ({ re: 0, im: 0 }));
  for (const t of dec.terms) {
    t.irrep.characters.forEach((c, i) => {
      rebuilt[i]!.re += t.multiplicity * c.re;
      rebuilt[i]!.im += t.multiplicity * c.im;
    });
  }
  chi.forEach((c, i) => {
    expect(rebuilt[i]!.re).toBeCloseTo(c.re, 6);
    expect(rebuilt[i]!.im).toBeCloseTo(c.im, 6);
  });
}

describe("decomposition — exact character reconstruction", () => {
  it("P2₁/m, three Mn 2e sites (Mn₃Ga parent), k = 0", () => {
    const g = ops("x,y,z", "-x,y+1/2,-z", "-x,-y,-z", "x,-y+1/2,z");
    const s = structure(g, [[0.343, 0.25, 0.833], [0.842, 0.25, 0.335], [0.844, 0.25, 0.834]],
      { a: 5.42, b: 4.34, c: 5.32, alpha: 90, beta: 60.7, gamma: 90 });
    expect(magneticRepresentationDimension(s, ["M1", "M2", "M3"])).toBe(18);
    expectReconstruction(s, K0, ["M1", "M2", "M3"], g);
  });

  it("C2, general position (atoms swapped by the 2-fold), k = 0", () => {
    const g = ops("x,y,z", "-x,-y,z");
    const s = structure(g, [[0.1, 0.2, 0.3]]);
    expectReconstruction(s, K0, ["M1"], g);
  });

  it("P-1, atom at (0,0,½), k = (0,0,½): the k-phase flips the inversion character", () => {
    const g = ops("x,y,z", "-x,-y,-z");
    const k: Vec3 = [0, 0, 0.5];
    const s = structure(g, [[0, 0, 0.5]]);
    // Inversion fixes the atom via L = (0,0,−1) ⇒ phase e^{2πi·½·(−1)} = −1,
    // axial χ(i) = +3 ⇒ χ_mag = [3, −3]: all three modes go to the odd irrep.
    const chi = magneticRepresentationCharacter(s, k, ["M1"], g);
    expect(chi[0]!.re).toBeCloseTo(3);
    expect(chi[1]!.re).toBeCloseTo(-3);
    const dec = decomposeMagneticRepresentation(s, k, ["M1"], g);
    expect(dec.terms).toHaveLength(1);
    expect(dec.terms[0]!.multiplicity).toBe(3);
    expect(Math.round(dec.terms[0]!.irrep.characters[1]!.re)).toBe(-1);
    expectReconstruction(s, k, ["M1"], g);
  });
});

describe("Pnma 4b — the classic LaMnO₃-type textbook case", () => {
  const g = ops(
    "x,y,z", "-x+1/2,-y,z+1/2", "-x,y+1/2,-z", "x+1/2,-y+1/2,-z+1/2",
    "-x,-y,-z", "x+1/2,y,-z+1/2", "x,-y+1/2,z", "-x+1/2,y+1/2,z+1/2",
  );
  const s = structure(g, [[0, 0, 0.5]]);

  it("Γ_mag(4b) = 12-dim, four gerade irreps × multiplicity 3, 3 modes each", () => {
    expect(magneticRepresentationDimension(s, ["M1"])).toBe(12);
    const dec = decomposeMagneticRepresentation(s, K0, ["M1"], g);
    expect(dec.abelian).toBe(true);
    expect(dec.integerConsistent).toBe(true);
    expect(dec.terms).toHaveLength(4);
    expect(dec.terms.every((t) => t.multiplicity === 3)).toBe(true);
    // Site symmetry -1: only irreps even under inversion appear.
    const invIdx = g.findIndex((op) => matKey(op.rotation) === matKey([[-1, 0, 0], [0, -1, 0], [0, 0, -1]]));
    expect(dec.terms.every((t) => t.irrep.characters[invIdx]!.re > 0.5)).toBe(true);
    // Each appearing irrep carries all three moment directions on the 4b site.
    for (const t of dec.terms) {
      expect(projectIrrepModes(s, K0, ["M1"], g, t.irrep)).toHaveLength(3);
    }
    expectReconstruction(s, K0, ["M1"], g);
  });
});

/** m must be invariant under every magnetic stabilizer op: e^{2πik·L}·θ·det(R)·R·m = m. */
function expectInvariantUnderStabilizer(ops: readonly SymmetryOperation[], pos: Vec3, k: Vec3, m: Vec3): void {
  for (const op of ops) {
    const p = applyOperation(op, pos);
    const L = [p[0]! - pos[0]!, p[1]! - pos[1]!, p[2]! - pos[2]!];
    if (L.some((v) => Math.abs(v - Math.round(v)) > 1e-3)) continue;
    const phase = 2 * Math.PI * (k[0]! * Math.round(L[0]!) + k[1]! * Math.round(L[1]!) + k[2]! * Math.round(L[2]!));
    expect(Math.abs(Math.sin(phase))).toBeLessThan(1e-9); // commensurate ±1 phase here
    const w = Math.cos(phase) * determinant(op.rotation) * (op.timeReversal ?? 1);
    const R = op.rotation;
    for (let i = 0; i < 3; i++) {
      const mi = w * (R[i]![0]! * m[0]! + R[i]![1]! * m[1]! + R[i]![2]! * m[2]!);
      expect(mi).toBeCloseTo(m[i]!, 6);
    }
  }
}

describe("two routes, one answer — real irreps ↔ Shubnikov candidates", () => {
  it("C2: A ↔ type-I (Mz), B ↔ primed-2z candidate (Mx, My)", () => {
    const g = ops("x,y,z", "-x,-y,z");
    const s = structure(g, [[0, 0, 0]]);
    const candidates = generateMagneticCandidatesForK(g, K0);
    const dec = decomposeMagneticRepresentation(s, K0, ["M1"], g);
    for (const t of dec.terms) {
      const idx = shubnikovCandidateIndex(t.irrep, g, candidates);
      expect(idx).not.toBeNull();
      const cand = candidates[idx!]!;
      // The candidate's θ signs are exactly the irrep characters.
      const isTypeI = t.irrep.characters.every((c) => c.re > 0);
      expect(cand.isTypeI).toBe(isTypeI);
      // Same physics: the allowed-moment space of the candidate matches the
      // irrep's projected modes, and every mode is stabilizer-invariant.
      const modes = projectIrrepModes(s, K0, ["M1"], g, t.irrep);
      const allowed = allowedMomentDirections(cand.operations, [0, 0, 0], K0);
      expect(allowed.dimension).toBe(modes.length);
      for (const m of modes) expectInvariantUnderStabilizer(cand.operations, [0, 0, 0], K0, m);
    }
  });

  it("Pnma 4b: every appearing (gerade) irrep maps to a candidate with 3 allowed modes", () => {
    const g = ops(
      "x,y,z", "-x+1/2,-y,z+1/2", "-x,y+1/2,-z", "x+1/2,-y+1/2,-z+1/2",
      "-x,-y,-z", "x+1/2,y,-z+1/2", "x,-y+1/2,z", "-x+1/2,y+1/2,z+1/2",
    );
    const s = structure(g, [[0, 0, 0.5]]);
    const candidates = generateMagneticCandidatesForK(g, K0);
    const dec = decomposeMagneticRepresentation(s, K0, ["M1"], g);
    expect(dec.terms).toHaveLength(4);
    const matched = new Set<number>();
    for (const t of dec.terms) {
      const idx = shubnikovCandidateIndex(t.irrep, g, candidates);
      expect(idx).not.toBeNull();
      matched.add(idx!);
      const modes = projectIrrepModes(s, K0, ["M1"], g, t.irrep);
      const allowed = allowedMomentDirections(candidates[idx!]!.operations, [0, 0, 0.5], K0);
      expect(allowed.dimension).toBe(modes.length);
      for (const m of modes) expectInvariantUnderStabilizer(candidates[idx!]!.operations, [0, 0, 0.5], K0, m);
    }
    expect(matched.size).toBe(4); // four distinct irreps → four distinct groups
  });

  it("complex irreps (C4) have no single Shubnikov counterpart", () => {
    const g = ops("x,y,z", "-y,x,z", "-x,-y,z", "y,-x,z");
    const candidates = generateMagneticCandidatesForK(g, K0);
    const irreps = abelianIrreps(g)!;
    for (const irrep of irreps.filter((x) => !x.real)) {
      expect(shubnikovCandidateIndex(irrep, g, candidates)).toBeNull();
    }
  });
});

describe("allowedMomentDirections — k·L phase in the stabilizer constraint", () => {
  const g = ops("x,y,z", "-x,-y,-z");
  const kHalf: Vec3 = [0, 0, 0.5];
  const pos: Vec3 = [0, 0, 0.5]; // inversion fixes it via L = (0,0,−1) ⇒ phase −1

  it("k = (0,0,½): unprimed inversion forbids the moment (antiphase point)", () => {
    const typeI = generateMagneticCandidatesForK(g, kHalf).find((c) => c.isTypeI)!;
    expect(allowedMomentDirections(typeI.operations, pos, kHalf).dimension).toBe(0);
  });

  it("k = (0,0,½): primed inversion allows all three components", () => {
    const typeIII = generateMagneticCandidatesForK(g, kHalf).find((c) => !c.isTypeI)!;
    expect(allowedMomentDirections(typeIII.operations, pos, kHalf).dimension).toBe(3);
  });

  it("k = 0 (or L = 0) is unchanged: unprimed inversion allows all three", () => {
    const typeI = generateMagneticCandidatesForK(g, K0).find((c) => c.isTypeI)!;
    expect(allowedMomentDirections(typeI.operations, pos, K0).dimension).toBe(3);
    expect(allowedMomentDirections(typeI.operations, [0, 0, 0], kHalf).dimension).toBe(3);
  });

  it("agrees with the irrep route at k = (0,0,½)", () => {
    const s = structure(g, [[0, 0, 0.5]]);
    const dec = decomposeMagneticRepresentation(s, kHalf, ["M1"], g);
    const candidates = generateMagneticCandidatesForK(g, kHalf);
    expect(dec.terms).toHaveLength(1); // only the odd irrep carries the order
    const idx = shubnikovCandidateIndex(dec.terms[0]!.irrep, g, candidates)!;
    expect(candidates[idx]!.isTypeI).toBe(false);
    expect(allowedMomentDirections(candidates[idx]!.operations, pos, kHalf).dimension).toBe(3);
  });
});

describe("orbit counting — 0/1 fractional wrap robustness", () => {
  it("atoms reached at ~0.9999 and at ~0.0000 are not double-counted", () => {
    // Order-6 group: ⅓-translations along z × inversion, with a CIF-rounded
    // coordinate 0.6667 (≈ ⅔). One op reaches the z≈0 atom at 0.6667+⅓ =
    // 0.00003…, another at −0.6667+⅔ = 0.99996… — the same atom on either
    // side of the 0/1 wrap. True orbit: {0, ⅓, ⅔} → dimension 9.
    const g = ops(
      "x,y,z", "x,y,z+1/3", "x,y,z+2/3",
      "-x,-y,-z", "-x,-y,-z+1/3", "-x,-y,-z+2/3",
    );
    const s = structure(g, [[0, 0, 0.6667]]);
    expect(magneticRepresentationDimension(s, ["M1"])).toBe(9);
  });
});
