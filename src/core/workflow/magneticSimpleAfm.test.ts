import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticPowderComponents, buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";

/**
 * Simple-case physics validation: a collinear antiferromagnet — one magnetic ion
 * with propagation vector k = (0,0,½) (moments alternate along c) and the moment
 * in-plane (⊥ the c-axis satellites, so it scatters fully). The magnetic
 * satellites appear at (h k l±½) — positions with NO nuclear peak — and a
 * refinement must recover the moment magnitude from a wrong start.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "afm", name: "simple AFM",
  cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 0.5];
const build = buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: 3 });

const nucParams = [
  { id: "scale", label: "s", kind: "scale" as const, value: 20, initialValue: 20, fixed: true, min: 0 },
  { id: "width", label: "w", kind: "peakWidth" as const, value: 0.5, initialValue: 0.5, fixed: true, min: 1e-3 },
];
const nucBindings = [
  { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
  { parameterId: "width", kind: "peakWidth" as const, targetId: "pat" },
];
// The moment amplitude (mom_Fe1_0 = the x-mode) is the one free magnetic parameter.
const momParams = build.params.map((p) => (p.id === "mom_Fe1_0" ? { ...p, value: 3, initialValue: 3, fixed: false } : { ...p, fixed: true }));
const params = [...nucParams, ...momParams];
const bindings = [...nucBindings, ...build.bindings];

const grid = Array.from({ length: 900 }, (_, i) => 8 + (i * (110 - 8)) / 899);
const empty: PowderPattern = {
  id: "pat", name: "p", xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.8 }, wavelength: 1.8,
  points: grid.map((x) => ({ x, yObs: 0 })),
};

describe("magnetic refinement — simple antiferromagnet (k = (0,0,½))", () => {
  const truth = magneticPowderComponents(structure, build.magnetic, empty, params, bindings, { shape: "gaussian" });

  it("produces magnetic satellite intensity", () => {
    expect(Math.max(...truth.yMagnetic)).toBeGreaterThan(0);
  });

  it("puts a magnetic satellite where there is no nuclear peak", () => {
    // The (0,0,½) satellite: d = 2c = 10 Å → 2θ = 2·asin(λ/2d) ≈ 10.35°.
    const twoTheta = 2 * Math.asin(1.8 / (2 * 10)) * (180 / Math.PI);
    const idx = grid.findIndex((x) => Math.abs(x - twoTheta) < 0.6);
    expect(idx).toBeGreaterThan(0);
    // Magnetic intensity is present there; the nuclear pattern is ~flat/background.
    expect(truth.yMagnetic[idx]!).toBeGreaterThan(0.01 * Math.max(...truth.yMagnetic));
  });

  it("recovers the moment magnitude from a wrong start", () => {
    const pat: PowderPattern = {
      ...empty,
      points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i] ?? 0, sigma: Math.sqrt(Math.max(truth.yCalc[i] ?? 0, 1)) + 1 })),
    };
    const start = params.map((p) => (p.id === "mom_Fe1_0" ? { ...p, value: 1 } : p)); // 1 µ_B vs true 3
    const problem = buildMagneticPowderProblem(structure, build.magnetic, pat, start, bindings, { shape: "gaussian" });
    const result = refine(problem, { maxIterations: 40 });
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.03);
    // |F_M|² ∝ moment², so the sign is undetermined — recover the magnitude.
    expect(Math.abs(result.parameters.mom_Fe1_0 ?? 0)).toBeCloseTo(3, 1);
  });
});
