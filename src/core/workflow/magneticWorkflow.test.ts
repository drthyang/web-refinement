import { describe, it, expect } from "vitest";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import {
  buildMagneticSingleCrystalProblem,
  magneticComparison,
} from "@/core/workflow/magnetic";
import { exampleMagnetic } from "@/examples/mn3gaMagnetic";

// Uses the embedded 30 K magnetic example (identical to the mCIF), so this
// engine test runs without the git-ignored data/ folder.
const { structure, magnetic } = exampleMagnetic();
const neutron = { kind: "neutron" as const, wavelength: 1.54 };

describe("magnetic single-crystal workflow", () => {
  if (!magnetic) throw new Error("expected a magnetic model");

  // Reflections including magnetic ones; iObs filled from the model below.
  const hkls: Array<[number, number, number]> = [
    [1, 0, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [2, 0, 0], [0, 1, 1],
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "scaleN", kind: "scale", targetId: "d" },
    { parameterId: "scaleM", kind: "magneticScale", targetId: "d" },
    { parameterId: "mMn1x", kind: "momentX", targetId: magnetic.id, targetKey: "Mn1_0" },
    { parameterId: "mMn1z", kind: "momentZ", targetId: magnetic.id, targetKey: "Mn1_0" },
  ];

  it("reports nuclear and magnetic contributions separately", () => {
    const params: RefinementParameter[] = [
      { id: "scaleN", label: "scaleN", kind: "scale", value: 1, initialValue: 1, fixed: true },
      { id: "scaleM", label: "scaleM", kind: "magneticScale", value: 1, initialValue: 1, fixed: true },
    ];
    const dataset: SingleCrystalDataset = {
      id: "d", name: "d", radiation: neutron,
      reflections: hkls.map(([h, k, l]) => ({ h, k, l, iObs: 0 })),
    };
    const rows = magneticComparison(structure, magnetic, dataset, params, bindings);
    // At least one reflection carries magnetic intensity.
    expect(rows.some((r) => r.iMagnetic > 1e-6)).toBe(true);
    // Total is the sum of the two contributions.
    for (const r of rows) expect(r.iTotal).toBeCloseTo(r.iNuclear + r.iMagnetic, 8);
  });

  it("recovers a perturbed moment component from synthetic data", () => {
    // Truth: the CIF moment. Build observed intensities, then refine one
    // component back from a wrong start.
    const truthParams: RefinementParameter[] = [
      { id: "scaleN", label: "scaleN", kind: "scale", value: 1, initialValue: 1, fixed: true },
      { id: "scaleM", label: "scaleM", kind: "magneticScale", value: 1, initialValue: 1, fixed: true },
      { id: "mMn1x", label: "Mn1 x", kind: "momentX", value: -1.577, initialValue: -1.577, fixed: false },
      { id: "mMn1z", label: "Mn1 z", kind: "momentZ", value: -1.349, initialValue: -1.349, fixed: false },
    ];
    const truthDataset: SingleCrystalDataset = {
      id: "d", name: "d", radiation: neutron,
      reflections: hkls.map(([h, k, l]) => ({ h, k, l, iObs: 0 })),
    };
    const truthRows = magneticComparison(structure, magnetic, truthDataset, truthParams, bindings);
    const dataset: SingleCrystalDataset = {
      id: "d", name: "d", radiation: neutron,
      reflections: truthRows.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: r.iTotal, sigma: Math.sqrt(Math.abs(r.iTotal)) + 0.1 })),
    };
    const startParams: RefinementParameter[] = truthParams.map((p) =>
      p.id === "mMn1x" ? { ...p, value: -0.8 } : p.id === "mMn1z" ? { ...p, value: -0.8 } : p,
    );
    const problem = buildMagneticSingleCrystalProblem(structure, magnetic, dataset, startParams, bindings);
    const result = refine(problem, { maxIterations: 40 });
    // Magnitude of the recovered (x,z) should match the truth magnitude.
    const recX = result.parameters.mMn1x!;
    const recZ = result.parameters.mMn1z!;
    expect(Math.hypot(recX, recZ)).toBeCloseTo(Math.hypot(-1.577, -1.349), 1);
    expect(result.agreement.rFactor).toBeLessThan(0.05);
  });
});
