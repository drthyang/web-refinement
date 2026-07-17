/**
 * Gates for the displacive (polar-vector) Γ representation analysis:
 *  - hand-checkable mirror (Cs) decomposition, with the trivial-irrep ≡
 *    symmetry-conserving-DOF invariant and the acoustic (vector-rep) split;
 *  - the textbook cubic-perovskite (BaTiO₃, Pm-3m) decomposition
 *    Γ_disp = 4·T1u ⊕ 1·T2u — the ISODISTORT/AMPLIMODES reference result —
 *    via the constructed (non-abelian, "induced") m-3m irreps;
 *  - polar vs axial character: χ_polar(−1) = −3 (a displacement is ODD under
 *    inversion; the magnetic axial character is +3 there).
 */
import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell, SymmetryOperation } from "@/core/crystal/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import {
  polarCharacter,
  decomposeDisplacementRepresentation,
  symmetryConservingDof,
} from "@/core/crystal/displaciveModes";
import { axialCharacter } from "@/core/magnetic/magneticRepresentation";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
const MIRROR_Z: SymmetryOperation = {
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ],
  translation: [0, 0, 0],
  xyz: "x,y,-z",
};
const INVERSION: SymmetryOperation = {
  rotation: [
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ],
  translation: [0, 0, 0],
  xyz: "-x,-y,-z",
};

const CELL: UnitCell = { a: 5, b: 5, c: 8, alpha: 90, beta: 90, gamma: 90 };

function site(label: string, element: string, position: readonly [number, number, number]): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}

describe("polar vs axial character", () => {
  it("differs on every improper operation (inversion: −3 vs +3)", () => {
    expect(polarCharacter(IDENTITY3)).toBe(3);
    expect(polarCharacter(INVERSION.rotation)).toBe(-3);
    expect(axialCharacter(INVERSION.rotation)).toBe(3);
    expect(polarCharacter(MIRROR_Z.rotation)).toBe(1);
    expect(axialCharacter(MIRROR_Z.rotation)).toBe(-1);
  });
});

describe("mirror (Cs) displacement decomposition — hand check", () => {
  // A1 ON the mirror (1 atom), B1 off it (orbit of 2): N = 3 atoms, dim 9.
  // χ(E) = 9, χ(m_z) = tr(m_z)·N_fixed = 1·1 = 1.
  // Cs irreps: A′ (χ=+1,+1) trivial, A″ (χ=+1,−1).
  //   n(A′) = (9+1)/2 = 5 — the symmetry-conserving DOF (A1: x,y; B1: x,y,z)
  //   n(A″) = (9−1)/2 = 4 — the symmetry-BREAKING modes
  // Vector rep χ = (3, 1): acoustic = 2·A′ + 1·A″.
  const structure: StructureModel = {
    id: "m", name: "mirror", cell: CELL,
    spaceGroup: { operations: [IDENTITY_OP, MIRROR_Z] },
    sites: [site("A1", "Ni", [0, 0, 0]), site("B1", "O", [0.3, 0, 0.2])],
  };
  const dec = decomposeDisplacementRepresentation(structure);

  it("decomposes 9 = 5·A′ ⊕ 4·A″ with the acoustic split 2+1", () => {
    expect(dec.available).toBe(true);
    expect(dec.method).toBe("abelian");
    expect(dec.integerConsistent).toBe(true);
    expect(dec.dimension).toBe(9);
    expect(dec.terms).toHaveLength(2);
    const trivial = dec.terms.find((t) => t.trivial)!;
    const breaking = dec.terms.find((t) => !t.trivial)!;
    expect(trivial.multiplicity).toBe(5);
    expect(trivial.acoustic).toBe(2);
    expect(breaking.multiplicity).toBe(4);
    expect(breaking.acoustic).toBe(1);
  });

  it("trivial-irrep multiplicity equals the symmetry-conserving DOF", () => {
    expect(symmetryConservingDof(structure)).toBe(5);
    expect(dec.terms.find((t) => t.trivial)!.multiplicity).toBe(symmetryConservingDof(structure));
  });

  it("Σ multiplicity·dim = 3N", () => {
    const total = dec.terms.reduce((s, t) => s + t.multiplicity * (t.irrep.dim ?? 1), 0);
    expect(total).toBe(9);
  });
});

describe("cubic perovskite (BaTiO₃, Pm-3m) — the textbook Γ decomposition", () => {
  // Ba 1a (0,0,0) + Ti 1b (½,½,½) + O 3c (0,½,½): 5 atoms, dim 15.
  // Known result (ISODISTORT/AMPLIMODES): Γ_disp = 4·T1u ⊕ 1·T2u.
  // T1u is the vector-rep irrep (dim 3, odd) — one of its 4 copies is the
  // acoustic branch; the 3 optic T1u copies are the ferroelectric modes.
  // No coordinate is free in Pm-3m: the trivial irrep does not appear.
  const cubic: UnitCell = { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 };
  const pm3m = buildSpaceGroup(221);
  const batio3: StructureModel = {
    id: "bto", name: "BaTiO3", cell: cubic,
    spaceGroup: pm3m,
    sites: [
      site("Ba1", "Ba", [0, 0, 0]),
      site("Ti1", "Ti", [0.5, 0.5, 0.5]),
      site("O1", "O", [0, 0.5, 0.5]),
    ],
  };
  const dec = decomposeDisplacementRepresentation(batio3);

  it("uses the constructed (non-abelian) m-3m irreps and is integral", () => {
    expect(dec.available).toBe(true);
    expect(dec.method).toBe("induced");
    expect(dec.integerConsistent).toBe(true);
    expect(dec.dimension).toBe(15);
  });

  it("Γ_disp = 4·T1u ⊕ 1·T2u; no trivial (symmetry-conserving) content", () => {
    expect(symmetryConservingDof(batio3)).toBe(0);
    expect(dec.terms.some((t) => t.trivial)).toBe(false);
    // Exactly two irreps appear, both 3-dimensional.
    expect(dec.terms).toHaveLength(2);
    for (const t of dec.terms) expect(t.irrep.dim ?? 1).toBe(3);
    // T1u = the vector-rep irrep (acoustic 1): multiplicity 4.
    const t1u = dec.terms.find((t) => t.acoustic === 1)!;
    const t2u = dec.terms.find((t) => t.acoustic === 0)!;
    expect(t1u.multiplicity).toBe(4);
    expect(t2u.multiplicity).toBe(1);
    // Σ mult·dim = 15.
    expect(dec.terms.reduce((s, t) => s + t.multiplicity * (t.irrep.dim ?? 1), 0)).toBe(15);
    // Both are odd under inversion (χ(−1) = −dim): genuine polar irreps.
    const invIdx = pm3m.operations.findIndex((op) =>
      op.rotation.every((row, i) => row.every((v, j) => v === (i === j ? -1 : 0))),
    );
    expect(invIdx).toBeGreaterThanOrEqual(0);
    expect(t1u.irrep.characters[invIdx]!.re).toBeCloseTo(-3, 6);
    expect(t2u.irrep.characters[invIdx]!.re).toBeCloseTo(-3, 6);
  });
});
