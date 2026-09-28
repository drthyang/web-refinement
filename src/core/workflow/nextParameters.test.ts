import { describe, it, expect } from "vitest";
import { rankNextParameterGroups } from "@/core/workflow/nextParameters";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";
import { refine } from "@/core/refinement/engine";

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

  function fixture(perturb: (kind: string, value: number) => number, noisy = false) {
    const grid = Array.from({ length: 1500 }, (_, i) => 10 + (i * 80) / 1499);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    // Optional counting noise (√y, seeded) so a converged fit leaves a residual.
    let seed = 4242;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const gauss = (): number => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    pattern = { ...pattern, points: grid.map((x, i) => {
      const y = (sim.yCalc[i] ?? 0) + 15;
      return { x, yObs: noisy ? y + Math.sqrt(y) * gauss() : y };
    }) };
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
    // Converge scale + background first: the seeds alone leave wR ≈ 18 % (the
    // lower-envelope background sits on the Lorentzian tails), which a width
    // group can partly absorb. With noisy data a converged fit has a residual
    // that no group can really reduce.
    const seeded = fixture((_kind, v) => v, true);
    const fit = refine(seeded, { maxIterations: 20 });
    const problem = { ...seeded, parameters: seeded.parameters.map((p) => ({ ...p, value: fit.parameters[p.id] ?? p.value })) };
    const { groups, wrNow } = rankNextParameterGroups(problem);
    expect(wrNow).toBeGreaterThan(0.005); // the noise, ~0.8 %
    for (const g of groups) {
      // Absolute progress is what matters: predicted wR barely moves. Fitting
      // k parameters to noise lowers wR by only ~wR·k/2N ≈ 2·10⁻⁵ here.
      expect(wrNow - g.predictedWr).toBeLessThan(1e-3);
      for (const id of g.parameterIds) {
        const p = problem.parameters.find((q) => q.id === id)!;
        expect(p.fixed).toBe(true);
      }
    }
  });
});
