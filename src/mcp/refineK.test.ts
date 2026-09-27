import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { magneticPowderComponents, magneticStage1Parameters } from "@/core/workflow/magneticPowder";
import * as tools from "@/mcp/tools";

/** Refinable k through the agent layer (Track B1 step 6). */
const structure: StructureModel = {
  id: "helix", name: "helix",
  cell: { a: 4, b: 4.6, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
};

describe("build_magnetic_model with refineK", () => {
  it("appends freed k rows and reports them", () => {
    const b = tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.2317], moment: 2, refineK: true });
    expect(b.kRefinement?.parameterIds).toEqual(["prop_k1", "prop_k2", "prop_k3"]);
    expect(b.kRefinement?.freeParameterIds).toEqual(["prop_k1", "prop_k2", "prop_k3"]);
    expect(b.parameters.filter((p) => p.kind === "propagationK").every((p) => !p.fixed)).toBe(true);
    expect(b.bindings.filter((x) => x.kind === "propagationK").map((x) => x.targetKey)).toEqual(["k1", "k2", "k3"]);
  });

  it("holds a self-conjugate k and says why", () => {
    const b = tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.5], refineK: true });
    expect(b.kRefinement?.parameterIds).toEqual([]);
    expect(b.kRefinement?.notes[0]).toMatch(/self-conjugate/);
  });

  it("omits kRefinement unless asked", () => {
    expect(tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.2317] }).kRefinement).toBeUndefined();
  });
});

describe("refine_magnetic_powder moves k", () => {
  it("stage 1 holds the free k rows (and the moments), frees nothing new", () => {
    const b = tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.2317], moment: 2, refineK: true });
    const scale: RefinementParameter = { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false };
    const params = [scale, ...b.parameters.map((p) => ({ ...p, fixed: false }))];
    const stage1 = magneticStage1Parameters(params);
    expect(stage1.filter((p) => p.kind === "propagationK").every((p) => p.fixed)).toBe(true);
    expect(stage1.filter((p) => p.kind === "momentMode").every((p) => p.fixed)).toBe(true);
    expect(stage1.find((p) => p.id === "scale")!.fixed).toBe(false);
  });

  it("recovers k₃ from a 0.02 r.l.u. offset through the staged tool", async () => {
    const truth = tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.2317], moment: 2, refineK: true });
    const nuc: RefinementParameter[] = [
      { id: "scale", label: "s", kind: "scale", value: 20, initialValue: 20, fixed: false, min: 0 },
      { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true, min: 1e-3 },
    ];
    const nucBindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: structure.id },
      { parameterId: "width", kind: "peakWidth", targetId: "pat" },
    ];
    const grid = Array.from({ length: 1200 }, (_, i) => 8 + (i * 112) / 1199);
    const empty: PowderPattern = {
      id: "pat", name: "p", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.8 }, wavelength: 1.8,
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const truthValues: Record<string, number> = { mom_Fe1_0: 2, mom_Fe1_1q: 2 };
    const truthParams = [...nuc, ...truth.parameters.map((p) => ({ ...p, value: truthValues[p.id] ?? (p.kind === "propagationK" ? p.value : 0) }))];
    const sim = magneticPowderComponents(structure, truth.magnetic, empty, truthParams, [...nucBindings, ...truth.bindings]);
    const pattern: PowderPattern = { ...empty, points: empty.points.map((p, i) => ({ x: p.x, yObs: sim.yCalc[i]!, sigma: Math.sqrt(Math.max(sim.yCalc[i]!, 1)) })) };

    const start = tools.build_magnetic_model({ structure, ionLabels: ["Fe1"], k: [0, 0, 0.2517], moment: 1.5, refineK: true });
    const free = new Set(["mom_Fe1_0", "mom_Fe1_1q", "prop_k3"]);
    const startValues: Record<string, number> = { mom_Fe1_0: 1.5, mom_Fe1_1q: 1.5 };
    const params = [...nuc, ...start.parameters.map((p) => ({
      ...p, value: startValues[p.id] ?? (p.kind === "propagationK" ? p.value : 0), fixed: !free.has(p.id),
    }))];
    const out = await tools.refine_magnetic_powder({
      structure, magnetic: start.magnetic, pattern, parameters: params,
      bindings: [...nucBindings, ...start.bindings], profile: { shape: "gaussian" }, maxIterations: 60,
    });
    expect(out.result.parameters.prop_k3).toBeCloseTo(0.2317, 4);
    expect(out.magnetic.propagation[0]![2]).toBeCloseTo(0.2317, 4);
  });
});
