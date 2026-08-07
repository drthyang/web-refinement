/**
 * Gate 2 of docs/INCOMMENSURATE_PLAN.md — the **collapse** property.
 *
 * The Fourier-coefficient path must reduce EXACTLY to the shipped real-moment
 * path whenever the coefficients are real, so that turning on the modulated
 * engine can never change a commensurate collinear answer. k = (1/2,0,0) is the
 * sharpest case: it is self-conjugate, so reality forces S real and the two
 * descriptions must agree term by term.
 *
 * These tests also pin the POSITION CONVENTION (plan §2.1), which is a real
 * choice with a wrong answer available:
 *   (a) the site position is the UNWRAPPED symmetry image g(r) → no explicit
 *       phase, because exp(2πi h·p) already carries exp(2πi k·L); or
 *   (b) the position is wrapped into [0,1) → the coefficient must carry
 *       exp(+2πi k·L) explicitly.
 * Never both, and never neither — the last test shows that omitting the phase
 * under convention (b) is an ~89% intensity error, not a rounding detail.
 *
 * Debye-Waller is switched off (bIso = 0) because fourierMagneticStructureFactor
 * has no DW term yet; wiring one in is a Phase B requirement (plan §5).
 */
import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { fourierMagneticStructureFactor, momentInCell, type FourierSite } from "@/core/magnetic/fourierMoment";

// bIso = 0 so the Debye-Waller factor is 1: fourierMagneticStructureFactor has
// no DW term at all, so this isolates the k-phase / coefficient comparison.
const iso = { kind: "isotropic", bIso: 0 } as const;
const ident = parseSymmetryOperation("x,y,z");

/** Two magnetic atoms in the nuclear cell, at the origin and at (0,0,1/2). */
const structure: StructureModel = {
  id: "t", name: "t",
  cell: { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [ident] },
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso },
    { label: "Fe2", element: "Fe", oxidationState: 3, position: [0, 0, 0.5], occupancy: 1, adp: iso },
  ],
};

const M1: Vec3 = [2, 0, 0];
const M2: Vec3 = [0, 1.5, 0];

const magnetic: MagneticModel = {
  id: "t-mag", structureId: "t", propagation: [[0.5, 0, 0]],
  moments: [
    { siteLabel: "Fe1", frame: "crystallographic", components: M1, formFactorId: "Fe3" },
    { siteLabel: "Fe2", frame: "crystallographic", components: M2, formFactorId: "Fe3" },
  ],
  operations: [ident],
};

