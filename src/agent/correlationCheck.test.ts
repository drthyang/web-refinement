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
    const check = readCorrelations(probe([["bkg0", "bkg1", 0.81], ["scale", "B_Mn1", 0.62]]), params);
    expect(check.correlated).toEqual([]);
    expect(check.strongest).toMatchObject({ a: "bkg0", b: "bkg1", coefficient: 0.81 });
    expect(correlationRefusal(check)).toBeNull();
  });

  it("refuses a pair at the limit, with the physical reason and what to do", () => {
    const check = readCorrelations(probe([["scale", "occ_Mn1", -0.991], ["B_Mn1", "occ_Mn1", CORRELATION_LIMIT], ["bkg0", "bkg1", 0.7]]), params);
    expect(check.correlated.map((p) => [p.a, p.b])).toEqual([["scale", "occ_Mn1"], ["B_Mn1", "occ_Mn1"]]);
    expect(check.correlated[0]!.reason).toMatch(/near-degenerate/);
    expect(check.strongest).toMatchObject({ a: "bkg0", b: "bkg1" });
    const refusal = correlationRefusal(check)!;
    expect(refusal).toMatch(/^Not refined/);
    expect(refusal).toContain("scale ↔ occ_Mn1 -0.991 (Scale and site occupancy");
    expect(refusal).toContain("B_Mn1 ↔ occ_Mn1 0.950");
    expect(refusal).toMatch(/Fix one of each pair with set_free/);
    expect(refusalLine(check)).toBe("Not run: scale ↔ occ_Mn1 -0.991 and 1 more correlated");
  });

  it("refuses a combination the data cannot determine", () => {
    const check = readCorrelations(probe([], ["scale", "occ_Mn1"]), params);
    expect(correlationRefusal(check)).toContain("Not determined by the data at all, together: scale, occ_Mn1.");
    expect(refusalLine(check)).toBe("Not run: scale, occ_Mn1 not determined");
  });
});
