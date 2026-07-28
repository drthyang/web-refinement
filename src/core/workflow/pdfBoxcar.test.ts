import { describe, it, expect } from "vitest";
import type { AtomSite, StructureModel, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { refineSequential, refineSequentialAsync, type SequentialDataset } from "@/core/refinement/sequential";
import { buildPdfProblem, buildPdfSpec } from "@/core/workflow/pdf";
import {
  BOXCAR_MAX_WINDOWS,
  boxcarHasGaps,
  boxcarPlanIssue,
  boxcarScannedMax,
  boxcarWindows,
} from "@/core/workflow/pdfBoxcar";

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

function p1Structure(cell: UnitCell, sites: AtomSite[]): StructureModel {
  return { id: "s", name: "s", cell, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

function isoSite(label: string, element: string, position: readonly [number, number, number], bIso: number): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso } };
}

describe("boxcarWindows", () => {
  it("emits fixed-width boxes advancing by the step, first flush with the range start", () => {
    const w = boxcarWindows({ range: { min: 1.5, max: 11.5 }, width: 5, step: 2.5 });
    expect(w.map((b) => [b.min, b.max, b.center])).toEqual([
      [1.5, 6.5, 4],
      [4, 9, 6.5],
      [6.5, 11.5, 9],
    ]);
  });

  it("never emits a narrowed trailing box — every box has the requested width", () => {
    // 1.5–12 Å leaves 1 Å over after three 5 Å boxes at step 2.5.
    const w = boxcarWindows({ range: { min: 1.5, max: 12 }, width: 5, step: 2.5 });
    expect(w).toHaveLength(3);
    for (const b of w) expect(b.max - b.min).toBeCloseTo(5, 12);
    expect(boxcarScannedMax({ range: { min: 1.5, max: 12 }, width: 5, step: 2.5 })).toBeCloseTo(11.5, 12);
  });

  it("counts a box whose right edge lands exactly on the range end (float tolerance)", () => {
    // 0.1-decimal arithmetic: 1.1 + 8 × 0.1 + 2 overshoots 3.9 in binary float.
    const w = boxcarWindows({ range: { min: 1.1, max: 3.9 }, width: 2, step: 0.1 });
    expect(w[w.length - 1]!.max).toBeCloseTo(3.9, 12);
  });

  it("reverses the scan order for a high → low r direction, keeping the same boxes", () => {
    const plan = { range: { min: 2, max: 12 }, width: 4, step: 2 } as const;
    const up = boxcarWindows(plan);
    const down = boxcarWindows({ ...plan, direction: "down" });
    expect(down.map((b) => b.center)).toEqual([...up.map((b) => b.center)].reverse());
  });

  it("returns an empty plan (and a reason) for unusable settings", () => {
    const tooWide = { range: { min: 2, max: 8 }, width: 10, step: 1 };
    expect(boxcarWindows(tooWide)).toEqual([]);
    expect(boxcarPlanIssue(tooWide)).toMatch(/does not fit/);
    expect(boxcarPlanIssue({ range: { min: 2, max: 12 }, width: 0, step: 1 })).toMatch(/width must be positive|width must be a positive/i);
    expect(boxcarPlanIssue({ range: { min: 2, max: 12 }, width: 4, step: -1 })).toMatch(/step must be a positive/i);
    // A single box is a plain windowed refinement, not a boxcar.
    expect(boxcarPlanIssue({ range: { min: 2, max: 8 }, width: 6, step: 3 })).toMatch(/single box/);
    expect(boxcarPlanIssue({ range: { min: 0, max: 100 }, width: 1, step: 0.01 })).toMatch(
      new RegExp(`limit ${BOXCAR_MAX_WINDOWS}`),
    );
  });

  it("never emits more than the hard window limit, even on a boundary count", () => {
    // The validator's count and the loop's edge test apply the float tolerance
    // in different places, so the cap has to hold in the enumeration too.
    const plan = { range: { min: 0, max: 201 }, width: 1, step: 1 };
    expect(boxcarWindows(plan).length).toBeLessThanOrEqual(BOXCAR_MAX_WINDOWS + 1);
    // ...and a plan the validator rejects enumerates nothing at all.
    expect(boxcarPlanIssue(plan)).toMatch(new RegExp(`limit ${BOXCAR_MAX_WINDOWS}`));
    expect(boxcarWindows(plan)).toEqual([]);
  });

  it("flags a step wider than the box — those boxes sample the span, they do not cover it", () => {
    expect(boxcarHasGaps({ range: { min: 1, max: 21 }, width: 2, step: 5 })).toBe(true);
    expect(boxcarHasGaps({ range: { min: 1, max: 21 }, width: 5, step: 5 })).toBe(false);
    expect(boxcarHasGaps({ range: { min: 1, max: 21 }, width: 5, step: 2.5 })).toBe(false);
    // A gapped plan is still legal — it just isn't continuous coverage.
    const w = boxcarWindows({ range: { min: 1, max: 21 }, width: 2, step: 5 });
    expect(w).toHaveLength(4);
    expect(w[1]!.min).toBeGreaterThan(w[0]!.max);
  });

  it("accepts a plan with two boxes — the smallest real boxcar", () => {
    expect(boxcarPlanIssue({ range: { min: 1, max: 7 }, width: 5, step: 1 })).toBeNull();
    expect(boxcarWindows({ range: { min: 1, max: 7 }, width: 5, step: 1 })).toHaveLength(2);
  });
});

