import { describe, it, expect } from "vitest";
import { parametersChangedSince, powderChecks, singleCrystalChecks, verdictFrom } from "@/core/diagnostics/validationChecks";
import type { PowderValidation } from "@/core/diagnostics/powderValidation";
import type { ScValidation } from "@/core/diagnostics/singleCrystalValidation";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";

function param(id: string, kind: RefinementParameter["kind"], value: number, fixed = false): RefinementParameter {
  return { id, label: id, kind, value, initialValue: value, fixed };
}

function result(values: Record<string, number>, over: Partial<RefinementResult> = {}): RefinementResult {
  return {
    status: "converged",
    parameters: values,
    esd: {},
    agreement: { rFactor: 0.04, rWeighted: 0.05, rExpected: 0.04, goodnessOfFit: 1.25 },
    history: [{ iteration: 1, chiSquared: 1, agreement: { rFactor: 0.04 } }],
    diagnostics: { svdZeroCount: 0, singularParameterIds: [], conditionNumber: 1e3, highCorrelations: [], maxLambda: 1, atBounds: [], maxShiftOverEsd: 0.02 },
    ...over,
  };
}

function powder(over: Partial<PowderValidation["agreement"]> = {}, dw?: PowderValidation["durbinWatson"]): PowderValidation {
  return {
    agreement: { n: 4000, nParams: 20, rp: 0.04, rwp: 0.05, rexp: 0.04, gof: 1.25, chi2nu: 1.5625, ...over },
    ...(dw ? { durbinWatson: dw } : {}),
    delta: new Float64Array(0),
    cumulative: new Float64Array(0),
    chi2: 6000,
    shells: [],
    shellAxis: "d",
  };
}

const params = [param("scale", "scale", 1), param("B1", "bIso", 0.5)];
const fit = result({ scale: 1, B1: 0.5 });

describe("powderChecks", () => {
  it("a clean fit passes every check", () => {
    const v = powderChecks({ validation: powder({}, { d: 1.98, qd: 1.93, correlated: false }), unindexed: [], result: fit, parameters: params });
    expect(v.tone).toBe("ok");
    expect(v.headline).toBe("Nothing flagged");
    expect(v.checks.map((c) => c.id)).toEqual(["gof", "convergence", "physical", "durbin-watson", "unindexed"]);
  });

  it("flags serial correlation, an unindexed peak and GoF below 1", () => {
    const v = powderChecks({
      validation: powder({ gof: 0.6, chi2nu: 0.36 }, { d: 0.88, qd: 1.93, correlated: true }),
      unindexed: [{ d: 2.952, index: 10, share: 0.051 }],
      result: fit, parameters: params, canExport: true,
    });
    const byId = new Map(v.checks.map((c) => [c.id, c]));
    expect(byId.get("gof")!.status).toBe("note");
    expect(byId.get("durbin-watson")!.status).toBe("warn");
    expect(byId.get("durbin-watson")!.detail).toMatch(/0\.88 < Q_D 1\.93/);
    expect(byId.get("unindexed")!.title).toMatch(/2\.952/);
    expect(byId.get("unindexed")!.actions).toEqual(["show-unindexed"]);
    expect(byId.get("cross-check")!.actions).toEqual(["export-gsas2", "export-fullprof"]);
    expect(v.tone).toBe("warn");
    expect(v.headline).toBe("3 things to check");
  });

  it("knows when there is no refinement, or the values were edited after it", () => {
    const none = powderChecks({ validation: powder(), unindexed: [], result: null, parameters: params });
    expect(none.checks.find((c) => c.id === "convergence")!.title).toBe("Not refined yet");
    const edited = [param("scale", "scale", 1.2), param("B1", "bIso", 0.5)];
    expect(parametersChangedSince(fit, edited)).toBe(true);
    const stale = powderChecks({ validation: powder(), unindexed: [], result: fit, parameters: edited });
    expect(stale.checks.find((c) => c.id === "convergence")!.status).toBe("note");
  });

  it("a negative B is critical, and the headline says so", () => {
    const bad = [param("scale", "scale", 1), param("B1", "bIso", -0.2)];
    const v = powderChecks({ validation: powder(), unindexed: [], result: result({ scale: 1, B1: -0.2 }), parameters: bad });
    expect(v.checks.find((c) => c.id === "physical")!.status).toBe("critical");
    expect(v.headline).toMatch(/^Not reliable yet · 1 to fix/);
  });

  it("names strong correlations and undetermined directions", () => {
    const r = result({ scale: 1, B1: 0.5 }, {
      diagnostics: {
        svdZeroCount: 1, singularParameterIds: ["B1"], conditionNumber: 1e9,
        highCorrelations: [{ parameterIdA: "scale", parameterIdB: "B1", coefficient: 0.97 }],
        maxLambda: 1, atBounds: [], maxShiftOverEsd: 0.01,
      },
    });
    const v = powderChecks({ validation: powder(), unindexed: [], result: r, parameters: params });
    expect(v.checks.find((c) => c.id === "correlation")!.detail).toBe("scale / B1 0.97");
    expect(v.checks.find((c) => c.id === "conditioning")!.status).toBe("warn");
  });
});

