import { describe, it, expect } from "vitest";
import type { RefinementParameter } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { parseTie, resolveTies, applyEqualValueGroups } from "@/core/refinement/constraints";

describe("refinement engine (Levenberg–Marquardt)", () => {
  it("recovers a linear scale factor from synthetic data", () => {
    // y = scale · model, true scale = 2.5. Start at 1.0.
    const model = [1, 4, 9, 16, 25];
    const trueScale = 2.5;
    const observations = Float64Array.from(model.map((m) => trueScale * m));
    const weights = Float64Array.from(model.map(() => 1));

    const parameters: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const problem: RefinementProblem = {
      parameters,
      observations,
      weights,
      calculate: (v) => Float64Array.from(model.map((m) => (v.scale ?? 1) * m)),
    };

    const result = refine(problem);
    expect(result.status).toBe("converged");
    expect(result.parameters.scale).toBeCloseTo(trueScale, 4);
    expect(result.agreement.rWeighted!).toBeLessThan(1e-3);
    expect(result.esd.scale).toBeGreaterThanOrEqual(0);
  });

  it("recovers two parameters of a non-linear model", () => {
    // y = a·exp(b·x); true a=3, b=0.5.
    const xs = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const observations = Float64Array.from(xs.map((x) => 3 * Math.exp(0.5 * x)));
    const weights = Float64Array.from(xs.map(() => 1));
    const parameters: RefinementParameter[] = [
      { id: "a", label: "a", kind: "scale", value: 1, initialValue: 1, fixed: false },
      { id: "b", label: "b", kind: "scale", value: 0.1, initialValue: 0.1, fixed: false },
    ];
    const result = refine(
      {
        parameters,
        observations,
        weights,
        calculate: (v) => Float64Array.from(xs.map((x) => (v.a ?? 1) * Math.exp((v.b ?? 0) * x))),
      },
      { maxIterations: 50 },
    );
    expect(result.parameters.a).toBeCloseTo(3, 3);
    expect(result.parameters.b).toBeCloseTo(0.5, 3);
  });

  it("holds fixed parameters constant", () => {
    const parameters: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: 5, initialValue: 5, fixed: true },
    ];
    const result = refine({
      parameters,
      observations: Float64Array.from([2, 4]),
      weights: Float64Array.from([1, 1]),
      calculate: (v) => Float64Array.from([v.scale ?? 0, 2 * (v.scale ?? 0)]),
    });
    expect(result.parameters.scale).toBe(5);
  });
});

describe("constraints", () => {
  it("parses tie expressions", () => {
    expect(parseTie("= x")).toEqual({ factor: 1, refId: "x", constant: 0 });
    expect(parseTie("= 2*occA")).toEqual({ factor: 2, refId: "occA", constant: 0 });
    expect(parseTie("= -1*occA+1")).toEqual({ factor: -1, refId: "occA", constant: 1 });
  });

  it("resolves a tied occupancy (occB = 1 − occA via -1*occA+1)", () => {
    const params: RefinementParameter[] = [
      { id: "occA", label: "A", kind: "occupancy", value: 0.3, initialValue: 0.3, fixed: false },
      { id: "occB", label: "B", kind: "occupancy", value: 0, initialValue: 0, fixed: true, expression: "= -1*occA+1" },
    ];
    const resolved = resolveTies(params, { occA: 0.3, occB: 0 });
    expect(resolved.occB).toBeCloseTo(0.7, 10);
  });

  it("ties group members equal to the group leader (Phase 8 grouping)", () => {
    const params: RefinementParameter[] = [
      { id: "b1", label: "B1", kind: "bIso", value: 0.5, initialValue: 0.5, fixed: false, group: "Uiso" },
      { id: "b2", label: "B2", kind: "bIso", value: 0.9, initialValue: 0.9, fixed: false, group: "Uiso" },
      { id: "b3", label: "B3", kind: "bIso", value: 0.2, initialValue: 0.2, fixed: false, group: "Uiso" },
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const grouped = applyEqualValueGroups(params);
    // Leader (b1) stays free; b2, b3 tied to b1; scale untouched.
    expect(grouped.find((p) => p.id === "b1")!.expression).toBeUndefined();
    expect(grouped.find((p) => p.id === "b2")!.expression).toBe("= b1");
    expect(grouped.find((p) => p.id === "b3")!.expression).toBe("= b1");
    expect(grouped.find((p) => p.id === "scale")!.expression).toBeUndefined();
    // After resolution all group members share the leader's value.
    const resolved = resolveTies(grouped, { b1: 0.7, b2: 0.9, b3: 0.2, scale: 1 });
    expect(resolved.b2).toBe(0.7);
    expect(resolved.b3).toBe(0.7);
  });
});
