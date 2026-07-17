/**
 * Sequential refinement (temperature-series) — ONE engine-level controller
 * driving both techniques: a Rietveld (powder) series and a PDF series go
 * through the same `refineSequential`, each dataset seeded from the previous
 * refined values, and the evolution table tracks the drifting cell.
 */

import { describe, it, expect } from "vitest";
import type { PdfPattern, PowderPattern } from "@/core/diffraction/types";
import type { StructureModel } from "@/core/crystal/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine } from "@/core/refinement/engine";
import { refineSequential } from "@/core/refinement/sequential";
import { powderSequentialDatasets, pdfSequentialDatasets } from "@/core/workflow/sequential";
import { powderCurves } from "@/core/workflow/powder";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { exampleStructure } from "@/examples/mn3ga";

// ---------------------------------------------------------------------------
// Rietveld series: the Mn3Ga example with a thermally drifting a = b axis.
// ---------------------------------------------------------------------------

describe("sequential Rietveld series", () => {
  const base = exampleStructure();
  const neutron = { kind: "neutron" as const, wavelength: 1.54 };
  const grid = Array.from({ length: 400 }, (_, i) => 15 + (i * 70) / 400);
  const aTruth = [base.cell.a, base.cell.a * 1.002, base.cell.a * 1.004];

  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "pat" },
    { parameterId: "width", kind: "peakWidth", targetId: "pat" },
    { parameterId: "cell_a", kind: "cellLength", targetId: base.id, targetKey: "a" },
    { parameterId: "cell_a", kind: "cellLength", targetId: base.id, targetKey: "b" },
  ];
  const paramsAt = (scale: number, a: number, free: boolean): RefinementParameter[] => [
    { id: "scale", label: "scale", kind: "scale", value: scale, initialValue: scale, fixed: !free },
    { id: "width", label: "width", kind: "peakWidth", value: 0.4, initialValue: 0.4, fixed: true },
    { id: "cell_a", label: "a=b", kind: "cellLength", value: a, initialValue: a, fixed: !free },
  ];

  const patterns: PowderPattern[] = aTruth.map((a, i) => {
    const empty: PowderPattern = {
      id: `T${i}`, name: `T${i}`, xUnit: "twoTheta", radiation: neutron,
      points: grid.map((x) => ({ x, yObs: 0 })), wavelength: 1.54,
    };
    const truth = powderCurves(base, empty, paramsAt(100, a, false), bindings);
    return { ...empty, points: grid.map((x, k) => ({ x, yObs: truth.yCalc[k]! })) };
  });

  it("tracks a(T) across the series from one seed", () => {
    const datasets = powderSequentialDatasets(base, patterns, bindings);
    const out = refineSequential(paramsAt(80, aTruth[0]! - 0.01, true), datasets);
    expect(out.steps).toHaveLength(3);
    const aTrack = out.evolution.find((e) => e.parameterId === "cell_a")!;
    aTruth.forEach((a, i) => {
      expect(out.steps[i]!.carried).toBe(true);
      expect(aTrack.values[i]!).toBeCloseTo(a, 3);
      expect(aTrack.esd[i]).toBeDefined();
      expect(out.steps[i]!.result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
    });
  });
});

// ---------------------------------------------------------------------------
// PDF series: a P1 cubic toy with the same drifting cell — SAME controller.
// ---------------------------------------------------------------------------

describe("sequential PDF series", () => {
  const structure: StructureModel = {
    id: "ni", name: "Ni toy", cell: { a: 3.6, b: 3.6, c: 3.6, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: [{ rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" }] },
    sites: [{ label: "Ni1", element: "Ni", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.6 } }],
  };
  const aTruth = [3.6, 3.61, 3.62];
  const rGrid = makeRGrid(1.5, 12, 0.02);

  const bindings: ParameterBinding[] = [
    { parameterId: "pdfScale", kind: "pdfScale", targetId: "g" },
    ...(["a", "b", "c"] as const).map((axis): ParameterBinding => (
      { parameterId: "cell_a", kind: "cellLength", targetId: structure.id, targetKey: axis }
    )),
  ];
  const paramsAt = (a: number, free: boolean): RefinementParameter[] => [
    { id: "pdfScale", label: "scale", kind: "pdfScale", value: 1, initialValue: 1, min: 0, fixed: !free },
    { id: "cell_a", label: "a", kind: "cellLength", value: a, initialValue: a, fixed: !free },
  ];

  const patterns: PdfPattern[] = aTruth.map((a, i) => {
    const cell = { ...structure.cell, a, b: a, c: a };
    const g = computeGofR(cell, expandStructureAtoms({ ...structure, cell }), rGrid, {
      scatteringType: "neutron", scale: 1, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
    });
    return {
      id: `g${i}`, name: `G ${i}`, scatteringType: "neutron", qdamp: 0.03,
      points: Array.from(rGrid, (r, k) => ({ r, gObs: g[k]! })),
    };
  });

  it("tracks a(T) with the identical controller", () => {
    const datasets = pdfSequentialDatasets(structure, patterns, bindings);
    const out = refineSequential(paramsAt(3.585, true), datasets, { refineOptions: { maxIterations: 30 } });
    const aTrack = out.evolution.find((e) => e.parameterId === "cell_a")!;
    aTruth.forEach((a, i) => {
      expect(aTrack.values[i]!).toBeCloseTo(a, 3);
      expect(out.steps[i]!.carried).toBe(true);
    });
    // The seeding is real: step 2 starts from step 1's refined values.
    expect(out.steps[1]!.parameters.find((p) => p.id === "cell_a")!.initialValue).toBeCloseTo(aTrack.values[0]!, 10);
  });

  it("batch mode (seedFromPrevious: false) equals independent refines", () => {
    const datasets = pdfSequentialDatasets(structure, patterns, bindings);
    const out = refineSequential(paramsAt(3.595, true), datasets, { seedFromPrevious: false });
    datasets.forEach((d, i) => {
      const solo = refine(d.buildProblem(paramsAt(3.595, true)), {});
      expect(out.steps[i]!.result.parameters["cell_a"]).toBe(solo.parameters["cell_a"]);
      expect(out.steps[i]!.result.agreement.rWeighted).toBe(solo.agreement.rWeighted);
    });
  });
});
