import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine } from "@/core/refinement/engine";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import {
  buildPdfProblem,
  buildPdfSpec,
  buildMultiPhasePdfProblem,
  buildMultiPhasePdfSpec,
  buildMultiDatasetPdfProblem,
  buildMultiDatasetPdfSpec,
  pdfCurves,
  multiPhasePdfCurves,
  pdfPhaseCurves,
  optimalPdfScale,
  guidedPdfParams,
  correlatedMotionConflict,
  PDF_STAGE_KINDS,
} from "@/core/workflow/pdf";
import { runPdfRefinement } from "@/workers/runPowder";

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

function p1Structure(cell: UnitCell, sites: AtomSite[]): StructureModel {
  return { id: "s", name: "s", cell, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

function isoSite(label: string, element: string, position: readonly [number, number, number], bIso: number): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso } };
}

/** Synthetic observed pattern: simple-cubic Ni-like crystal, known parameters. */
const TRUE_A = 4.0;
const TRUE_B_ISO = 0.5;
const TRUE_SCALE = 1.3;
const QDAMP = 0.03;

function truthPattern(): PdfPattern {
  const cell: UnitCell = { a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 };
  const atoms = expandStructureAtoms(p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]));
  const rGrid = makeRGrid(1.5, 10, 0.02);
  const g = computeGofR(cell, atoms, rGrid, {
    scatteringType: "neutron", scale: TRUE_SCALE, qdamp: QDAMP, qbroad: 0, delta1: 0, delta2: 0,
  });
  return {
    id: "pdf-synth",
    name: "synthetic Ni G(r)",
    scatteringType: "neutron",
    points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })),
    qdamp: QDAMP,
  };
}

/** Starting model perturbed off the truth (cell too big, ADP too big, scale off). */
function perturbedStructure(): StructureModel {
  const cell: UnitCell = { a: 4.05, b: 4.05, c: 4.05, alpha: 90, beta: 90, gamma: 90 };
  return p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], 0.9)]);
}

describe("buildPdfSpec", () => {
  const pattern = truthPattern();
  const spec = buildPdfSpec(perturbedStructure(), pattern);

  it("emits the PDF parameters with header-seeded Qdamp, plus the structural set", () => {
    const byId = new Map(spec.params.map((p) => [p.id, p]));
    expect(byId.get("pdfScale")).toMatchObject({ kind: "pdfScale", fixed: false });
    expect(byId.get("qdamp")).toMatchObject({ kind: "qdamp", value: QDAMP, fixed: true });
    expect(byId.get("qbroad")).toMatchObject({ kind: "qbroad", value: 0, fixed: true });
    expect(byId.get("delta1")).toMatchObject({ fixed: true });
    expect(byId.get("delta2")).toMatchObject({ fixed: true });
    // Structural rows: the metric-reduced cell (a=b=c → one parameter driving
    // all three lengths) + fixed ADP/positions/occupancy.
    const cellLengths = spec.params.filter((p) => p.kind === "cellLength");
    expect(cellLengths).toHaveLength(1);
    expect(spec.bindings.filter((b) => b.parameterId === cellLengths[0]!.id)).toHaveLength(3);
    expect(spec.params.filter((p) => p.kind === "bIso").every((p) => p.fixed)).toBe(true);
    expect(spec.params.filter((p) => p.kind === "positionShift").every((p) => p.fixed)).toBe(true);
    expect(spec.params.filter((p) => p.kind === "occupancy").every((p) => p.fixed)).toBe(true);
  });

  it("filters out the reciprocal-space leftovers (Rietveld scale, peak width)", () => {
    expect(spec.params.some((p) => p.kind === "scale")).toBe(false);
    expect(spec.params.some((p) => p.kind === "peakWidth")).toBe(false);
    const paramIds = new Set(spec.params.map((p) => p.id));
    expect(spec.bindings.every((b) => paramIds.has(b.parameterId))).toBe(true);
  });

  it("guided unlock frees the staged kinds but never occupancy or δ2", () => {
    const guided = guidedPdfParams(spec.params);
    const byId = new Map(guided.map((p) => [p.id, p]));
    expect(byId.get("delta1")!.fixed).toBe(false);
    expect(byId.get("delta2")!.fixed).toBe(true);
    expect(guided.filter((p) => p.kind === "bIso").every((p) => !p.fixed)).toBe(true);
    expect(guided.filter((p) => p.kind === "occupancy").every((p) => p.fixed)).toBe(true);
  });
});

