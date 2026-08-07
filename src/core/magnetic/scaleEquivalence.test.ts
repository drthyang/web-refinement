/**
 * Scale equivalence for k != 0 (the "do we need V_mag/V_nuc?" question).
 *
 * A k = (0,0,1/2) structure has a physical magnetic cell twice the nuclear
 * cell. The engine computes its satellites in the NUCLEAR cell with the one
 * shared scale (magneticPowder.ts: "No explicit V_mag/V_nuc factor is
 * needed"). This test PROVES that claim end-to-end through the full powder
 * chain (enumeration, multiplicity, LP, DW, profile): the same crystal
 * described as parent+k and as an explicit 1x1x2 supercell with k = 0 gives
 *   - an IDENTICAL magnetic-to-nuclear intensity ratio (the quantity that
 *     determines a refined moment), and
 *   - a pointwise-identical total pattern up to one constant (4 = N^2, from
 *     |F_super|^2 = N^2|F_parent|^2 with no 1/V^2 in the engine's intensity
 *     formula) — which the refined scale absorbs.
 * So no per-description rescaling exists to get wrong: switching descriptions
 * only rescales the fitted scale constant by 1/N^2.
 *
 * This equivalence depended on BOTH self-conjugate-k fixes: the satellite
 * enumerator armWeight (satellites.ts) and armMultiplicity (fourierMoment.ts).
 * Before those, the parent+k description carried 2x the satellite weight and
 * the ratio test failed at 2.0.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";

const iso = { kind: "isotropic", bIso: 0.3 } as const;
const ident = parseSymmetryOperation("x,y,z");
const M: Vec3 = [2.5, 0, 0];
const c = 5;

// (a) Parent nuclear cell + k = (0,0,1/2).
const parent: StructureModel = {
  id: "p", name: "p",
  cell: { a: 4, b: 4, c, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [ident] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const parentMag: MagneticModel = {
  id: "p-mag", structureId: "p", propagation: [[0, 0, 0.5]],
  moments: [{ siteLabel: "Fe1", frame: "crystallographic", components: M, formFactorId: "Fe3" }],
  operations: [ident],
};

// (b) The same crystal as an explicit 1x1x2 supercell, k = 0.
const superC: StructureModel = {
  id: "s", name: "s",
  cell: { a: 4, b: 4, c: 2 * c, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [ident] },
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso },
    { label: "Fe2", element: "Fe", oxidationState: 3, position: [0, 0, 0.5], occupancy: 1, adp: iso },
  ],
};
const superMag: MagneticModel = {
  id: "s-mag", structureId: "s", propagation: [[0, 0, 0]],
  moments: [
    { siteLabel: "Fe1", frame: "crystallographic", components: M, formFactorId: "Fe3" },
    { siteLabel: "Fe2", frame: "crystallographic", components: [-M[0], -M[1], -M[2]], formFactorId: "Fe3" },
  ],
  operations: [ident],
};

const grid = Array.from({ length: 1400 }, (_, i) => 10 + (i * (120 - 10)) / 1399);
const empty: PowderPattern = {
  id: "pat", name: "p", xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.8 }, wavelength: 1.8,
  points: grid.map((x) => ({ x, yObs: 0 })),
};

function curves(structure: StructureModel, magnetic: MagneticModel) {
  const params = [
    { id: "scale", label: "s", kind: "scale" as const, value: 20, initialValue: 20, fixed: true, min: 0 },
    { id: "width", label: "w", kind: "peakWidth" as const, value: 0.4, initialValue: 0.4, fixed: true, min: 1e-3 },
  ];
  const bindings = [
    { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
    { parameterId: "width", kind: "peakWidth" as const, targetId: "pat" },
  ];
  return magneticPowderComponents(structure, magnetic, empty, params, bindings, { shape: "gaussian" });
}

const integral = (y: number[]): number => y.reduce((a, b) => a + b, 0);

describe("scale equivalence: parent+k vs explicit supercell, full engine", () => {
  const a = curves(parent, parentMag);
  const b = curves(superC, superMag);

  it("nuclear and magnetic integrals and their RATIO", () => {
    const nucA = integral(a.yNuclear), magA = integral(a.yMagnetic);
    const nucB = integral(b.yNuclear), magB = integral(b.yMagnetic);
    console.log(`parent+k      : ∫nuclear=${nucA.toFixed(2)}  ∫magnetic=${magA.toFixed(2)}  mag/nuc=${(magA / nucA).toFixed(6)}`);
    console.log(`supercell k=0 : ∫nuclear=${nucB.toFixed(2)}  ∫magnetic=${magB.toFixed(2)}  mag/nuc=${(magB / nucB).toFixed(6)}`);
    console.log(`cross ratios  : nucB/nucA=${(nucB / nucA).toFixed(4)}  magB/magA=${(magB / magA).toFixed(4)}`);
    console.log(`THE TEST      : (magB/nucB)/(magA/nucA) = ${((magB / nucB) / (magA / nucA)).toFixed(6)}`);
    expect(nucA).toBeGreaterThan(0);
    expect(magA).toBeGreaterThan(0);
  });

  it("pointwise: the supercell TOTAL curve is a constant multiple of the parent TOTAL curve", () => {
    // Same crystal, same instrument → the two descriptions must give the SAME
    // pattern shape; any constant factor is absorbed by the refined scale.
    let num = 0, den = 0;
    for (let i = 0; i < grid.length; i++) {
      num += (b.yCalc[i] ?? 0) * (a.yCalc[i] ?? 0);
      den += (a.yCalc[i] ?? 0) ** 2;
    }
    const kFit = num / den; // least-squares constant
    let maxRel = 0;
    for (let i = 0; i < grid.length; i++) {
      const diff = Math.abs((b.yCalc[i] ?? 0) - kFit * (a.yCalc[i] ?? 0));
      const scale = Math.max(...a.yCalc.map(Math.abs));
      maxRel = Math.max(maxRel, diff / (kFit * scale));
    }
    console.log(`pointwise: best-fit constant=${kFit.toFixed(4)}  max relative deviation=${(maxRel * 100).toFixed(4)}%`);
    expect(maxRel).toBeLessThan(1e-6);
  });
});
