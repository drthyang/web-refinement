import { describe, it, expect } from "vitest";
import { makeExamplePowderProject } from "@/core/project/fixture";
import type { PowderWorkspace, ProjectFile } from "@/core/project/types";
import {
  describeChange, lineage, moveTo, recordStep, redoTarget, renameStep, restoreStep, undoTarget,
  type ProjectHistory, type Snapshot,
} from "@/core/project/history";
import { parseProject, restoreHistoryStep, serializeProject } from "@/core/project/io";

// The fixture with a realistically sized pattern, so "stored once" is measurable.
const fixture = makeExamplePowderProject();
const fixtureWs = fixture.workspace as PowderWorkspace;
const powderWs: PowderWorkspace = {
  ...fixtureWs,
  pattern: { ...fixtureWs.pattern, points: Array.from({ length: 3000 }, (_, i) => ({ x: 10 + i * 0.01, yObs: 100 + (i % 37), sigma: 10 })) },
};
const base: ProjectFile = { ...fixture, workspace: powderWs };

/** The fixture's snapshot with parameter rows transformed (value / fixed edits). */
function withParams(edit: (p: PowderWorkspace["refinement"]["parameters"][number]) => PowderWorkspace["refinement"]["parameters"][number], extra: Partial<PowderWorkspace> = {}): Snapshot {
  return {
    structures: base.structures,
    workspace: { ...powderWs, ...extra, refinement: { ...powderWs.refinement, parameters: powderWs.refinement.parameters.map(edit) } },
  };
}

const start: Snapshot = { structures: base.structures, workspace: powderWs };
const firstId = powderWs.refinement.parameters[0]!.id;

describe("recordStep", () => {
  it("starts a tree, records changes, and skips a snapshot identical to the current step", () => {
    let h = recordStep(null, { ...start, kind: "load", label: "Loaded" });
    expect(h.steps.map((s) => s.id)).toEqual(["s1"]);
    expect(h.current).toBe("s1");
    expect(h.steps[0]!.parent).toBeUndefined();

    const same = recordStep(h, { ...start, kind: "edit" });
    expect(same).toBe(h); // nothing changed → no step
    // A display-only change is not a model change either.
    expect(recordStep(h, { ...start, workspace: { ...powderWs, displayUnit: "dSpacing" }, kind: "edit" })).toBe(h);

    h = recordStep(h, { ...withParams((p) => (p.id === firstId ? { ...p, fixed: !p.fixed } : p)), kind: "edit" });
    expect(h.steps).toHaveLength(2);
    expect(h.steps[1]).toMatchObject({ id: "s2", parent: "s1", kind: "edit" });
    expect(h.steps[1]!.label).toMatch(new RegExp(`(Freed|Fixed) ${firstId}`));
  });

  it("stores data once: steps share blobs, and a step is small", () => {
    let h = recordStep(null, { ...start, kind: "load" });
    for (let i = 1; i <= 5; i++) {
      h = recordStep(h, { ...withParams((p) => (p.id === firstId ? { ...p, value: p.value + i } : p)), kind: "refine", label: `Refine ${i}` });
    }
    expect(h.steps).toHaveLength(6);
    const blobBytes = JSON.stringify(h.blobs).length;
    const patternBytes = JSON.stringify(powderWs.pattern).length;
    expect(blobBytes).toBeLessThan(patternBytes * 1.5 + 50_000); // the pattern once, not six times
    for (const s of h.steps) expect(JSON.stringify(s).length).toBeLessThan(patternBytes);
  });

  it("summarizes the snapshot's result and free count", () => {
    const h = recordStep(null, { ...start, kind: "load" });
    const nFree = powderWs.refinement.parameters.filter((p) => !p.fixed && !p.expression).length;
    expect(h.steps[0]!.summary.nFree).toBe(nFree);
    const r = powderWs.refinement.lastResult;
    if (r?.agreement.rWeighted !== undefined) expect(h.steps[0]!.summary.wR).toBe(r.agreement.rWeighted);
  });
});