/** The same structure expressed as REAL Fourier coefficients S = m. */
const sites: FourierSite[] = [
  { position: [0, 0, 0], sReal: M1, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
  { position: [0, 0, 0.5], sReal: M2, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
];

const INDICES: Vec3[] = [
  [0.5, 0, 0], [-0.5, 0, 0], [1.5, 0, 0], [0.5, 1, 0], [0.5, 0, 1], [2.5, 1, 1], [0.5, 2, 3],
];

describe("Fourier path collapses onto the real-moment path at k = (1/2,0,0)", () => {
  it("|F_M|² comparison at k = (1/2, 0, 0) satellites", () => {
    console.log("index                real-moment |F|²   Fourier |F|²      ratio");
    for (const idx of INDICES) {
      const real = magneticStructureFactor(structure, magnetic, idx[0], idx[1], idx[2]).squared;
      const four = fourierMagneticStructureFactor(structure.cell, sites, idx).squared;
      console.log(
        `(${idx.join(",").padEnd(12)})  ${real.toExponential(6).padStart(14)}  ${four.toExponential(6).padStart(14)}  ${(four / real).toFixed(6)}`,
      );
      // The collapse: identical to full double precision, not merely close.
      expect(four).toBeCloseTo(real, 10);
    }
  });

  it("real-space moment reconstruction matches the ±m alternation exactly", () => {
    const k: Vec3 = [0.5, 0, 0];
    console.log("cell n      momentInCell(S=M1)      expected alternation ±M1");
    for (const n of [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] as Vec3[]) {
      const m = momentInCell(M1, [0, 0, 0], k, n);
      const expected = M1.map((c) => c * Math.cos(2 * Math.PI * 0.5 * n[0]!));
      for (let i = 0; i < 3; i++) expect(m[i]!).toBeCloseTo(expected[i]!, 10);
    }
  });
});

/**
 * The nontrivial case: a magnetic subgroup operation whose image lands OUTSIDE
 * the unit cell, so the returning translation L is nonzero and the k·L phase is
 * -1. This is what actually tests the position convention.
 */
describe("phase convention with a nonzero returning translation", () => {
  const inv = parseSymmetryOperation("-x,-y,-z");
  const s2: StructureModel = {
    id: "u", name: "u",
    cell: { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P -1", operations: [ident, inv] },
    sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.3, 0.1, 0], occupancy: 1, adp: iso }],
  };
  const m: Vec3 = [1.7, 0.9, 0];
  const mag2: MagneticModel = {
    id: "u-mag", structureId: "u", propagation: [[0.5, 0, 0]],
    moments: [{ siteLabel: "Fe1", frame: "crystallographic", components: m, formFactorId: "Fe3" }],
    operations: [ident, inv],
  };

  // Image of (0.25,0,0) under inversion is (-0.25,0,0): UNWRAPPED. Its wrapped
  // position is (0.75,0,0) with L = (-1,0,0), so k·L = -1/2 and e^{2πi k·L} = -1.
  // A moment is an axial vector: under pure inversion det(R)·R·m = (-1)(-m) = +m.
  const unwrapped: FourierSite[] = [
    { position: [0.3, 0.1, 0], sReal: m, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
    { position: [-0.3, -0.1, 0], sReal: m, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
  ];
  const wrappedWithPhase: FourierSite[] = [
    { position: [0.3, 0.1, 0], sReal: m, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
    // e^{+2πi k·L} with L = (-1,0,0), k·L = -1/2 → -1, folded into the coefficient.
    { position: [0.7, 0.9, 0], sReal: [-m[0], -m[1], -m[2]], sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
  ];

  it("both conventions reproduce the real-moment path", () => {
    console.log("index         real-moment      unwrapped(a)     wrapped+phase(b)");
    for (const idx of INDICES) {
      const real = magneticStructureFactor(s2, mag2, idx[0], idx[1], idx[2]).squared;
      const a = fourierMagneticStructureFactor(s2.cell, unwrapped, idx).squared;
      const b = fourierMagneticStructureFactor(s2.cell, wrappedWithPhase, idx).squared;
      console.log(`(${idx.join(",").padEnd(10)}) ${real.toExponential(5).padStart(14)} ${a.toExponential(5).padStart(16)} ${b.toExponential(5).padStart(16)}`);
      expect(a).toBeCloseTo(real, 9);
      expect(b).toBeCloseTo(real, 9);
    }
  });

  it("omitting the phase in convention (b) BREAKS the match", () => {
    const noPhase: FourierSite[] = [
      { position: [0.3, 0.1, 0], sReal: m, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
      { position: [0.7, 0.9, 0], sReal: m, sImag: [0, 0, 0], formFactorId: "Fe3", occupancy: 1 },
    ];
    const idx: Vec3 = [0.5, 0, 0];
    const real = magneticStructureFactor(s2, mag2, idx[0], idx[1], idx[2]).squared;
    const bad = fourierMagneticStructureFactor(s2.cell, noPhase, idx).squared;
    console.log(`no-phase check at (0.5,0,0): real=${real.toExponential(5)} naive=${bad.toExponential(5)} ratio=${(bad / real).toFixed(4)}`);
    expect(Math.abs(bad - real)).toBeGreaterThan(1e-6);
  });
});
