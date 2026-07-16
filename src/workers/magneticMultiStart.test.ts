import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildProblemForSpec } from "@/workers/runPowder";
import { ComputeClient } from "@/workers/computeClient";

/**
 * Phase 1b/1c (Improvement Plan) — the magnetic powder multi-start / escape path.
 * A synthetic collinear antiferromagnet (P1, k = (0,0,½), one in-plane moment
 * mode) whose pattern is generated from a KNOWN moment, so recovery is measured
 * against ground truth. CI-runnable (no git-ignored data). Worker pooling is
 * inactive under vitest (no `Worker`), so ComputeClient runs fully in-thread and
 * deterministically.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "afm",
  name: "simple AFM",
  cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 0.5];
const TRUE_MOMENT = 3;
const build = buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: TRUE_MOMENT });

const nucParams: RefinementParameter[] = [
  { id: "scale", label: "s", kind: "scale", value: 20, initialValue: 20, fixed: true, min: 0 },
  { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true, min: 1e-3 },
];
const nucBindings: ParameterBinding[] = [
  { parameterId: "scale", kind: "scale", targetId: structure.id },
  { parameterId: "width", kind: "peakWidth", targetId: "pat" },
];
const bindings = [...nucBindings, ...build.bindings];

const grid = Array.from({ length: 900 }, (_, i) => 8 + (i * (110 - 8)) / 899);
const empty: PowderPattern = {
  id: "pat",
  name: "p",
  xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.8 },
  wavelength: 1.8,
  points: grid.map((x) => ({ x, yObs: 0 })),
};

/** Parameters with the moment mode free at `seed` µ_B; nuclear held. */
function paramsWithMoment(seed: number): RefinementParameter[] {
  const mom = build.params.map((p) =>
    p.id === "mom_Fe1_0" ? { ...p, value: seed, initialValue: seed, fixed: false } : { ...p, fixed: true },
  );
  return [...nucParams, ...mom];
}

/** Synthesize a pattern from the true moment (= TRUE_MOMENT). */
function truthPattern(): PowderPattern {
  const truthParams = paramsWithMoment(TRUE_MOMENT);
  const comp = magneticPowderComponents(structure, build.magnetic, empty, truthParams, bindings, { shape: "gaussian" });
  return {
    ...empty,
    points: grid.map((x, i) => ({ x, yObs: comp.yCalc[i] ?? 0, sigma: Math.sqrt(Math.max(comp.yCalc[i] ?? 0, 1)) + 1 })),
  };
}

const momentOf = (values: Record<string, number>): number => {
  const m = applyMagneticMoments(build.magnetic, build.bindings, values).moments[0]!.components as Vec3;
  return Math.hypot(...m);
};

describe("refineMagneticPowderMultiStart — synthetic AFM", () => {
  const pat = truthPattern();
  const spec = { structure, magnetic: build.magnetic, pattern: pat, bindings, shape: "gaussian" as const };

  it("recovers the true moment from a bad cold start", async () => {
    const client = new ComputeClient();
    const ms = await client.refineMagneticPowderMultiStart(
      { ...spec, parameters: paramsWithMoment(0.3) }, // 0.3 µ_B vs true 3
      { restarts: 8, seed: 1 },
      { maxIterations: 40 },
    );
    expect(momentOf(ms.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    // Synthetic data ⇒ the model fits itself essentially perfectly.
    expect(ms.final.agreement.rWeighted ?? 1).toBeLessThan(0.02);
    client.dispose();
  });

  it("is deterministic — same seed ⇒ identical converged parameters", async () => {
    const client = new ComputeClient();
    const opts = [{ ...spec, parameters: paramsWithMoment(0.5) }, { restarts: 6, seed: 42 }, { maxIterations: 40 }] as const;
    const a = await client.refineMagneticPowderMultiStart(...opts);
    const b = await client.refineMagneticPowderMultiStart(...opts);
    expect(b.final.parameters).toEqual(a.final.parameters);
    expect(b.costByStart).toEqual(a.costByStart);
    client.dispose();
  });

  it("canonicalizes the global ±m sign — a negative start lands on the same (positive) moment", async () => {
    const client = new ComputeClient();
    const pos = await client.refineMagneticPowderMultiStart({ ...spec, parameters: paramsWithMoment(2) }, { restarts: 4, seed: 3 }, { maxIterations: 40 });
    const neg = await client.refineMagneticPowderMultiStart({ ...spec, parameters: paramsWithMoment(-2) }, { restarts: 4, seed: 3 }, { maxIterations: 40 });
    // Both magnitudes recover; the canonical sign makes the reported mode value
    // agree (a global flip of the whole moment set is diffraction-equivalent).
    expect(momentOf(pos.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    expect(momentOf(neg.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    expect(Math.sign(neg.final.parameters["mom_Fe1_0"]!)).toBe(Math.sign(pos.final.parameters["mom_Fe1_0"]!));
    client.dispose();
  });

  it("threads the fit range through the multi-start seam (specWith → buildProblemForSpec)", () => {
    // Every restart and the final joint build their problem via
    // buildProblemForSpec(specWith(...)), which spreads the caller's fitRange.
    // Regression for the memory note that fitRange was dropped on magnetic paths:
    // a windowed magneticPowder spec must zero the weight of out-of-window points.
    const lo = grid[Math.floor(grid.length * 0.3)]!;
    const hi = grid[Math.floor(grid.length * 0.7)]!;
    const problem = buildProblemForSpec({
      kind: "magneticPowder",
      ...spec,
      parameters: paramsWithMoment(0.2),
      fitRange: { min: lo, max: hi },
    });
    let insideNonZero = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]! < lo || grid[i]! > hi) expect(problem.weights[i]).toBe(0);
      else if (problem.weights[i]! > 0) insideNonZero++;
    }
    expect(insideNonZero).toBeGreaterThan(0);
    // No window ⇒ every point retains a non-zero weight.
    const noWindow = buildProblemForSpec({ kind: "magneticPowder", ...spec, parameters: paramsWithMoment(0.2) });
    expect(Array.from(noWindow.weights).some((w) => w === 0)).toBe(false);
  });
});
