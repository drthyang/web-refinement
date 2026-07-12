import { describe, it, expect } from "vitest";
import { refine, refineParallel, type BatchEvaluator, type RefinementProblem } from "@/core/refinement/engine";
import { exampleStructure } from "@/examples/mn3ga";
import { buildPowderSpec } from "@/app/powderSpec";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * The parallel driver must be a pure re-plumbing of the SAME generator core:
 * for any faithful evaluator (one returning exactly what `problem.calculate`
 * returns, in order), `refineParallel` is required to produce a bit-identical
 * trajectory to `refine` — same parameter values, same esds, same history,
 * same diagnostics. This is the contract that lets a Web Worker pool replace
 * serial evaluation without any accuracy question.
 */
describe("refineParallel ≡ refine", () => {
  const structure = exampleStructure();
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 0.2, v: -0.04, w: 0.02, x: 0.3, y: 0.05 };

  function makeProblem(): RefinementProblem {
    const grid = Array.from({ length: 1200 }, (_, i) => 10 + (i * 80) / 1199);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const truth = spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p));
    const sim = powderCurves(structure, pattern, truth, spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 30 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    // Free a mixed set: linear (scale, background), geometry (cell, B), profile.
    const params = spec.params.map((p) => {
      if (p.kind === "scale") return { ...p, value: 9, fixed: false };
      if (p.kind === "bIso") return { ...p, value: 1.2, fixed: false };
      if (p.kind === "cellLength") return { ...p, value: p.value * 1.0005, fixed: false };
      if (p.kind === "background") return { ...p, fixed: false };
      if (p.kind === "profileW") return { ...p, fixed: false };
      return { ...p, fixed: true };
    });
    return buildPowderProblem(structure, pattern, params, spec.bindings, spec.profile);
  }

  it("a faithful async evaluator reproduces the serial trajectory bit-for-bit", async () => {
    // Two independent problem instances (each with its own geometry cache).
    const serialProblem = makeProblem();
    const parallelProblem = makeProblem();
    // A replica problem, as a worker would hold: built from the same inputs.
    const replica = makeProblem();
    const evaluator: BatchEvaluator = {
      // Deliberately out-of-order internally, restored by index — a pool
      // returns columns as workers finish, not in submission order.
      evaluate: async (sets) => {
        const indexed = sets.map((values, i) => ({ i, values })).reverse();
        const out = new Array<Float64Array>(sets.length);
        for (const { i, values } of indexed) out[i] = replica.calculate(values);
        return out;
      },
    };

    const a = refine(serialProblem, { maxIterations: 12 });
    const b = await refineParallel(parallelProblem, { maxIterations: 12 }, evaluator);

    expect(b.status).toBe(a.status);
    expect(b.history.length).toBe(a.history.length);
    for (let i = 0; i < a.history.length; i++) {
      expect(Object.is(b.history[i]!.chiSquared, a.history[i]!.chiSquared),
        `iteration ${i}: χ² ${b.history[i]!.chiSquared} !== ${a.history[i]!.chiSquared}`).toBe(true);
    }
    for (const id of Object.keys(a.parameters)) {
      expect(Object.is(b.parameters[id], a.parameters[id]), `parameter ${id}`).toBe(true);
      expect(Object.is(b.esd[id], a.esd[id]), `esd ${id}`).toBe(true);
    }
    expect(b.agreement).toEqual(a.agreement);
    expect(b.diagnostics?.conditionNumber).toBe(a.diagnostics?.conditionNumber);
  });
});