function sc(over: Partial<ScValidation> = {}): ScValidation {
  const bin = (k: number, goof: number) => ({ fcRatioMax: 0.1, n: 100, k, goof });
  return {
    shells: Array.from({ length: 8 }, () => ({ dMax: 2, dMin: 1, n: 100, unique: 100, completeness: 1, iOverSigma: 10, k: 1, goof: 1, r1: 0.04 })),
    bins: [bin(0.98, 1), bin(1, 1), bin(1, 1.05), bin(1, 0.95)],
    outliers: [],
    dMin: 0.71,
    sinThetaOverLambdaMax: 0.704,
    uniqueObserved: 1400,
    uniqueExpected: 1408,
    completeness: 0.994,
    reflectionsPerParameter: 24.3,
    centrosymmetric: true,
    extinction: { suspected: false, strongBinK: 1, strongBinGoof: 0.95, strongUnder: 0, outliers: 2 },
    goofWithoutStrongest: 1,
    ...over,
  };
}

describe("singleCrystalChecks", () => {
  it("a sound refinement passes, and names what it does not check", () => {
    const v = singleCrystalChecks({ validation: sc(), goof: 1.04, result: fit, parameters: params });
    expect(v.tone).toBe("ok");
    expect(v.checks.find((c) => c.id === "data-parameter")!.status).toBe("ok");
    expect(v.checks.find((c) => c.id === "completeness")!.title).toBe("99.4% complete");
    expect(v.checks.at(-1)!.id).toBe("not-checked");
    expect(v.checks.at(-1)!.detail).not.toMatch(/Flack/);
  });

  it("extinction: flagged, and the GooF is attributed to the strong reflections", () => {
    const v = singleCrystalChecks({
      validation: sc({
        extinction: { suspected: true, strongBinK: 0.917, strongBinGoof: 2.45, strongUnder: 8, outliers: 8 },
        bins: [{ fcRatioMax: 0.1, n: 100, k: 1, goof: 1 }, { fcRatioMax: 0.5, n: 100, k: 1, goof: 1.02 }, { fcRatioMax: 0.8, n: 100, k: 0.99, goof: 0.98 }, { fcRatioMax: 1, n: 100, k: 0.917, goof: 2.45 }],
        goofWithoutStrongest: 1.01,
      }),
      goof: 1.25, result: fit, parameters: params,
    });
    const byId = new Map(v.checks.map((c) => [c.id, c]));
    expect(byId.get("extinction")!.status).toBe("warn");
    expect(byId.get("gof")!.status).toBe("ok");
    expect(byId.get("gof")!.detail).toMatch(/strongest reflections/);
    // The strongest bin is left out of the weighting check.
    expect(byId.get("weighting")!.status).toBe("ok");
  });

  it("thin data, low completeness, a non-positive-definite site, and the Flack reminder", () => {
    const v = singleCrystalChecks({
      validation: sc({ reflectionsPerParameter: 6.2, completeness: 0.87, centrosymmetric: false }),
      goof: 1.1, result: fit, parameters: params, nonPositiveDefinite: ["Mn1"], xray: true,
    });
    const byId = new Map(v.checks.map((c) => [c.id, c]));
    expect(byId.get("data-parameter")!.status).toBe("warn");
    expect(byId.get("data-parameter")!.detail).toMatch(/≥ 8/);
    expect(byId.get("completeness")!.status).toBe("warn");
    expect(byId.get("physical")!.status).toBe("critical");
    expect(byId.get("not-checked")!.detail).toMatch(/Flack/);
  });

  it("K drifting with resolution is noted when extinction does not explain it", () => {
    const shells = Array.from({ length: 8 }, (_, i) => ({ dMax: 2, dMin: 1, n: 100, unique: 100, completeness: 1, iOverSigma: 10, k: 1.08 - i * 0.02, goof: 1, r1: 0.04 }));
    const v = singleCrystalChecks({ validation: sc({ shells }), goof: 1.05, result: fit, parameters: params });
    expect(v.checks.find((c) => c.id === "k-trend")!.status).toBe("note");
  });
});

describe("verdictFrom", () => {
  it("info lines never colour the chip", () => {
    expect(verdictFrom([{ id: "x", status: "info", title: "t" }]).tone).toBe("ok");
  });
});
