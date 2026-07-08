import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { buildSyntheticPowder, powderBindings, powderParameters } from "@/examples/synthetic";
import { buildPowderProblem } from "@/core/workflow/powder";

/**
 * A selected fit range must actually exclude out-of-window data from the fit:
 * buildPowderProblem zeroes the least-squares weight of every point outside the
 * inclusive [min, max] window, so those points contribute nothing to the
 * residual (they are shown but not fitted).
 */
describe("buildPowderProblem fit range", () => {
  const structure = exampleStructure();
  const pattern = buildSyntheticPowder(structure);
  const params = powderParameters(structure);
  const bindings = powderBindings(structure, pattern.id);
  const xs = pattern.points.map((p) => p.x);
  const lo = xs[Math.floor(xs.length * 0.3)]!;
  const hi = xs[Math.floor(xs.length * 0.7)]!;

  it("zeroes the weight of points outside the window and keeps them inside", () => {
    const problem = buildPowderProblem(structure, pattern, params, bindings, { shape: "gaussian" }, [], {
      min: lo,
      max: hi,
    });
    let insideNonZero = 0;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i]! < lo || xs[i]! > hi) {
        expect(problem.weights[i]).toBe(0); // excluded ⇒ not fitted
      } else if (problem.weights[i]! > 0) {
        insideNonZero++;
      }
    }
    // The window still carries real, fitted observations.
    expect(insideNonZero).toBeGreaterThan(0);
  });

  it("leaves all weights intact when no window is given", () => {
    const problem = buildPowderProblem(structure, pattern, params, bindings, { shape: "gaussian" });
    const anyZero = Array.from(problem.weights).some((w) => w === 0);
    expect(anyZero).toBe(false);
  });
});