describe("buildPdfProblem", () => {
  const pattern = truthPattern();
  const structure = perturbedStructure();
  const spec = buildPdfSpec(structure, pattern);

  it("uses uniform unit weights over G(r) — never 1/σ² (correlated errors)", () => {
    const problem = buildPdfProblem(structure, pattern, spec.params, spec.bindings);
    expect(problem.observations).toHaveLength(pattern.points.length);
    expect(Array.from(problem.weights).every((w) => w === 1)).toBe(true);
  });

  it("zeroes weights outside the fit range and keeps them inside", () => {
    const problem = buildPdfProblem(structure, pattern, spec.params, spec.bindings, [], { min: 2, max: 8 });
    for (let i = 0; i < pattern.points.length; i++) {
      const r = pattern.points[i]!.r;
      expect(problem.weights[i]).toBe(r < 2 || r > 8 ? 0 : 1);
    }
  });

  it("pair-list cache is exact: envelope-only re-evaluation is bit-identical to a fresh problem", () => {
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    const cached = buildPdfProblem(structure, pattern, spec.params, spec.bindings);
    cached.calculate(values); // prime the pair cache at the starting geometry
    const withDelta = { ...values, delta1: 0.35, pdfScale: 1.21 }; // envelope-only change → cache hit
    const hit = cached.calculate(withDelta);
    const fresh = buildPdfProblem(structure, pattern, spec.params, spec.bindings).calculate(withDelta);
    expect(Array.from(hit)).toEqual(Array.from(fresh));
  });

  it("geometry moves invalidate the cache (cell change reaches the curve)", () => {
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    const problem = buildPdfProblem(structure, pattern, spec.params, spec.bindings);
    const before = problem.calculate(values);
    const aId = spec.params.find((p) => p.kind === "cellLength")!.id;
    const after = problem.calculate({ ...values, [aId]: 4.2 });
    expect(Array.from(after)).not.toEqual(Array.from(before));
  });
});

describe("PDF refinement round-trip (synthetic neutron G(r))", () => {
  it("recovers cell, scale, and B_iso from a perturbed start", () => {
    const pattern = truthPattern();
    const structure = perturbedStructure();
    const spec = buildPdfSpec(structure, pattern);
    // Free the round-trip targets: pdfScale + cell lengths are free already; free B.
    const params = spec.params.map((p) =>
      p.kind === "bIso" ? { ...p, fixed: false } : p.kind === "cellAngle" ? { ...p, fixed: true } : { ...p },
    );

    const problem = buildPdfProblem(structure, pattern, params, spec.bindings);
    const result = refine(problem, { maxIterations: 40, convergenceTolerance: 1e-10 });

    expect(result.status).toBe("converged");
    for (const p of params) {
      if (p.kind === "cellLength") expect(result.parameters[p.id]!).toBeCloseTo(TRUE_A, 3);
    }
    expect(result.parameters["pdfScale"]!).toBeCloseTo(TRUE_SCALE, 2);
    const bId = params.find((p) => p.kind === "bIso")!.id;
    expect(result.parameters[bId]!).toBeCloseTo(TRUE_B_ISO, 1);
    // Rw over G(r) collapses to ~0 for a perfect model.
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
  });

  it("runs through the worker runner with the staged PDF sequence", () => {
    const pattern = truthPattern();
    const structure = perturbedStructure();
    const spec = buildPdfSpec(structure, pattern);
    const result = runPdfRefinement({
      type: "refinePdf",
      requestId: 0,
      structure,
      pattern,
      parameters: guidedPdfParams(spec.params).map((p) => (p.kind === "cellAngle" ? { ...p, fixed: true } : p)),
      bindings: spec.bindings,
      staged: PDF_STAGE_KINDS,
    });
    expect(result.status).toBe("converged");
    const aId = spec.params.find((p) => p.kind === "cellLength")!.id;
    expect(result.parameters[aId]!).toBeCloseTo(TRUE_A, 3);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.02);
  });
});

