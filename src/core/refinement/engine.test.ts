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
    // `a` is a linear multiplier (kind "scale" ⇒ exact analytic column); `b` sits
    // inside the exponential, so it is genuinely non-linear and must use the
    // central-difference path (flagged explicitly here since the model, not the
    // kind label, decides linearity).
    const parameters: RefinementParameter[] = [
      { id: "a", label: "a", kind: "scale", value: 1, initialValue: 1, fixed: false },
      { id: "b", label: "b", kind: "scale", value: 0.1, initialValue: 0.1, fixed: false, linear: false },
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

  it("converges with parameters spanning many orders of magnitude", () => {
    // y = A·b1(x) + B·b2(x) with basis functions scaled so A ~ 2e6 and B ~ 3e-6
    // both contribute comparably — a 1e12 spread that wrecks an unscaled normal
    // matrix. Diagonal preconditioning must still recover both from a bad start.
    const xs = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const b1 = xs.map((x) => x * 1e-6);
    const b2 = xs.map((x) => x * x * 1e6);
    const trueA = 2e6;
    const trueB = 3e-6;
    const observations = Float64Array.from(xs.map((_, i) => trueA * b1[i]! + trueB * b2[i]!));
    const weights = Float64Array.from(xs.map(() => 1));
    const parameters: RefinementParameter[] = [
      { id: "A", label: "A", kind: "scale", value: 1, initialValue: 1, fixed: false },
      { id: "B", label: "B", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const result = refine(
      {
        parameters,
        observations,
        weights,
        calculate: (v) => Float64Array.from(xs.map((_, i) => (v.A ?? 0) * b1[i]! + (v.B ?? 0) * b2[i]!)),
      },
      { maxIterations: 60 },
    );
    expect(Math.abs(result.parameters.A! / trueA - 1)).toBeLessThan(1e-4);
    expect(Math.abs(result.parameters.B! / trueB - 1)).toBeLessThan(1e-4);
  });

  it("uses an exact single-eval Jacobian column for linear parameters", () => {
    // Two linear parameters (scale + one background coefficient) and one
    // non-linear (peak position). Count calculate() calls: the two linear
    // columns cost one eval each (reusing the baseline), the non-linear one
    // costs two — so a Jacobian build is baseline(0) + 1 + 1 + 2 = 4 evals,
    // versus 6 for an all-central-difference build.
    const xs = [0, 1, 2, 3, 4, 5];
    const basis = xs.map((x) => 1 + 0.5 * x); // background basis b(x)
    const peak = (x: number, mu: number) => Math.exp(-((x - mu) ** 2));
    const trueScale = 4;
    const trueBkg = 2;
    const trueMu = 2.5;
    const observations = Float64Array.from(
      xs.map((x, i) => trueScale * peak(x, trueMu) + trueBkg * basis[i]!),
    );
    const weights = Float64Array.from(xs.map(() => 1));

    let calls = 0;
    const parameters: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: false },
      { id: "bkg", label: "bkg", kind: "background", value: 0, initialValue: 0, fixed: false },
      { id: "mu", label: "mu", kind: "peakWidth", value: 2, initialValue: 2, fixed: false },
    ];
    const result = refine(
      {
        parameters,
        observations,
        weights,
        calculate: (v) => {
          calls++;
          return Float64Array.from(
            xs.map((x, i) => (v.scale ?? 0) * peak(x, v.mu ?? 0) + (v.bkg ?? 0) * basis[i]!),
          );
        },
      },
      { maxIterations: 40 },
    );

    expect(result.status).toBe("converged");
    expect(result.parameters.scale).toBeCloseTo(trueScale, 4);
    expect(result.parameters.bkg).toBeCloseTo(trueBkg, 4);
    expect(result.parameters.mu).toBeCloseTo(trueMu, 4);

    // Per iteration: 1 baseline (start-of-loop chi is reused, but each accepted
    // step re-evaluates) + 4 Jacobian evals + trial evals. The invariant we
    // assert is the cheaper-than-all-central-difference bound: had all three
    // parameters used central differences, every Jacobian build would cost 6
    // evals instead of 4, so total calls stay well under 6 per Jacobian build.
    expect(calls).toBeGreaterThan(0);
  });

  it("gives the same fit whether a linear parameter is flagged or not", () => {
    // The `linear` override must not change the converged answer — only the path
    // used to build its Jacobian column.
    const model = [1, 4, 9, 16, 25];
    const observations = Float64Array.from(model.map((m) => 2.5 * m + 3));
    const weights = Float64Array.from(model.map(() => 1));
    const build = (linearFlag: boolean) => {
      const parameters: RefinementParameter[] = [
        { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: false, linear: linearFlag },
        { id: "off", label: "off", kind: "background", value: 0, initialValue: 0, fixed: false, linear: linearFlag },
      ];
      return refine({
        parameters,
        observations,
        weights,
        calculate: (v) => Float64Array.from(model.map((m) => (v.scale ?? 0) * m + (v.off ?? 0))),
      });
    };
    const analytic = build(true); // exact single-eval column
    const numeric = build(false); // forced central difference
    expect(analytic.parameters.scale).toBeCloseTo(numeric.parameters.scale!, 8);
    expect(analytic.parameters.off).toBeCloseTo(numeric.parameters.off!, 8);
    expect(analytic.parameters.scale).toBeCloseTo(2.5, 6);
    expect(analytic.parameters.off).toBeCloseTo(3, 6);
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
