import { describe, it, expect } from "vitest";
import { assessRefinement, suggestNextSteps } from "@/core/diagnostics/assessment";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";

function param(id: string, kind: RefinementParameter["kind"], value: number, extra: Partial<RefinementParameter> = {}): RefinementParameter {
  return { id, label: id, kind, value, initialValue: value, fixed: false, ...extra };
}

function result(over: Partial<Omit<RefinementResult, "agreement">> & { agreement?: Partial<RefinementResult["agreement"]> } = {}): RefinementResult {
  const { agreement, ...rest } = over;
  return {
    status: "converged",
    parameters: {},
    esd: {},
    agreement: { rFactor: 0.05, rWeighted: 0.07, rExpected: 0.06, goodnessOfFit: 1.17, ...agreement },
    history: [],
    ...rest,
  };
}

describe("assessRefinement — fit verdict", () => {
  it("GoF ~1.2 with no diagnostics reads as an excellent, issue-free fit", () => {
    const a = assessRefinement({ result: result(), parameters: [param("scale", "scale", 1)], observationCount: 4000 });
    expect(a.verdict.band).toBe("excellent");
    expect(a.findings).toHaveLength(0);
    expect(a.summary).toMatch(/EXCELLENT/);
    expect(a.summary).toMatch(/no issues/);
  });

  it("GoF < 1 is flagged as 'too good' (fair), not green", () => {
    const a = assessRefinement({ result: result({ agreement: { goodnessOfFit: 0.6 } }), parameters: [param("scale", "scale", 1)], observationCount: 4000 });
    expect(a.verdict.band).toBe("fair");
    expect(a.verdict.rationale).toMatch(/too good|over-parameterized|overestimated/i);
  });

  it("a high GoF reads as poor", () => {
    const a = assessRefinement({ result: result({ agreement: { goodnessOfFit: 5.2 } }), parameters: [param("scale", "scale", 1)], observationCount: 4000 });
    expect(a.verdict.band).toBe("poor");
  });

  it("a diverged run is unreliable regardless of wR", () => {
    const a = assessRefinement({ result: result({ status: "diverged" }), parameters: [param("scale", "scale", 1)], observationCount: 4000 });
    expect(a.verdict.band).toBe("unreliable");
    expect(a.findings.some((f) => f.category === "convergence" && f.severity === "critical")).toBe(true);
  });
});

describe("assessRefinement — findings", () => {
  it("flags a negative B_iso as a critical physical problem", () => {
    const a = assessRefinement({
      result: result(),
      parameters: [param("Fe1_B", "bIso", -0.3)],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "physical");
    expect(f?.severity).toBe("critical");
    expect(f?.parameterIds).toEqual(["Fe1_B"]);
  });

  it("gives a physical reason for a known dangerous correlation (scale ↔ background)", () => {
    const a = assessRefinement({
      result: result({
        diagnostics: {
          svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1,
          atBounds: [], maxParameterShift: 0,
          highCorrelations: [{ parameterIdA: "scale", parameterIdB: "bkg0", coefficient: 0.98 }],
        },
      }),
      parameters: [param("scale", "scale", 1), param("bkg0", "background", 10)],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "correlation");
    expect(f?.severity).toBe("warning");
    expect(f?.detail).toMatch(/background/i);
  });

  it("flags an at-bound ADP as critical with expert context", () => {
    const a = assessRefinement({
      result: result({
        diagnostics: {
          svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1,
          highCorrelations: [], maxParameterShift: 0,
          atBounds: [{ parameterId: "Fe1_B", bound: "min", value: 0 }],
        },
      }),
      parameters: [param("Fe1_B", "bIso", 0)],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "at-bound");
    expect(f?.severity).toBe("critical");
  });

  it("warns when data barely supports the free parameters", () => {
    const params = Array.from({ length: 30 }, (_, i) => param(`p${i}`, "atomX", 0.1));
    const a = assessRefinement({ result: result(), parameters: params, observationCount: 80 });
    const f = a.findings.find((x) => x.category === "parameterization");
    expect(f?.severity).toBe("warning");
  });

  it("detects unexplained residual peaks as the discovery signal", () => {
    // A sharp positive residual bump (obs > calc) around d = 2.5 Å.
    const n = 200;
    const d: number[] = [];
    const yObs: number[] = [];
    const yCalc: number[] = [];
    for (let i = 0; i < n; i++) {
      const dd = 1 + (i / n) * 3; // 1..4 Å
      d.push(dd);
      const base = 100;
      const bump = Math.abs(dd - 2.5) < 0.03 ? 900 : 0;
      yCalc.push(base);
      yObs.push(base + bump);
    }
    const a = assessRefinement({
      result: result(),
      parameters: [param("scale", "scale", 1)],
      observationCount: n,
      residual: { d, yObs, yCalc },
    });
    const f = a.findings.find((x) => x.category === "residual");
    expect(f).toBeDefined();
    expect(f?.detail).toMatch(/impurity|phase|magnetic/i);
  });
});

describe("suggestNextSteps", () => {
  it("prioritizes fixing an unphysical value before anything else", () => {
    const a = assessRefinement({ result: result(), parameters: [param("Fe1_B", "bIso", -0.3)], observationCount: 4000 });
    const steps = suggestNextSteps(a);
    expect(steps[0]?.addresses).toContain("physical");
  });

  it("on a clean, good fit points at validation rather than more refinement", () => {
    const a = assessRefinement({ result: result(), parameters: [param("scale", "scale", 1)], observationCount: 4000 });
    const steps = suggestNextSteps(a);
    expect(steps.some((s) => /validat/i.test(s.action))).toBe(true);
  });

  it("suggests a phase / k-search when residual peaks are present", () => {
    const n = 200;
    const d: number[] = [], yObs: number[] = [], yCalc: number[] = [];
    for (let i = 0; i < n; i++) {
      const dd = 1 + (i / n) * 3;
      d.push(dd); yCalc.push(100);
      yObs.push(100 + (Math.abs(dd - 2.5) < 0.03 ? 900 : 0));
    }
    const a = assessRefinement({ result: result(), parameters: [param("scale", "scale", 1)], observationCount: n, residual: { d, yObs, yCalc } });
    const steps = suggestNextSteps(a);
    expect(steps.some((s) => s.addresses.includes("residual"))).toBe(true);
  });
});