describe("finite-Qmax termination through the workflow", () => {
  const QMAX = 22;

  /** Truth G_obs generated through the SAME terminated pipeline (0-aligned grid). */
  function terminatedTruth(): PdfPattern {
    const cell: UnitCell = { a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 };
    const truth = p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]);
    const rGrid = makeRGrid(0.01, 12, 0.01);
    const base: PdfPattern = {
      id: "pdf-term", name: "terminated", scatteringType: "neutron",
      points: Array.from(rGrid, (r) => ({ r, gObs: 0 })), qmax: QMAX, qdamp: QDAMP,
    };
    const spec = buildPdfSpec(truth, base);
    const params = spec.params.map((p) => (p.id === "pdfScale" ? { ...p, value: TRUE_SCALE } : p));
    const problem = buildPdfProblem(truth, base, params, spec.bindings);
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const g = problem.calculate(values);
    return { ...base, points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })) };
  }

  it("a pattern with Qmax gets the sinc ripple (differs from the unterminated curve)", () => {
    // Ripple is prominent when peaks are SHARPER than the kernel width π/Qmax
    // (≈0.14 Å at Qmax 22): use a low-ADP structure. With broad peaks the model
    // is nearly band-limited already and termination is correctly ~invisible.
    const pattern = terminatedTruth();
    const cell: UnitCell = { a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 };
    const sharp = p1Structure(cell, [isoSite("Ni1", "Ni", [0, 0, 0], 0.1)]);
    const spec = buildPdfSpec(sharp, pattern);
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    const withQ = buildPdfProblem(sharp, pattern, spec.params, spec.bindings).calculate(values);
    const noQmax = { ...pattern } as { qmax?: number };
    delete noQmax.qmax;
    const withoutQ = buildPdfProblem(sharp, noQmax as PdfPattern, spec.params, spec.bindings).calculate(values);
    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < withQ.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(withQ[i]! - withoutQ[i]!));
      peak = Math.max(peak, Math.abs(withoutQ[i]!));
    }
    expect(maxDiff).toBeGreaterThan(0.05 * peak); // a real, visible effect on sharp peaks
  });

  it("refines back to the truth through the terminated model", () => {
    const pattern = terminatedTruth();
    const structure = perturbedStructure();
    const spec = buildPdfSpec(structure, pattern);
    const params = spec.params.map((p) =>
      p.kind === "bIso" ? { ...p, fixed: false } : p.kind === "cellAngle" ? { ...p, fixed: true } : { ...p },
    );
    const problem = buildPdfProblem(structure, pattern, params, spec.bindings);
    const result = refine(problem, { maxIterations: 40, convergenceTolerance: 1e-10 });
    expect(result.status).toBe("converged");
    const aId = params.find((p) => p.kind === "cellLength")!.id;
    expect(result.parameters[aId]!).toBeCloseTo(TRUE_A, 3);
    expect(result.parameters["pdfScale"]!).toBeCloseTo(TRUE_SCALE, 2);
    const bId = params.find((p) => p.kind === "bIso")!.id;
    expect(Math.abs(result.parameters[bId]! - TRUE_B_ISO)).toBeLessThan(0.05);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
  });
});

