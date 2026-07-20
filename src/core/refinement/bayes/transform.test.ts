import { describe, it, expect } from "vitest";
import {
  logJacobian,
  planTransforms,
  toBounded,
  toUnbounded,
  type TransformSpec,
} from "@/core/refinement/bayes/transform";
import type { RefinementParameter } from "@/core/refinement/types";

const param = (over: Partial<RefinementParameter>): RefinementParameter => ({
  id: "p",
  label: "p",
  kind: "pdfScale",
  value: 0.5,
  initialValue: 0.5,
  fixed: false,
  ...over,
});

describe("bayes transforms", () => {
  it("plans logit for two-sided, log for one-sided, identity for unbounded", () => {
    const specs = planTransforms([
      param({ min: 0, max: 1 }),
      param({ min: 0 }),
      param({ max: 5 }),
      param({}),
    ]);
    expect(specs.map((t) => t.kind)).toEqual(["logit", "logLower", "logUpper", "identity"]);
  });

  it("round-trips bounded → unbounded → bounded to 1e-12", () => {
    const cases: [number, TransformSpec][] = [
      [0.3, { kind: "logit", min: 0, max: 1 }],
      [9.87, { kind: "logit", min: 9, max: 11 }],
      [2.5, { kind: "logLower", min: 0 }],
      [-3.2, { kind: "logUpper", max: 0 }],
      [17, { kind: "identity" }],
    ];
    for (const [x, t] of cases) {
      expect(Math.abs(toBounded(toUnbounded(x, t), t) - x)).toBeLessThan(1e-12 * Math.max(1, Math.abs(x)));
    }
  });

  it("keeps values sitting exactly on a bound finite", () => {
    const t: TransformSpec = { kind: "logit", min: 0, max: 1 };
    expect(Number.isFinite(toUnbounded(0, t))).toBe(true);
    expect(Number.isFinite(toUnbounded(1, t))).toBe(true);
  });

  it("logJacobian matches a finite difference of the unbounded→bounded map", () => {
    const cases: [number, TransformSpec][] = [
      [0.7, { kind: "logit", min: 0, max: 1 }],
      [-2.1, { kind: "logit", min: 9, max: 11 }],
      [1.3, { kind: "logLower", min: 0.5 }],
      [-0.4, { kind: "logUpper", max: 3 }],
      [5, { kind: "identity" }],
    ];
    const h = 1e-6;
    for (const [q, t] of cases) {
      const fd = (toBounded(q + h, t) - toBounded(q - h, t)) / (2 * h);
      const analytic = Math.exp(logJacobian(q, t)) * (t.kind === "logUpper" ? -1 : 1);
      // logJacobian is log|dx/dq|; compare magnitudes.
      expect(Math.abs(Math.abs(analytic) - Math.abs(fd)) / Math.abs(fd)).toBeLessThan(1e-6);
    }
  });
});
