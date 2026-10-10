import { describe, it, expect } from "vitest";
import { assessRefinement, suggestNextSteps } from "@/core/diagnostics/assessment";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { noisyPeakProblem } from "@/testSupport/noisyPeak";

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
    expect(f?.summary).toMatch(/Fe1_B refined negative/);
    expect(f?.evidence?.origin).toBe("refined");
  });

  it("flags a free Lorentzian width refined negative, and not a held one", () => {
    const a = assessRefinement({
      result: result(),
      parameters: [param("profileY", "profileY", -7.2, { label: "Lorentzian Y" }), param("profileX", "profileX", -0.5, { fixed: true })],
      observationCount: 4000,
    });
    const f = a.findings.filter((x) => x.category === "physical");
    expect(f.map((x) => x.parameterIds)).toEqual([["profileY"]]);
    expect(f[0]?.summary).toMatch(/Lorentzian Y refined negative.*no physical meaning/);
    expect(f[0]?.detail).toMatch(/Fix it at 0 and refine U, V, W/);
  });

  it("words a held negative B_iso as an input value, not a refinement result", () => {
    const a = assessRefinement({
      result: result(),
      parameters: [param("Fe1_B", "bIso", -0.3, { fixed: true })],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "physical");
    expect(f?.severity).toBe("critical");
    expect(f?.summary).toMatch(/Fe1_B is held at -0\.3000/);
    expect(f?.summary).not.toMatch(/refined/);
    expect(f?.detail).toMatch(/starting structure or CIF/);
    expect(f?.detail).not.toMatch(/absorbs an error/);
    expect(f?.evidence?.origin).toBe("input");
  });

  it("flags a freed occupancy outside [0, 1] and points at the scale correlation", () => {
    const a = assessRefinement({
      result: result(),
      parameters: [param("occ_Ga1", "occupancy", 1.005)],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "physical");
    expect(f?.severity).toBe("warning");
    expect(f?.summary).toBe("occ_Ga1 refined to 1.0050, outside [0, 1].");
    expect(f?.detail).toMatch(/scale\/occupancy correlation/);
    expect(f?.evidence?.origin).toBe("refined");
  });

  it("words a held occupancy outside [0, 1] as an input value, with no correlation blame", () => {
    // The Mn₃Ga 30 K CIF carries Ga1 occupancy 1.005; it stays held in a
    // scale/background/cell/profile refinement.
    const a = assessRefinement({
      result: result(),
      parameters: [param("occ_Ga1", "occupancy", 1.005, { fixed: true })],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "physical");
    expect(f?.severity).toBe("warning");
    expect(f?.summary).toBe("occ_Ga1 is held at 1.0050, outside [0, 1].");
    expect(f?.detail).toMatch(/starting structure or CIF/);
    expect(f?.detail).not.toMatch(/correlation/);
    expect(f?.evidence?.origin).toBe("input");
  });

  it("gives a physical reason for a known dangerous correlation (scale ↔ background)", () => {
    const a = assessRefinement({
      result: result({
        diagnostics: {
          svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1,
          atBounds: [], maxShiftOverEsd: 0,
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
          highCorrelations: [], maxShiftOverEsd: 0,
          atBounds: [{ parameterId: "Fe1_B", bound: "min", value: 0 }],
        },
      }),
      parameters: [param("Fe1_B", "bIso", 0)],
      observationCount: 4000,
    });
    const f = a.findings.find((x) => x.category === "at-bound");
    expect(f?.severity).toBe("critical");
  });

  it("suspects the mixing for an ADP at a bound on a shared site", () => {
    const diagnostics = {
      svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1,
      highCorrelations: [], maxShiftOverEsd: 0,
      atBounds: [{ parameterId: "B_Al2", bound: "min" as const, value: 0 }],
    };
    const shared = assessRefinement({ result: result({ diagnostics }), parameters: [param("B_Al2", "bIso", 0)], observationCount: 4000, sharedSiteAdps: ["B_Al2"] });
    expect(shared.findings.find((x) => x.category === "at-bound")?.detail).toMatch(/scatters more than the model puts on it.*mixing is off/);
    const lone = assessRefinement({ result: result({ diagnostics }), parameters: [param("B_Al2", "bIso", 0)], observationCount: 4000 });
    expect(lone.findings.find((x) => x.category === "at-bound")?.detail).toMatch(/over-damping/);
  });

  it("notes occupancies tied by a restraint once, and still warns about the scale", () => {
    const a = assessRefinement({
      result: result({
        diagnostics: {
          svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1, atBounds: [], maxShiftOverEsd: 0,
          highCorrelations: [
            { parameterIdA: "occ_Mg1", parameterIdB: "occ_Al1", coefficient: -0.97 },
            { parameterIdA: "scale", parameterIdB: "occ_Al1", coefficient: 0.96 },
          ],
        },
      }),
      parameters: [param("scale", "scale", 1), param("occ_Mg1", "occupancy", 0.75), param("occ_Al1", "occupancy", 0.25)],
      observationCount: 4000,
      restraints: [{ id: "occ_sum_Mg1", label: "Σ occ @ Mg1 site", target: 1, sigma: 0.01, terms: [{ parameterId: "occ_Mg1", coefficient: 1 }, { parameterId: "occ_Al1", coefficient: 1 }] }],
    });
    const corr = a.findings.filter((x) => x.category === "correlation");
    expect(corr.map((f) => [f.severity, f.summary])).toEqual(expect.arrayContaining([
      ["info", "Parameters tied by a restraint correlate (up to 0.970): Σ occ @ Mg1 site."],
      ["warning", "scale ↔ occ_Al1 correlate at 0.96."],
    ]));
    expect(corr).toHaveLength(2);
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

describe("assessRefinement — convergence (shift/esd)", () => {
  const assessFit = (problem: RefinementProblem, r: RefinementResult) =>
    assessRefinement({
      result: r,
      parameters: problem.parameters.map((p) => ({ ...p, value: r.parameters[p.id] ?? p.value })),
      observationCount: problem.observations.length,
    });
  const convergence = (a: ReturnType<typeof assessRefinement>) => a.findings.filter((f) => f.category === "convergence");

  it("does not flag a converged fit whose position offset refined to ~0", () => {
    // Positions refine as offsets from the starting coordinates, so they end
    // near 0. The old relative shift |Δp|/|p| exploded there and warned on
    // every such fit; against the esd the last step is negligible.
    const problem = noisyPeakProblem({ start: 0.01 });
    const r = refine(problem);
    expect(r.status).toBe("converged");
    expect(Math.abs(r.parameters.pos!)).toBeLessThan(1e-4 * r.esd.pos!);
    expect(r.diagnostics!.maxShiftOverEsd).toBeLessThan(0.1);
    expect(convergence(assessFit(problem, r))).toEqual([]);
  });

  it("warns when the fit stopped on χ² while a parameter was still moving", () => {
    // Heavy damping covers a fraction of the way per step, and a loose χ²
    // tolerance then stops the search with the offset still esds from its
    // optimum (exactly 0 for this problem).
    const problem = noisyPeakProblem({ start: 0.015 });
    const r = refine(problem, { lambda: 10, convergenceTolerance: 0.1 });
    expect(r.status).toBe("converged");
    expect(Math.abs(r.parameters.pos!)).toBeGreaterThan(3 * r.esd.pos!);
    const [f] = convergence(assessFit(problem, r));
    expect(f?.severity).toBe("warning");
    expect(f?.parameterIds).toEqual(["pos"]);
    expect(f?.summary).toMatch(/peak offset was still moving/);
    expect(f?.evidence?.maxShiftOverEsd).toBeGreaterThan(1);
  });

  it("notes, without counting it as an issue, a last shift between 0.1 and 1 esd", () => {
    const diagnostics = {
      svdZeroCount: 0, singularParameterIds: [], conditionNumber: 100, maxLambda: 1e-3,
      highCorrelations: [], atBounds: [],
    };
    const params = [param("bkg0", "background", 10)];
    const settled = assessRefinement({
      result: result({ diagnostics: { ...diagnostics, maxShiftOverEsd: 0.08, maxShiftParameterId: "bkg0" } }),
      parameters: params,
      observationCount: 4000,
    });
    expect(convergence(settled)).toEqual([]);
    const unsettled = assessRefinement({
      result: result({ diagnostics: { ...diagnostics, maxShiftOverEsd: 0.4, maxShiftParameterId: "bkg0" } }),
      parameters: params,
      observationCount: 4000,
    });
    expect(convergence(unsettled).map((f) => f.severity)).toEqual(["note"]);
    expect(convergence(unsettled)[0]?.parameterIds).toEqual(["bkg0"]);
    expect(unsettled.summary).toMatch(/no issues flagged/);
  });
});

describe("suggestNextSteps", () => {
  it("prioritizes fixing an unphysical value before anything else", () => {
    const a = assessRefinement({ result: result(), parameters: [param("Fe1_B", "bIso", -0.3)], observationCount: 4000 });
    const steps = suggestNextSteps(a);
    expect(steps[0]?.addresses).toContain("physical");
    expect(steps[0]?.action).toMatch(/trace the upstream cause/);
  });

  it("for a held unphysical value, points at the starting structure instead of the fit", () => {
    const a = assessRefinement({ result: result(), parameters: [param("Fe1_B", "bIso", -0.3, { fixed: true })], observationCount: 4000 });
    const steps = suggestNextSteps(a);
    expect(steps[0]?.addresses).toContain("physical");
    expect(steps[0]?.action).toMatch(/Correct Fe1_B in the starting structure/);
    expect(steps[0]?.action).not.toMatch(/upstream cause/);
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