describe("multi-phase PDF (P3)", () => {
  const CELL_B: UnitCell = { a: 5.6, b: 5.6, c: 5.6, alpha: 90, beta: 90, gamma: 90 };
  const phaseA = () => p1Structure({ a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 }, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]);
  const phaseB = () => ({ ...p1Structure(CELL_B, [isoSite("Na1", "Na", [0, 0, 0], 0.6)]), id: "b", name: "NaCl-ish" });

  /** Truth: two phases with distinct scales, generated through the multi-phase pipeline. */
  function twoPhaseTruth(): { pattern: PdfPattern; scales: [number, number] } {
    const rGrid = makeRGrid(0.01, 12, 0.02);
    const base: PdfPattern = {
      id: "mp", name: "mp", scatteringType: "neutron",
      points: Array.from(rGrid, (r) => ({ r, gObs: 0 })), qmax: 20, qdamp: QDAMP,
    };
    const a = { ...phaseA(), id: "a", name: "Ni" };
    const spec = buildMultiPhasePdfSpec([a, phaseB()], base);
    const scales: [number, number] = [0.8, 0.5];
    const params = spec.params.map((p) =>
      p.id === "p0_pdfScale" ? { ...p, value: scales[0] } : p.id === "p1_pdfScale" ? { ...p, value: scales[1] } : p,
    );
    const problem = buildMultiPhasePdfProblem(spec.phases, base, params, spec.bindings);
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const g = problem.calculate(values);
    return { pattern: { ...base, points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })) }, scales };
  }

  it("spec prefixes per-phase ids, shares Qdamp/Qbroad once, re-binds phase scale", () => {
    const { pattern } = twoPhaseTruth();
    const a = { ...phaseA(), id: "a", name: "Ni" };
    const spec = buildMultiPhasePdfSpec([a, phaseB()], pattern);
    expect(spec.params.filter((p) => p.kind === "qdamp")).toHaveLength(1);
    expect(spec.params.filter((p) => p.kind === "pdfScale").map((p) => p.id).sort()).toEqual(["p0_pdfScale", "p1_pdfScale"]);
    const scaleBindings = spec.bindings.filter((b) => b.kind === "pdfScale");
    expect(scaleBindings.map((b) => b.targetId).sort()).toEqual(["a", "b"]);
    const paramIds = new Set(spec.params.map((p) => p.id));
    expect(spec.bindings.every((b) => paramIds.has(b.parameterId))).toBe(true);
  });

  it("per-phase curves sum exactly to the multi-phase calc", () => {
    const { pattern } = twoPhaseTruth();
    const a = { ...phaseA(), id: "a", name: "Ni" };
    const spec = buildMultiPhasePdfSpec([a, phaseB()], pattern);
    const total = multiPhasePdfCurves(spec.phases, pattern, spec.params, spec.bindings);
    const perPhase = pdfPhaseCurves(spec.phases, pattern, spec.params, spec.bindings);
    expect(perPhase.map((p) => p.label)).toEqual(["Ni", "NaCl-ish"]);
    let maxDiff = 0;
    for (let k = 0; k < total.x.length; k++) {
      const sum = perPhase[0]!.y[k]! + perPhase[1]!.y[k]!;
      maxDiff = Math.max(maxDiff, Math.abs(sum - total.yCalc[k]!));
    }
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it("recovers both phase scales and the perturbed cell in a two-phase fit", () => {
    const { pattern, scales } = twoPhaseTruth();
    // Perturb phase A's cell; phase B starts at truth.
    const aPerturbed = { ...p1Structure({ a: 4.04, b: 4.04, c: 4.04, alpha: 90, beta: 90, gamma: 90 }, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]), id: "a", name: "Ni" };
    const spec = buildMultiPhasePdfSpec([aPerturbed, phaseB()], pattern);
    const params = spec.params.map((p) => (p.kind === "cellAngle" ? { ...p, fixed: true } : { ...p }));
    const problem = buildMultiPhasePdfProblem(spec.phases, pattern, params, spec.bindings);
    const result = refine(problem, { maxIterations: 50, convergenceTolerance: 1e-10 });
    expect(result.status).toBe("converged");
    const aCell = params.find((p) => p.id.startsWith("p0_") && p.kind === "cellLength")!;
    expect(result.parameters[aCell.id]!).toBeCloseTo(TRUE_A, 3);
    expect(result.parameters["p0_pdfScale"]!).toBeCloseTo(scales[0], 2);
    expect(result.parameters["p1_pdfScale"]!).toBeCloseTo(scales[1], 2);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
  });

  it("runs multi-phase through the worker request path", () => {
    const { pattern } = twoPhaseTruth();
    const aPerturbed = { ...p1Structure({ a: 4.03, b: 4.03, c: 4.03, alpha: 90, beta: 90, gamma: 90 }, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]), id: "a", name: "Ni" };
    const b = phaseB();
    const spec = buildMultiPhasePdfSpec([aPerturbed, b], pattern);
    const result = runPdfRefinement({
      type: "refinePdf",
      requestId: 0,
      structure: aPerturbed,
      extraPhases: [b],
      pattern,
      parameters: spec.params.map((p) => (p.kind === "cellAngle" ? { ...p, fixed: true } : { ...p })),
      bindings: spec.bindings,
    });
    expect(result.status).toBe("converged");
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.02);
  });
});

