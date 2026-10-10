import { describe, it, expect } from "vitest";
import { CORRELATION_LIMIT, correlationRefusal, readCorrelations, refusalLine } from "@/agent/correlationCheck";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";

function param(id: string, kind: RefinementParameter["kind"]): RefinementParameter {
  return { id, label: id, kind, value: 1, initialValue: 1, fixed: false };
}

const params = [param("scale", "scale"), param("occ_Mn1", "occupancy"), param("B_Mn1", "bIso"), param("bkg0", "background"), param("bkg1", "background")];

function probe(pairs: [string, string, number][], singular: string[] = []): RefinementResult {
  return {
    status: "maxIterations",
    parameters: {},
    esd: {},
    agreement: { rFactor: 0 },
    history: [],
    diagnostics: {
      svdZeroCount: singular.length ? 1 : 0,
      singularParameterIds: singular,
      conditionNumber: 1e3,
      highCorrelations: pairs.map(([a, b, c]) => ({ parameterIdA: a, parameterIdB: b, coefficient: c })),
      maxLambda: 1e-3,
      atBounds: [],
      maxShiftOverEsd: 0,
    },
  };
}

describe("correlation check", () => {
  it("passes a set with nothing at the limit, and names its strongest pair", () => {
    const check = readCorrelations(probe([["scale", "B_Mn1", 0.81], ["scale", "bkg0", 0.62]]), params);
    expect(check.correlated).toEqual([]);
    expect(check.strongest).toMatchObject({ a: "scale", b: "B_Mn1", coefficient: 0.81 });
    expect(correlationRefusal(check)).toBeNull();
  });

  it("refuses a pair at the limit, with the physical reason and what to do", () => {
    const check = readCorrelations(probe([["scale", "occ_Mn1", -0.991], ["B_Mn1", "occ_Mn1", CORRELATION_LIMIT], ["scale", "bkg1", 0.7]]), params);
    expect(check.correlated.map((p) => [p.a, p.b])).toEqual([["scale", "occ_Mn1"], ["B_Mn1", "occ_Mn1"]]);
    expect(check.correlated[0]!.reason).toMatch(/near-degenerate/);
    expect(check.strongest).toMatchObject({ a: "scale", b: "bkg1" });
    const refusal = correlationRefusal(check)!;
    expect(refusal).toMatch(/^Not refined/);
    expect(refusal).toContain("scale ↔ occ_Mn1 -0.991 (Scale and site occupancy");
    expect(refusal).toContain("B_Mn1 ↔ occ_Mn1 0.950");
    expect(refusal).toMatch(/Fix one of each pair with set_free/);
    expect(refusalLine(check)).toBe("Not run: scale ↔ occ_Mn1 -0.991 and 1 more correlated");
  });

  it("lets the background coefficients correlate among themselves, but not with the scale", () => {
    const check = readCorrelations(probe([["bkg0", "bkg1", 0.995], ["scale", "bkg0", 0.97]]), params);
    expect(check.correlated.map((p) => [p.a, p.b])).toEqual([["scale", "bkg0"]]);
    expect(check.correlated[0]!.reason).toMatch(/background are trading intensity/);
    expect(readCorrelations(probe([["bkg0", "bkg1", 0.995]]), params).correlated).toEqual([]);
  });

  it("does not count two occupancies one restraint ties against each other", () => {
    const occ = [param("scale", "scale"), param("occ_Mg1", "occupancy"), param("occ_Al1", "occupancy"), param("occ_Mg2", "occupancy")];
    const restraint = { id: "occ_sum_Mg1", label: "Σ occ @ Mg1 site", target: 1, sigma: 0.01, terms: [{ parameterId: "occ_Mg1", coefficient: 1 }, { parameterId: "occ_Al1", coefficient: 1 }] };
    const pairs: [string, string, number][] = [["occ_Mg1", "occ_Al1", -0.999], ["occ_Mg1", "occ_Mg2", 0.97], ["scale", "occ_Al1", 0.96]];
    const check = readCorrelations(probe(pairs), occ, [restraint]);
    expect(check.correlated.map((p) => [p.a, p.b])).toEqual([["occ_Mg1", "occ_Mg2"], ["scale", "occ_Al1"]]);
    expect(readCorrelations(probe(pairs), occ).correlated).toHaveLength(3);
  });

  it("lets the Caglioti U, V, W correlate among themselves, but not with a structural parameter", () => {
    const width = [param("profU", "profileU"), param("profV", "profileV"), param("profW", "profileW"), param("B_Mn1", "bIso")];
    const check = readCorrelations(probe([["profV", "profW", -0.967], ["profU", "profV", -0.955], ["profW", "B_Mn1", 0.96]]), width);
    expect(check.correlated.map((p) => [p.a, p.b])).toEqual([["profW", "B_Mn1"]]);
  });

  it("explains the Lorentzian X ↔ Y pair", () => {
    const check = readCorrelations(probe([["profX", "profY", -0.97]]), [param("profX", "profileX"), param("profY", "profileY")]);
    expect(check.correlated[0]!.reason).toMatch(/Refine Y \(or X\) alone/);
  });

  it("refuses a combination the data cannot determine", () => {
    const check = readCorrelations(probe([], ["scale", "occ_Mn1"]), params);
    expect(correlationRefusal(check)).toContain("Not determined by the data at all, together: scale, occ_Mn1.");
    expect(refusalLine(check)).toBe("Not run: scale, occ_Mn1 not determined");
  });
});
