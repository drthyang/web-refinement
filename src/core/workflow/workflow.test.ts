import { describe, it, expect } from "vitest";
import type { SingleCrystalDataset, PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import {
  buildSingleCrystalProblem,
  singleCrystalComparison,
} from "@/core/workflow/singleCrystal";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { exampleStructure } from "@/examples/mn3ga";

// Uses the embedded example structure (identical to the bundled 600 K CIF), so
// this engine test runs without the git-ignored data/ folder.
const model = exampleStructure();
const neutron = { kind: "neutron" as const, wavelength: 1.54 };

describe("single-crystal workflow — self-consistent refinement", () => {
  // Build a synthetic reflection list from the model at a known scale, then
  // check the engine recovers that scale from a wrong start.
  const trueScale = 3.2;
  const baseParams: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: trueScale, initialValue: trueScale, fixed: false },
  ];
  const bindings: ParameterBinding[] = [{ parameterId: "scale", kind: "scale", targetId: "data" }];
  const hkls: Array<[number, number, number]> = [[1, 0, 0], [1, 1, 0], [0, 0, 2], [1, 0, 1], [2, 0, 0]];

  const truth = singleCrystalComparison(
    model,
    { id: "data", name: "d", radiation: neutron, reflections: hkls.map(([h, k, l]) => ({ h, k, l, iObs: 0 })) },
    baseParams,
    bindings,
  );
  const dataset: SingleCrystalDataset = {
    id: "data",
    name: "synthetic",
    radiation: neutron,
    reflections: truth.map((t) => ({ h: t.h, k: t.k, l: t.l, iObs: t.iCalc, sigma: Math.sqrt(Math.abs(t.iCalc)) + 1 })),
  };

  it("recovers the scale factor", () => {
    const params: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const problem = buildSingleCrystalProblem(model, dataset, params, bindings);
    const result = refine(problem);
    expect(result.parameters.scale).toBeCloseTo(trueScale, 2);
    expect(result.agreement.rFactor).toBeLessThan(0.01);
  });
});

describe("powder workflow — pattern synthesis and refinement", () => {
  // Synthesize a two-theta pattern from the model, then refine the scale back.
  const twoThetaGrid = Array.from({ length: 400 }, (_, i) => 10 + (i * 90) / 400);
  const trueScale = 100;
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "pat" },
    { parameterId: "width", kind: "peakWidth", targetId: "pat" },
  ];
  const truthParams: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: trueScale, initialValue: trueScale, fixed: false },
    { id: "width", label: "width", kind: "peakWidth", value: 0.4, initialValue: 0.4, fixed: true },
  ];
  const emptyPattern: PowderPattern = {
    id: "pat", name: "p", xUnit: "twoTheta", radiation: neutron,
    points: twoThetaGrid.map((x) => ({ x, yObs: 0 })), wavelength: 1.54,
  };
  const curves = powderCurves(model, emptyPattern, truthParams, bindings);
  const pattern: PowderPattern = {
    ...emptyPattern,
    points: twoThetaGrid.map((x, i) => ({ x, yObs: curves.yCalc[i]! })),
  };

  it("produces a non-trivial calculated pattern", () => {
    expect(Math.max(...curves.yCalc)).toBeGreaterThan(0);
  });

  it("recovers the scale factor from a wrong start", () => {
    const params: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: 30, initialValue: 30, fixed: false },
      { id: "width", label: "width", kind: "peakWidth", value: 0.4, initialValue: 0.4, fixed: true },
    ];
    const problem = buildPowderProblem(model, pattern, params, bindings);
    const result = refine(problem, { maxIterations: 30 });
    expect(result.parameters.scale).toBeCloseTo(trueScale, 0);
  });
});
