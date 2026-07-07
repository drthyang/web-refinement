import { describe, it, expect } from "vitest";
import type { RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { refineStaged } from "@/core/refinement/staged";

/**
 * Toy linear model y = a + b·x fit to noiseless data (a=2, b=3). Two stages
 * unlock `a` then `b`; the driver must free them cumulatively, carry the fitted
 * value forward, and leave a caller-fixed parameter fixed.
 */
function lineProblem(params: readonly RefinementParameter[]): RefinementProblem {
  const xs = [0, 1, 2, 3, 4];
  const obs = Float64Array.from(xs.map((x) => 2 + 3 * x));
  return {
    parameters: params,
    observations: obs,
    weights: Float64Array.from(xs.map(() => 1)),
    calculate: (v) => Float64Array.from(xs.map((x) => (v.a ?? 0) + (v.b ?? 0) * x)),
  };
}

describe("refineStaged", () => {
  it("unlocks parameters cumulatively and recovers the linear fit", () => {
    const params: RefinementParameter[] = [
      { id: "a", label: "a", kind: "background", value: 0, initialValue: 0, fixed: false },
      { id: "b", label: "b", kind: "background", value: 0, initialValue: 0, fixed: false },
    ];
    const out = refineStaged(params, lineProblem, [
      { name: "intercept", select: (p) => p.id === "a" },
      { name: "slope", select: (p) => p.id === "b" },
    ]);

    const a = out.parameters.find((p) => p.id === "a")!;
    const b = out.parameters.find((p) => p.id === "b")!;
    expect(a.value).toBeCloseTo(2, 4);
    expect(b.value).toBeCloseTo(3, 4);
    // Second stage co-refined both (a and b free), not just b.
    expect(out.stages[1]!.freeIds).toEqual(["a", "b"]);
    expect(out.final?.status).toBe("converged");
  });

  it("never frees a caller-fixed parameter", () => {
    const params: RefinementParameter[] = [
      { id: "a", label: "a", kind: "background", value: 2, initialValue: 2, fixed: true },
      { id: "b", label: "b", kind: "background", value: 0, initialValue: 0, fixed: false },
    ];
    const out = refineStaged(params, lineProblem, [
      { name: "all", select: () => true },
    ]);
    // `a` stayed pinned at its caller value; only `b` moved to fit the slope.
    expect(out.parameters.find((p) => p.id === "a")!.value).toBe(2);
    expect(out.parameters.find((p) => p.id === "b")!.value).toBeCloseTo(3, 4);
    expect(out.stages[0]!.freeIds).toEqual(["b"]);
  });
});
