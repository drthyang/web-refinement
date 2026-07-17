import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { rotateUAniso, adpForOperation } from "@/core/crystal/adp";
import { expandStructureAtoms, nuclearStructureFactor } from "@/core/diffraction/structureFactor";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { IDENTITY3 } from "@/core/math/mat3";

/**
 * Anisotropic ADPs must rotate with a site's orbit (U′ = R·U·Rᵀ) — in the
 * real-space pair widths, the nuclear structure factor, and the expansion the
 * GPU kernel marshals. The identity gate: a symmetric structure and its
 * hand-expanded P1 twin (rotated tensors written explicitly) must agree
 * everywhere. Before this fix they diverged for any anisotropic site whose
 * orbit involves a rotation.
 */

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
/** 4-fold about z (fractional, tetragonal): (x,y,z) → (−y,x,z). */
const FOUR_FOLD_Z: SymmetryOperation = {
  rotation: [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  translation: [0, 0, 0],
  xyz: "-y,x,z",
};
/** 2-fold about z: (x,y,z) → (−x,−y,z). */
const TWO_FOLD_Z: SymmetryOperation = {
  rotation: [
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ],
  translation: [0, 0, 0],
  xyz: "-x,-y,z",
};
/** 4-fold cubed: (x,y,z) → (y,−x,z). */
const FOUR_FOLD_Z3: SymmetryOperation = {
  rotation: [
    [0, 1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ],
  translation: [0, 0, 0],
  xyz: "y,-x,z",
};

describe("rotateUAniso", () => {
  const u: [number, number, number, number, number, number] = [0.01, 0.02, 0.03, 0.004, 0.005, 0.006];

  it("identity leaves the tensor unchanged", () => {
    expect(rotateUAniso(u, IDENTITY3)).toEqual(u);
  });

  it("a 4-fold about z swaps U11/U22 and maps the off-diagonals correctly", () => {
    const r = rotateUAniso(u, FOUR_FOLD_Z.rotation);
    // (x,y) → (−y,x): U'11 = U22, U'22 = U11, U'33 = U33,
    // U'12 = −U12, U'13 = −U23, U'23 = U13.
    expect(r[0]).toBeCloseTo(u[1], 12);
    expect(r[1]).toBeCloseTo(u[0], 12);
    expect(r[2]).toBeCloseTo(u[2], 12);
    expect(r[3]).toBeCloseTo(-u[3], 12);
    expect(r[4]).toBeCloseTo(-u[5], 12);
    expect(r[5]).toBeCloseTo(u[4], 12);
  });

  it("is an orthogonal-conjugation: trace invariant, applying R then R³ = identity", () => {
    const once = rotateUAniso(u, FOUR_FOLD_Z.rotation);
    expect(once[0] + once[1] + once[2]).toBeCloseTo(u[0] + u[1] + u[2], 12);
    const back = rotateUAniso(once, FOUR_FOLD_Z3.rotation);
    for (let i = 0; i < 6; i++) expect(back[i]).toBeCloseTo(u[i]!, 12);
  });

  it("adpForOperation passes isotropic through untouched", () => {
    const iso = { kind: "isotropic" as const, bIso: 0.5 };
    expect(adpForOperation(iso, FOUR_FOLD_Z.rotation)).toBe(iso);
  });
});

// --- The identity gate: symmetric structure ≡ hand-expanded P1 twin ---------

const CELL: UnitCell = { a: 4.2, b: 4.2, c: 6.8, alpha: 90, beta: 90, gamma: 90 }; // tetragonal
const U: [number, number, number, number, number, number] = [0.012, 0.02, 0.007, 0.003, 0.002, 0.004];
const POS: [number, number, number] = [0.3, 0.1, 0.25]; // general position (orbit of 4)
const OPS = [IDENTITY_OP, FOUR_FOLD_Z, TWO_FOLD_Z, FOUR_FOLD_Z3];

function symmetric(): StructureModel {
  const sites: AtomSite[] = [{ label: "O1", element: "O", position: POS, occupancy: 1, adp: { kind: "anisotropic", uAniso: U } }];
  return { id: "sym", name: "sym", cell: CELL, spaceGroup: { operations: OPS }, sites };
}

function p1Twin(): StructureModel {
  const wrap = (x: number): number => ((x % 1) + 1) % 1;
  const sites: AtomSite[] = OPS.map((op, i) => {
    const r = op.rotation;
    const p: [number, number, number] = [
      wrap(r[0]![0]! * POS[0] + r[0]![1]! * POS[1] + r[0]![2]! * POS[2]),
      wrap(r[1]![0]! * POS[0] + r[1]![1]! * POS[1] + r[1]![2]! * POS[2]),
      wrap(r[2]![0]! * POS[0] + r[2]![1]! * POS[1] + r[2]![2]! * POS[2]),
    ];
    return { label: `O${i + 1}`, element: "O", position: p, occupancy: 1, adp: { kind: "anisotropic", uAniso: rotateUAniso(U, r) } };
  });
  return { id: "p1", name: "p1", cell: CELL, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

describe("symmetric structure ≡ hand-expanded P1 twin (rotated tensors)", () => {
  it("expandStructureAtoms carries the rotated tensor per orbit image", () => {
    const atoms = expandStructureAtoms(symmetric());
    expect(atoms).toHaveLength(4);
    const img = atoms[1]!; // the 4-fold image
    expect(img.adp.kind).toBe("anisotropic");
    if (img.adp.kind === "anisotropic") {
      expect(img.adp.uAniso[0]).toBeCloseTo(U[1], 12);
      expect(img.adp.uAniso[3]).toBeCloseTo(-U[3], 12);
    }
  });

  it("nuclear |F(hkl)| matches for a spread of reflections", () => {
    const sym = symmetric();
    const p1 = p1Twin();
    const rad = { kind: "neutron" as const, wavelength: 1.54 };
    for (const [h, k, l] of [[1, 0, 0], [2, 1, 0], [1, 1, 2], [3, 0, 1], [2, 2, 3], [1, 3, 2]] as const) {
      const a = nuclearStructureFactor(sym, rad, h, k, l);
      const b = nuclearStructureFactor(p1, rad, h, k, l);
      expect(Math.hypot(a.re - b.re, a.im - b.im)).toBeLessThan(1e-10 * Math.max(1, Math.hypot(b.re, b.im)));
    }
  });

  it("G(r) matches point-for-point (pair widths use the rotated tensors)", () => {
    const rGrid = makeRGrid(0.5, 12, 0.02);
    const params = { scatteringType: "neutron" as const, scale: 1, qdamp: 0, qbroad: 0, delta1: 0, delta2: 0 };
    const gSym = computeGofR(CELL, expandStructureAtoms(symmetric()), rGrid, params);
    const gP1 = computeGofR(CELL, expandStructureAtoms(p1Twin()), rGrid, params);
    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < rGrid.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(gSym[i]! - gP1[i]!));
      peak = Math.max(peak, Math.abs(gP1[i]!));
    }
    expect(maxDiff).toBeLessThan(1e-9 * peak);
  });
});
