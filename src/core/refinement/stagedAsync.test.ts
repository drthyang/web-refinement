import { describe, it, expect } from "vitest";
import { refineStaged, refineStagedAsync } from "@/core/refinement/staged";
import { stagesFromKindGroups, DEFAULT_STAGE_KINDS } from "@/core/workflow/structureRefinement";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * refineStagedAsync mirrors refineStaged's loop with an injectable refiner —
 * given the serial refiner it must produce identical results (values, esds,
 * per-stage records). This is the contract that lets the staged sequence run
 * each stage through the parallel evaluator pool without an accuracy question.
 */
describe("refineStagedAsync ≡ refineStaged", () => {
  it("identical staged results with the serial refiner", async () => {
    const structure = exampleStructure();
    const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 0.2, v: -0.04, w: 0.02, x: 0.3, y: 0.05 };
    const grid = Array.from({ length: 900 }, (_, i) => 10 + (i * 80) / 899);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 25 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const params = spec.params.map((p) => ({ ...p, value: p.kind === "scale" ? 8 : p.value }));
    const stages = stagesFromKindGroups(DEFAULT_STAGE_KINDS);
    const build = (ps: readonly typeof params[number][]) =>
      buildPowderProblem(structure, pattern, ps, spec.bindings, spec.profile);

    const a = refineStaged(params, build, stages, { maxIterations: 6 });
    const b = await refineStagedAsync(params, build, stages, { maxIterations: 6 });

    expect(b.stages.length).toBe(a.stages.length);
    for (let i = 0; i < a.stages.length; i++) {
      expect(b.stages[i]!.name).toBe(a.stages[i]!.name);
      expect(b.stages[i]!.freeIds).toEqual(a.stages[i]!.freeIds);
      expect(Object.is(b.stages[i]!.result.agreement.rWeighted, a.stages[i]!.result.agreement.rWeighted)).toBe(true);
    }
    for (let j = 0; j < a.parameters.length; j++) {
      expect(Object.is(b.parameters[j]!.value, a.parameters[j]!.value), a.parameters[j]!.id).toBe(true);
    }
    expect(b.final?.status).toBe(a.final?.status);
  });
});