describe("moving around the tree", () => {
  const edit = (i: number): Snapshot => withParams((p) => (p.id === firstId ? { ...p, value: p.value + i } : p));
  // s1 → s2 → s3; back to s2, then act → s4 (a branch beside s3).
  let h: ProjectHistory = recordStep(null, { ...start, kind: "load" });
  h = recordStep(h, { ...edit(1), kind: "refine", label: "A" });
  h = recordStep(h, { ...edit(2), kind: "refine", label: "B" });
  const before = h;
  h = moveTo(h, "s2");
  h = recordStep(h, { ...edit(3), kind: "refine", label: "C" });

  it("going back and acting branches instead of discarding", () => {
    expect(h.steps.map((s) => [s.id, s.parent ?? null])).toEqual([["s1", null], ["s2", "s1"], ["s3", "s2"], ["s4", "s2"]]);
    expect(lineage(h).map((s) => s.id)).toEqual(["s1", "s2", "s4"]);
    expect(lineage(h, "s3").map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(before.steps).toHaveLength(3); // histories are immutable values
  });

  it("undo goes to the parent, redo to the newest child", () => {
    expect(undoTarget(h)).toBe("s2");
    expect(redoTarget(moveTo(h, "s2"))).toBe("s4");
    expect(undoTarget(moveTo(h, "s1"))).toBeUndefined();
    expect(redoTarget(h)).toBeUndefined();
  });

  it("a restored step is exactly the snapshot that was recorded, as a private copy", () => {
    const snap = restoreStep(h, "s3");
    expect(snap.workspace).toEqual(edit(2).workspace);
    expect(snap.structures).toEqual(base.structures);
    (snap.workspace as PowderWorkspace).refinement.parameters[0]!.value = -1;
    expect(restoreStep(h, "s3").workspace).toEqual(edit(2).workspace);
  });

  it("names a step, and an empty name removes it", () => {
    const named = renameStep(h, "s2", "  before ADPs ");
    expect(named.steps[1]!.name).toBe("before ADPs");
    expect(renameStep(named, "s2", "").steps[1]!.name).toBeUndefined();
  });
});

describe("describeChange", () => {
  it("names settings and parameter edits", () => {
    const a = { ...powderWs, refinement: powderWs.refinement } as unknown as Record<string, unknown>;
    const b = { ...powderWs, backgroundTerms: powderWs.backgroundTerms + 2 } as unknown as Record<string, unknown>;
    expect(describeChange(a, b)).toBe("Background terms");
    expect(describeChange(a, a)).toBe("No change");
  });
});

describe("history in a project file", () => {
  function fileWithHistory(): ProjectFile {
    let h = recordStep(null, { ...start, kind: "load", label: "Loaded" });
    h = recordStep(h, { ...withParams((p) => (p.id === firstId ? { ...p, value: p.value * 1.01 } : p)), kind: "refine", label: "Refine" });
    return { ...base, history: h };
  }

  it("round-trips, and the current data is written once (a pointer, not a copy)", () => {
    const file = fileWithHistory();
    const text = serializeProject(file);
    const plain = serializeProject(base);
    // The history adds kilobytes, not another copy of the pattern.
    expect(text.length - plain.length).toBeLessThan(0.5 * plain.length);
    expect(text).toContain("\"sameAs\"");
    const back = parseProject(text);
    expect(back.history).toEqual(JSON.parse(JSON.stringify(file.history)));
    expect(restoreHistoryStep(back.history!, "s1").workspace).toEqual(JSON.parse(JSON.stringify(powderWs)));
  });

  it("files without a history still open, and a broken history is refused with its path", () => {
    expect(parseProject(serializeProject(base)).history).toBeUndefined();
    const doc = JSON.parse(serializeProject(fileWithHistory())) as { history: { current: string } };
    doc.history.current = "s99";
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/history\.current: no step "s99"/);
  });

  it("a damaged step is reported when restored, not when the file opens", () => {
    const file = fileWithHistory();
    const steps = file.history!.steps.map((s) => (s.id === "s1" ? { ...s, workspace: { ...s.workspace, backgroundTerms: "many" } } : s));
    const back = parseProject(serializeProject({ ...file, history: { ...file.history!, steps } }));
    expect(() => restoreHistoryStep(back.history!, "s1")).toThrow(/history step s1\.workspace\.backgroundTerms/);
    expect(restoreHistoryStep(back.history!, "s2").workspace.technique).toBe("powder");
  });
});
