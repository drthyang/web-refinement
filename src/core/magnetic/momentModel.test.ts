import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";

const identity = parseSymmetryOperation("x,y,z");
const iso = { kind: "isotropic", bIso: 0.4 } as const;

const p1Fe: StructureModel = {
  id: "t",
  name: "t",
  cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [identity] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }],
};

describe("buildMagneticModel (symmetry-allowed moment modes)", () => {
  it("emits one fixed momentMode parameter per allowed direction", () => {
    const build = buildMagneticModel(p1Fe, [0, 0, 0.5], ["Fe1"], [identity], { moment: 2 });
    // General position under P1 → all three components free.
    const modes = build.params.filter((p) => p.kind === "momentMode");
    expect(modes).toHaveLength(3);
    expect(modes.every((p) => p.fixed)).toBe(true); // shown but fixed on build
    expect(build.activeSites).toEqual(["Fe1"]);
    expect(build.magnetic.propagation).toEqual([[0, 0, 0.5]]);
    // Seed: first mode at the requested magnitude, rest zero.
    expect(build.magnetic.moments[0]!.components).toEqual([2, 0, 0]);
    expect(build.magnetic.moments[0]!.formFactorId).toBe("Fe3");
  });

  it("reconstructs the moment as Σ amplitude·basis via momentMode bindings", () => {
    const build = buildMagneticModel(p1Fe, [0, 0, 0], ["Fe1"], [identity]);
    const values: Record<string, number> = { mom_Fe1_0: 2, mom_Fe1_1: 1, mom_Fe1_2: 0.5 };
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    expect(applied.moments[0]!.components).toEqual([2, 1, 0.5]);
  });

  it("skips a site whose moment is symmetry-forbidden", () => {
    // A *primed* inversion centre (1', θ=−1) AT the site forbids any moment:
    // an axial vector is even under inversion, so det(R)·θ·R·m = −m ⇒ m = 0.
    // (A plain inversion, θ=+1, would leave the moment free — it is not a bug.)
    const invPrime = { ...parseSymmetryOperation("-x,-y,-z"), timeReversal: -1 as const };
    const atOrigin: StructureModel = { ...p1Fe, sites: [{ ...p1Fe.sites[0]!, position: [0, 0, 0] }] };
    const build = buildMagneticModel(atOrigin, [0, 0, 0], ["Fe1"], [identity, invPrime]);
    expect(build.activeSites).toEqual([]);
    expect(build.params).toHaveLength(0);
  });
});

describe("shared nuclear/magnetic scale (GSAS-II convention)", () => {
  const { structure, magnetic } = exampleMagnetic();
  const grid = Array.from({ length: 400 }, (_, i) => 10 + (i * 100) / 400);
  const neutron = { kind: "neutron" as const, wavelength: 1.54 };
  const pat: PowderPattern = { id: "pat", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: grid.map((x) => ({ x, yObs: 0 })) };
  const momentBindings = magneticBindings(magnetic).filter((b) => b.kind === "momentX" || b.kind === "momentY" || b.kind === "momentZ");
  const momentParams = magneticParameters(magnetic).filter((p) => p.kind === "momentX" || p.kind === "momentY" || p.kind === "momentZ").map((p) => ({ ...p, fixed: true }));

  const componentsAt = (scale: number) => {
    const params: RefinementParameter[] = [
      { id: "sN", label: "sN", kind: "scale", value: scale, initialValue: scale, fixed: true },
      ...momentParams,
      { id: "w", label: "w", kind: "peakWidth", value: 0.6, initialValue: 0.6, fixed: true },
    ];
    const bindings: ParameterBinding[] = [
      { parameterId: "sN", kind: "scale", targetId: structure.id },
      ...momentBindings,
      { parameterId: "w", kind: "peakWidth", targetId: "pat" },
    ];
    return magneticPowderComponents(structure, magnetic, pat, params, bindings);
  };

  it("scales the magnetic component by the nuclear scale (no separate magnetic scale)", () => {
    const c1 = componentsAt(1);
    const c2 = componentsAt(2);
    const magMax1 = Math.max(...c1.yMagnetic);
    const magMax2 = Math.max(...c2.yMagnetic);
    expect(magMax1).toBeGreaterThan(0);
    expect(magMax2 / magMax1).toBeCloseTo(2, 5); // magnetic follows the shared scale
    // Nuclear follows the same scale, so their ratio is preserved.
    expect(Math.max(...c2.yNuclear) / Math.max(...c1.yNuclear)).toBeCloseTo(2, 5);
  });
});
