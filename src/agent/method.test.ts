import { describe, it, expect } from "vitest";
import { analysisKey, emptyRecord, methodProgress, outOfOrder, ruleRefusal, stagesCovered } from "@/agent/method";
import type { RefinementParameter } from "@/core/refinement/types";

const p = (id: string, kind: RefinementParameter["kind"]): RefinementParameter => ({ id, label: id, kind, value: 1, initialValue: 1, fixed: false });

describe("the method as code", () => {
  it("names an analysis by its page, data and phases", () => {
    const a = analysisKey("powder", "x.xye", [{ name: "MgAl2O4", spaceGroup: { hermannMauguin: "F d -3 m:2" } }]);
    expect(a).toBe("powder¦x.xye¦MgAl2O4|F d -3 m:2");
    expect(analysisKey("powder", "x.xye", [{ name: "MgAl2O4", spaceGroup: { number: 227 } }])).toBe("powder¦x.xye¦MgAl2O4|227");
  });

  it("maps a free set onto the stages it covers", () => {
    expect(stagesCovered("powder", [p("scale", "scale"), p("profW", "profileW"), p("B", "bIso")])).toEqual(["base", "profile", "adp"]);
    expect(stagesCovered("pdf", [p("s", "pdfScale"), p("d2", "delta2")])).toEqual(["base", "motion"]);
  });

  it("tracks the stages and names the next required one", () => {
    const fresh = methodProgress("powder", emptyRecord("k"));
    expect(fresh.skill).toBe("my-rietveld-workflow");
    expect(fresh.next).toBe("Cell gate");
    const later = methodProgress("powder", { ...emptyRecord("k"), cellGate: { passed: true, at: 0, summary: "" }, stagesDone: ["base", "positions"] });
    expect(later.stages.map((s) => s.done)).toEqual([true, true, true, false, false, false, false]);
    expect(later.next).toBe("Profile");
    // Optional stages never hold up the next one.
    const all = methodProgress("pdf", { ...emptyRecord("k"), stagesDone: ["base", "adp", "motion", "positions"] });
    expect(all.next).toBeNull();
  });

  it("notes a block freed ahead of an earlier required one", () => {
    const record = { ...emptyRecord("k"), cellGate: { passed: true, at: 0, summary: "" }, stagesDone: ["base"] };
    expect(outOfOrder("powder", [p("B", "bIso")], record)).toBe("Out of the method's order (my-rietveld-workflow): adps refined before positions, profile. Fine if the residual calls for it; say why.");
    expect(outOfOrder("powder", [p("pos", "positionShift")], record)).toBeNull();
    // Freeing the earlier block alongside is in order.
    expect(outOfOrder("powder", [p("pos", "positionShift"), p("W", "profileW"), p("B", "bIso")], record)).toBeNull();
  });

  it("refuses atomic parameters before the cell gate (powder only) and bare occupancies (both pages)", () => {
    const none = emptyRecord("k");
    expect(ruleRefusal("powder", [p("scale", "scale"), p("cell_a", "cellLength")], [], none)).toBeNull();
    expect(ruleRefusal("powder", [p("pos", "positionShift")], [], none)?.rule).toBe("cell-gate");
    const failed = { ...none, cellGate: { passed: false, at: 0, summary: "2 unindexed peaks, 0 violated absences" } };
    expect(ruleRefusal("powder", [p("B", "bIso")], [], failed)?.message).toMatch(/The cell gate ran and did not pass \(2 unindexed peaks, 0 violated absences\)/);
    expect(ruleRefusal("pdf", [p("B", "bIso")], [], none)).toBeNull();
    const passed = { ...none, cellGate: { passed: true, at: 0, summary: "" } };
    expect(ruleRefusal("powder", [p("occ_A", "occupancy")], [], passed)?.rule).toBe("bare-occupancy");
    const tie = { id: "t", label: "Σ", target: 1, sigma: 0.01, terms: [{ parameterId: "occ_A", coefficient: 1 }, { parameterId: "occ_B", coefficient: 1 }] };
    expect(ruleRefusal("powder", [p("occ_A", "occupancy"), p("occ_B", "occupancy")], [tie], passed)).toBeNull();
    expect(ruleRefusal("pdf", [p("occ_A", "occupancy")], [], none)?.message).toMatch(/a shared site holds its Σ occupancy/);
    const allowed = { ...passed, exceptions: [{ rule: "bare-occupancy" as const, reason: "isotope contrast", at: 0 }] };
    expect(ruleRefusal("powder", [p("occ_A", "occupancy")], [], allowed)).toBeNull();
  });
});