/** Synthetic G(r) from a known simple-cubic model — the same truth fixture the
 *  PDF workflow tests use, on a grid long enough to hold several boxes. */
const TRUE_A = 4.0;
function truthPattern(): PdfPattern {
  const cell: UnitCell = { a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 };
  const atoms = expandStructureAtoms(p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], 0.5)]));
  const rGrid = makeRGrid(1.5, 20, 0.02);
  const g = computeGofR(cell, atoms, rGrid, {
    scatteringType: "neutron", scale: 1.3, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
  });
  return {
    id: "pdf-boxcar",
    name: "synthetic Ni G(r)",
    scatteringType: "neutron",
    points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })),
    qdamp: 0.03,
  };
}

function perturbed(): StructureModel {
  const cell: UnitCell = { a: 4.04, b: 4.04, c: 4.04, alpha: 90, beta: 90, gamma: 90 };
  return p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], 0.6)]);
}

/** The boxcar datasets the UI/client build: one problem per window over the
 *  SAME pattern, ids derived from the window (pattern.id would collide). */
function boxcarDatasets(
  structure: StructureModel,
  pattern: PdfPattern,
  bindings: Parameters<typeof buildPdfProblem>[3],
  windows: readonly { min: number; max: number; center: number }[],
): SequentialDataset[] {
  return windows.map((w, i) => ({
    id: `box_${i}`,
    label: `${w.center.toFixed(2)} Å`,
    buildProblem: (parameters) => buildPdfProblem(structure, pattern, parameters, bindings, [], { min: w.min, max: w.max }),
  }));
}

