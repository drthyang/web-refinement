import { describe, it, expect } from "vitest";
import { rankNextParameterGroups } from "@/core/workflow/nextParameters";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * F1.5 — the next-parameter diagnostic must point at the group that actually
 * carries the model error: perturb ONE truth (cell, then B) and require that
 * group to rank first among the fixed candidates.
 */
describe("rankNextParameterGroups", () => {
  const structure = exampleStructure();
  // Realistic peak widths (FWHM ~0.15°): the ranking is a LOCAL probe, valid
  // when displacements are sub-FWHM.
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };

  function fixture(perturb: (kind: string, value: number) => number) {
    const grid = Array.from({ length: 1500 }, (_, i) => 10 + (i * 80) / 1499);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 15 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    // The realistic agent state: scale + background already FREE (converged),
    // every structural/profile group fixed; the model perturbed in one group.
    const params = spec.params.map((p) => ({
      ...p,
      fixed: !(p.kind === "scale" || p.kind === "background"),
      value: perturb(p.kind, p.kind === "scale" ? 4 : p.value),
    }));
    return buildPowderProblem(structure, pattern, params, spec.bindings, spec.profile);
  }

  it("a wrong cell ranks the cell group first", () => {
    const problem = fixture((kind, v) => (kind === "cellLength" ? v * 1.001 : v));
    const { groups, chiSquared } = rankNextParameterGroups(problem);
    expect(chiSquared).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(2);
    expect(groups[0]!.group).toBe("cell");
    expect(groups[0]!.expectedRelativeImprovement).toBeGreaterThan(0.5);
  });

  it("a wrong B_iso ranks the ADP group first", () => {
    const problem = fixture((kind, v) => (kind === "bIso" ? v + 2.5 : v));
    const { groups } = rankNextParameterGroups(problem);
    expect(groups[0]!.group).toBe("ADP");
    expect(groups[0]!.expectedRelativeImprovement).toBeGreaterThan(0.3);
  });

  it("free parameters are not probed; a converged model promises no real wR gain", () => {
    const problem = fixture((_kind, v) => v);
    const { groups, wrNow } = rankNextParameterGroups(problem);
    for (const g of groups) {
      // Absolute progress is what matters: predicted wR barely moves.
      expect(wrNow - g.predictedWr).toBeLessThan(0.005);
      for (const id of g.parameterIds) {
        const p = problem.parameters.find((q) => q.id === id)!;
        expect(p.fixed).toBe(true);
      }
    }
  });
});