describe("multi-dataset PDF co-refinement (P3)", () => {
  /** Two datasets from ONE truth structure: a neutron and an "X-ray" pattern
   *  with different Qdamp and scales — the joint-fit shape. */
  function jointTruth(): { neutron: PdfPattern; xray: PdfPattern } {
    const truth = p1Structure({ a: TRUE_A, b: TRUE_A, c: TRUE_A, alpha: 90, beta: 90, gamma: 90 }, [isoSite("Ni1", "Ni", [0, 0, 0], TRUE_B_ISO)]);
    const make = (id: string, scatteringType: "neutron" | "xray", qdamp: number, scale: number): PdfPattern => {
      const rGrid = makeRGrid(0.01, 10, 0.02);
      const base: PdfPattern = { id, name: id, scatteringType, points: Array.from(rGrid, (r) => ({ r, gObs: 0 })), qmax: 20, qdamp };
      const spec = buildPdfSpec(truth, base);
      const params = spec.params.map((p) => (p.id === "pdfScale" ? { ...p, value: scale } : p));
      const problem = buildPdfProblem(truth, base, params, spec.bindings);
      const values: Record<string, number> = {};
      for (const p of params) values[p.id] = p.value;
      const g = problem.calculate(values);
      return { ...base, points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })) };
    };
    return { neutron: make("ds-n", "neutron", 0.03, 1.2), xray: make("ds-x", "xray", 0.05, 0.7) };
  }

  it("spec shares the structure and sample terms, splits scale/Qdamp per dataset", () => {
    const { neutron, xray } = jointTruth();
    const structure = perturbedStructure();
    const spec = buildMultiDatasetPdfSpec(structure, [neutron, xray]);
    expect(spec.params.filter((p) => p.kind === "cellLength")).toHaveLength(1);
    expect(spec.params.filter((p) => p.kind === "delta1")).toHaveLength(1);
    expect(spec.params.filter((p) => p.kind === "pdfScale").map((p) => p.id).sort()).toEqual(["d0_pdfScale", "d1_pdfScale"]);
    expect(spec.params.filter((p) => p.kind === "qdamp").map((p) => p.id).sort()).toEqual(["d0_qdamp", "d1_qdamp"]);
    const paramIds = new Set(spec.params.map((p) => p.id));
    expect(spec.bindings.every((b) => paramIds.has(b.parameterId))).toBe(true);
  });

  it("joint neutron + X-ray fit recovers the shared cell and both scales", () => {
    const { neutron, xray } = jointTruth();
    const structure = perturbedStructure(); // a = 4.05, B = 0.9 vs truth 4.0 / 0.5
    const spec = buildMultiDatasetPdfSpec(structure, [neutron, xray]);
    const params = spec.params.map((p) =>
      p.kind === "bIso" ? { ...p, fixed: false } : p.kind === "cellAngle" ? { ...p, fixed: true } : { ...p },
    );
    const problem = buildMultiDatasetPdfProblem(structure, [neutron, xray], params, spec.bindings);
    expect(problem.observations).toHaveLength(neutron.points.length + xray.points.length);
    const result = refine(problem, { maxIterations: 50, convergenceTolerance: 1e-10 });
    expect(result.status).toBe("converged");
    const aId = params.find((p) => p.kind === "cellLength")!.id;
    expect(result.parameters[aId]!).toBeCloseTo(TRUE_A, 3);
    expect(result.parameters["d0_pdfScale"]!).toBeCloseTo(1.2, 2);
    expect(result.parameters["d1_pdfScale"]!).toBeCloseTo(0.7, 2);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
  });

  it("per-dataset fit ranges mask the right slices of the concatenated residual", () => {
    const { neutron, xray } = jointTruth();
    const structure = perturbedStructure();
    const spec = buildMultiDatasetPdfSpec(structure, [neutron, xray]);
    const problem = buildMultiDatasetPdfProblem(structure, [neutron, xray], spec.params, spec.bindings, [], [{ min: 2 }, { max: 8 }]);
    const n0 = neutron.points.length;
    expect(problem.weights[0]).toBe(0); // neutron r=0.01 < 2 masked
    expect(problem.weights[n0 - 1]).toBe(1); // neutron r=10 kept
    expect(problem.weights[n0]).toBe(1); // xray r=0.01 kept (only max bound)
    expect(problem.weights[n0 + xray.points.length - 1]).toBe(0); // xray r=10 > 8 masked
  });
});

describe("correlated-motion exclusivity guard", () => {
  it("flags δ and sratio families freed together, passes either alone", () => {
    const pattern = truthPattern();
    const spec = buildPdfSpec(perturbedStructure(), pattern);
    expect(correlatedMotionConflict(spec.params)).toBeNull();
    const freeDelta = spec.params.map((p) => (p.id === "delta1" ? { ...p, fixed: false } : p));
    expect(correlatedMotionConflict(freeDelta)).toBeNull();
    const both = freeDelta.map((p) => (p.id === "sratio" ? { ...p, fixed: false } : p));
    expect(correlatedMotionConflict(both)).toMatch(/alternative correlated-motion/);
    const stepOnly = spec.params.map((p) => (p.id === "rcut" ? { ...p, fixed: false } : p));
    expect(correlatedMotionConflict(stepOnly)).toBeNull();
  });
});

describe("pdfCurves / optimalPdfScale", () => {
  it("curves align with the observed grid and diff = obs − calc", () => {
    const pattern = truthPattern();
    const structure = perturbedStructure();
    const spec = buildPdfSpec(structure, pattern);
    const curves = pdfCurves(structure, pattern, spec.params, spec.bindings);
    expect(curves.x).toHaveLength(pattern.points.length);
    const i = 200;
    expect(curves.diff[i]).toBeCloseTo(curves.yObs[i]! - curves.yCalc[i]!, 12);
  });

  it("optimalPdfScale recovers a known multiplier", () => {
    const calc = [1, -2, 3, -1, 0.5];
    const obs = calc.map((v) => 1.7 * v);
    expect(optimalPdfScale(obs, calc)).toBeCloseTo(1.7, 12);
    expect(optimalPdfScale([0, 0], [0, 0])).toBe(1);
  });
});