describe("boxcar refinement through the sequential controller", () => {
  const pattern = truthPattern();
  const structure = perturbed();
  const spec = buildPdfSpec(structure, pattern);
  const windows = boxcarWindows({ range: { min: 1.5, max: 16.5 }, width: 5, step: 5 });

  it("recovers the truth in every box and reports a value+esd track per parameter", () => {
    const out = refineSequential(spec.params, boxcarDatasets(structure, pattern, spec.bindings, windows), {
      refineOptions: { maxIterations: 30 },
    });
    expect(out.steps).toHaveLength(windows.length);
    // The data IS the truth model, so every box must land on it — a boxcar over
    // a length-scale-independent structure gives a flat track.
    const cellId = spec.params.find((p) => p.kind === "cellLength")!.id;
    const track = out.evolution.find((e) => e.parameterId === cellId)!;
    expect(track.values).toHaveLength(windows.length);
    for (const v of track.values) expect(v!).toBeCloseTo(TRUE_A, 3);
    // Free parameters carry an esd; fixed rows report undefined, which the plot
    // must tolerate.
    for (const e of track.esd) expect(Number.isFinite(e!)).toBe(true);
    const qdamp = out.evolution.find((e) => e.parameterId === "qdamp")!;
    expect(qdamp.esd.every((e) => e === undefined)).toBe(true);
  });

  it("fits each box only over its own window (windows differ in observation count)", () => {
    const counts = windows.map((w) => {
      const problem = buildPdfProblem(structure, pattern, spec.params, spec.bindings, [], { min: w.min, max: w.max });
      let inWindow = 0;
      for (const wt of problem.weights) if (wt > 0) inWindow++;
      return inWindow;
    });
    // Equal-width boxes on a uniform grid hold equal point counts...
    expect(new Set(counts).size).toBe(1);
    // ...and that count is much smaller than the full grid: the box really is
    // the fitted region, not a re-weighted whole pattern.
    expect(counts[0]!).toBeLessThan(pattern.points.length / 2);
  });

  it("seeds each box from the previous one (value AND initialValue)", () => {
    const seen: number[] = [];
    const cellId = spec.params.find((p) => p.kind === "cellLength")!.id;
    const datasets = windows.map((w, i) => ({
      id: `box_${i}`,
      buildProblem: (parameters: readonly import("@/core/refinement/types").RefinementParameter[]) => {
        const p = parameters.find((q) => q.id === cellId)!;
        seen.push(p.value);
        expect(p.initialValue).toBe(p.value);
        return buildPdfProblem(structure, pattern, parameters, spec.bindings, [], { min: w.min, max: w.max });
      },
    }));
    const out = refineSequential(spec.params, datasets, { refineOptions: { maxIterations: 30 } });
    // Box 0 starts at the perturbed model; box 1 starts where box 0 converged.
    expect(seen[0]).toBeCloseTo(4.04, 6);
    expect(seen[1]).toBeCloseTo(out.steps[0]!.result.parameters[cellId]!, 12);
  });

  it("refineSequentialAsync reproduces the synchronous controller exactly", async () => {
    const datasets = boxcarDatasets(structure, pattern, spec.bindings, windows);
    const sync = refineSequential(spec.params, datasets, { refineOptions: { maxIterations: 30 } });
    const async_ = await refineSequentialAsync(spec.params, datasets, { refineOptions: { maxIterations: 30 } });
    expect(async_.steps.map((s) => s.result.parameters)).toEqual(sync.steps.map((s) => s.result.parameters));
    expect(async_.evolution).toEqual(sync.evolution);
  });

  it("reports progress once per box, in scan order", async () => {
    const seen: { index: number; total: number; id: string }[] = [];
    await refineSequentialAsync(spec.params, boxcarDatasets(structure, pattern, spec.bindings, windows), {
      refineOptions: { maxIterations: 5 },
      onStep: (step, index, total) => seen.push({ index, total, id: step.datasetId }),
    });
    expect(seen.map((s) => s.index)).toEqual(windows.map((_, i) => i));
    expect(seen.every((s) => s.total === windows.length)).toBe(true);
  });

  it("per-box random restarts never lose to the seed-only fit, and repeat exactly", async () => {
    // The boxcar's characteristic risk is path dependence: every box is seeded
    // from the last, so one box's local minimum propagates. Restarts re-search
    // each box around its seed — with the seeded start kept as the baseline
    // candidate, so a box can only improve.
    const datasets = boxcarDatasets(structure, pattern, spec.bindings, windows);
    const { refine } = await import("@/core/refinement/engine");
    const { refineMultiStart } = await import("@/core/refinement/multiStart");

    const withRestarts = (): Promise<import("@/core/refinement/sequential").SequentialResult> =>
      refineSequentialAsync(
        spec.params,
        datasets,
        { refineOptions: { maxIterations: 20 } },
        async (problem, options, _dataset, index) => {
          const w = windows[index]!;
          const ms = await refineMultiStart(
            problem.parameters,
            (start) => {
              const result = refine(
                buildPdfProblem(structure, pattern, start, spec.bindings, [], { min: w.min, max: w.max }),
                options,
              );
              return { parameters: start.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value })), final: result };
            },
            { restarts: 3, seed: 0xb0 + Math.round(w.center * 1000) },
          );
          return ms.final;
        },
      );

    const seedOnly = refineSequential(spec.params, datasets, { refineOptions: { maxIterations: 20 } });
    const restarted = await withRestarts();
    for (let i = 0; i < windows.length; i++) {
      const a = seedOnly.steps[i]!.result.agreement.rWeighted ?? Infinity;
      const b = restarted.steps[i]!.result.agreement.rWeighted ?? Infinity;
      // Same data, same window: keeping the best of (seed + restarts) can only
      // match or beat the seed alone (a hair of LM path noise allowed).
      expect(b).toBeLessThanOrEqual(a * 1.001);
    }
    // Deterministic RNG per box → a rerun reproduces the series exactly.
    const again = await withRestarts();
    expect(again.evolution).toEqual(restarted.evolution);
  });

  it("propagates a runner failure after delivering the boxes already fitted (cancel semantics)", async () => {
    const delivered: number[] = [];
    await expect(
      refineSequentialAsync(
        spec.params,
        boxcarDatasets(structure, pattern, spec.bindings, windows),
        {
          refineOptions: { maxIterations: 5 },
          onStep: (_s, index) => delivered.push(index),
        },
        async (problem, options, _dataset, index) => {
          if (index === 2) throw new Error("__refinement_cancelled__");
          const { refine } = await import("@/core/refinement/engine");
          return refine(problem, options);
        },
      ),
    ).rejects.toThrow("__refinement_cancelled__");
    expect(delivered).toEqual([0, 1]);
  });
});
