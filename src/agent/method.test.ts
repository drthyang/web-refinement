import { describe, it, expect } from "vitest";
import { analysisKey, emptyRecord, methodProgress, outOfOrder, ruleRefusal, stagesCovered, stagesLeft } from "@/agent/method";
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
    expect(fresh.next).toBe("Cell check");
    const later = methodProgress("powder", { ...emptyRecord("k"), cellCheck: { passed: false, at: 0, summary: "1 absence flagged" }, stagesDone: ["base", "positions"] });
    // A check that flagged something is still done: it is a check, not a gate.
    expect(later.stages.map((s) => s.done)).toEqual([true, true, true, false, false, false, false, false]);
    expect(later.next).toBe("Profile");
    // The symmetry review is the last stage, and optional.
    expect(later.stages.at(-1)).toMatchObject({ id: "symmetry", label: "Symmetry review (last)", optional: true });
    // Optional stages never hold up the next one.
    const all = methodProgress("pdf", { ...emptyRecord("k"), stagesDone: ["base", "adp", "motion", "positions"] });
    expect(all.next).toBeNull();
  });

  it("lists the refinement stages left before the space group may be questioned", () => {
    expect(stagesLeft("powder", emptyRecord("k"))).toEqual(["Scale, background, cell", "Positions", "Profile", "ADPs"]);
    // The cell check is not among them: it never holds anything up.
    expect(stagesLeft("powder", { ...emptyRecord("k"), stagesDone: ["base", "positions", "profile", "adp"] })).toEqual([]);
  });

  it("notes a block freed ahead of an earlier required one", () => {
    const record = { ...emptyRecord("k"), stagesDone: ["base"] };
    expect(outOfOrder("powder", [p("B", "bIso")], record)).toBe("Out of the method's order (my-rietveld-workflow): adps refined before positions, profile. Fine if the residual calls for it; say why.");
    expect(outOfOrder("powder", [p("pos", "positionShift")], record)).toBeNull();
    // Freeing the earlier block alongside is in order.
    expect(outOfOrder("powder", [p("pos", "positionShift"), p("W", "profileW"), p("B", "bIso")], record)).toBeNull();
  });

  it("never holds a refinement on the cell check; refuses bare occupancies on both pages", () => {
    const none = emptyRecord("k");
    // Atomic parameters refine whether or not the cell check ran, or flagged something.
    expect(ruleRefusal("powder", [p("pos", "positionShift"), p("B", "bIso")], [], none)).toBeNull();
    const flagged = { ...none, cellCheck: { passed: false, at: 0, summary: "2 absences flagged" } };
    expect(ruleRefusal("powder", [p("pos", "positionShift")], [], flagged)).toBeNull();
    expect(ruleRefusal("powder", [p("occ_A", "occupancy")], [], none)?.rule).toBe("bare-occupancy");
    const tie = { id: "t", label: "Σ", target: 1, sigma: 0.01, terms: [{ parameterId: "occ_A", coefficient: 1 }, { parameterId: "occ_B", coefficient: 1 }] };
    expect(ruleRefusal("powder", [p("occ_A", "occupancy"), p("occ_B", "occupancy")], [tie], none)).toBeNull();
    expect(ruleRefusal("pdf", [p("occ_A", "occupancy")], [], none)?.message).toMatch(/a shared site holds its Σ occupancy/);
    const allowed = { ...none, exceptions: [{ rule: "bare-occupancy" as const, reason: "isotope contrast", at: 0 }] };
    expect(ruleRefusal("powder", [p("occ_A", "occupancy")], [], allowed)).toBeNull();
  });
});
