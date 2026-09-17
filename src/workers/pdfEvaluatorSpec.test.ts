import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { EvaluatorSpec, RefinePdfRequest } from "@/workers/protocol";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine, refineParallel, type BatchEvaluator } from "@/core/refinement/engine";
import { buildProblemForSpec, runPdfRefinement } from "@/workers/runPowder";
import { buildPdfSpec, buildPdfProblem } from "@/core/workflow/pdf";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";

/**
 * The PDF arm of the evaluator-pool contract: a replica built by
 * `buildProblemForSpec({kind:"pdf"})` must reproduce the serial trajectory
 * bit-for-bit under out-of-order batch evaluation — the guarantee that lets a
 * Web Worker / node worker-thread pool replace the serial Jacobian for G(r)
 * fits, geometry-keyed pair cache included.
 */

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };
const CELL: UnitCell = { a: 4.0, b: 4.0, c: 4.0, alpha: 90, beta: 90, gamma: 90 };

function structureWith(a: number, bIso: number): StructureModel {
  const sites: AtomSite[] = [{ label: "Ni1", element: "Ni", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso } }];
  return { id: "s", name: "s", cell: { ...CELL, a, b: a, c: a }, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

function truthPattern(): PdfPattern {
  const truth = structureWith(4.0, 0.5);
  const rGrid = makeRGrid(0.01, 10, 0.02); // 0-aligned → termination active
  const g = computeGofR(truth.cell, expandStructureAtoms(truth), rGrid, {
    scatteringType: "neutron", scale: 1.25, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
  });
  return {
    id: "pdf", name: "pdf", scatteringType: "neutron",
    points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })), qmax: 20, qdamp: 0.03,
  };
}

describe("EvaluatorSpec {kind:'pdf'} — pooled ≡ serial", () => {
  it("a faithful out-of-order evaluator reproduces the serial PDF trajectory bit-for-bit", async () => {
    const pattern = truthPattern();
    const structure = structureWith(4.03, 0.8);
    const built = buildPdfSpec(structure, pattern);
    // Mixed free set: linear scale, geometry (cell + B → pair cache), envelope (δ1).
    const parameters = built.params.map((p) => {
      if (p.kind === "pdfScale" || p.kind === "cellLength" || p.kind === "bIso" || p.id === "delta1") return { ...p, fixed: false };
      return { ...p, fixed: true };
    });
    const spec: EvaluatorSpec = { kind: "pdf", structure, pattern, parameters, bindings: built.bindings };

    const serialProblem = buildProblemForSpec(spec);
    const parallelProblem = buildProblemForSpec(spec);
    const replica = buildProblemForSpec(spec); // a pool worker's copy
    const evaluator: BatchEvaluator = {
      evaluate: async (sets) => {
        const indexed = sets.map((values, i) => ({ i, values })).reverse(); // pool completion order ≠ submission order
        const out = new Array<Float64Array>(sets.length);
        for (const { i, values } of indexed) out[i] = replica.calculate(values);
        return out;
      },
    };

    const a = refine(serialProblem, { maxIterations: 10 });
    const b = await refineParallel(parallelProblem, { maxIterations: 10 }, evaluator);

    expect(b.status).toBe(a.status);
    expect(b.history.length).toBe(a.history.length);
    for (let i = 0; i < a.history.length; i++) {
      expect(Object.is(b.history[i]!.chiSquared, a.history[i]!.chiSquared), `iteration ${i} χ²`).toBe(true);
    }
    for (const id of Object.keys(a.parameters)) {
      expect(Object.is(b.parameters[id], a.parameters[id]), `parameter ${id}`).toBe(true);
      expect(Object.is(b.esd[id], a.esd[id]), `esd ${id}`).toBe(true);
    }
    expect(b.agreement).toEqual(a.agreement);
  });

  it("buildProblemForSpec(pdf) matches a directly-built problem (same construction path)", () => {
    const pattern = truthPattern();
    const structure = structureWith(4.03, 0.8);
    const built = buildPdfSpec(structure, pattern);
    const spec: EvaluatorSpec = {
      kind: "pdf", structure, pattern,
      parameters: built.params, bindings: built.bindings,
      restraints: built.restraints, fitRange: { min: 1.5 },
    };
    const fromSpec = buildProblemForSpec(spec);
    const direct = buildPdfProblem(structure, pattern, built.params, built.bindings, built.restraints, { min: 1.5 });
    const values: Record<string, number> = {};
    for (const p of built.params) values[p.id] = p.value;
    expect(Array.from(fromSpec.calculate(values))).toEqual(Array.from(direct.calculate(values)));
    expect(Array.from(fromSpec.weights)).toEqual(Array.from(direct.weights));
  });
});

/**
 * The serial runner's Jacobian policy. `refine` runs off the UI thread wherever
 * `runPdfRefinement` does (a Web Worker in the browser, in-process in node/MCP),
 * so it takes the problem's exact closed-form columns instead of paying two
 * evaluations per column for a finite difference.
 */
describe("runPdfRefinement — analytic columns by default", () => {
  const setUp = (): { req: RefinePdfRequest; problem: () => ReturnType<typeof buildPdfProblem> } => {
    const pattern = truthPattern();
    const structure = structureWith(4.03, 0.8);
    const built = buildPdfSpec(structure, pattern);
    // A realistic mix: the linear scale (exact column either way), qdamp and
    // B_iso (analytic), and the cell length (no analytic column yet → FD).
    const free = new Set(["pdfScale", "qdamp", "bIso", "cellLength"]);
    const parameters = built.params.map((p) => ({ ...p, fixed: !free.has(p.kind) }));
    return {
      req: {
        type: "refinePdf", requestId: 0, structure, pattern,
        parameters, bindings: built.bindings, options: { maxIterations: 4 },
      },
      problem: () => buildPdfProblem(structure, pattern, parameters, built.bindings, [], undefined),
    };
  };

  it("takes the analytic path unless the request pins finite differences", () => {
    const { req, problem } = setUp();
    const opts = { maxIterations: 4 };
    const analytic = refine(problem(), { ...opts, analyticDerivatives: true });
    const fd = refine(problem(), opts);
    // The two Jacobians are genuinely different (FD carries truncation error),
    // so matching one and not the other pins which path the runner took.
    expect(analytic.parameters).not.toEqual(fd.parameters);

    expect(runPdfRefinement(req).parameters).toEqual(analytic.parameters);
    expect(
      runPdfRefinement({ ...req, options: { ...opts, analyticDerivatives: false } }).parameters,
    ).toEqual(fd.parameters);
  });
});
