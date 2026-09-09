/**
 * The mPDF arm of the evaluator-pool contract: a replica built by
 * `buildProblemForSpec({kind:"mpdf"})` must reproduce the serial trajectory
 * bit-for-bit under out-of-order batch evaluation — the guarantee that lets a
 * Web Worker / node worker-thread pool replace the serial Jacobian for magnetic
 * G(r) fits, with BOTH the geometry-keyed nuclear pair cache and the
 * geometry+moment-keyed spin-field/spin-pair caches live.
 *
 * The moment column is the sharp end: the spin field is rebuilt only when a
 * moment parameter moves, so a stale cache would show up as a Jacobian column
 * that disagrees between an in-order serial run and an out-of-order pooled one.
 */

import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { EvaluatorSpec } from "@/workers/protocol";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine, refineParallel, type BatchEvaluator } from "@/core/refinement/engine";
import { buildProblemForSpec, runMpdfRefinement } from "@/workers/runPowder";
import { buildMpdfProblem, buildMpdfSpec, MPDF_STAGE_KINDS } from "@/core/workflow/mpdf";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
const MOMENT = 3.0;

/** P1 Mn cell, k = (0,0,½): AFM stacking along c in the 1×1×2 magnetic box. */
function structureWith(a: number, bIso: number): StructureModel {
  return {
    id: "mn", name: "Mn toy", cell: { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: [IDENTITY_OP] },
    sites: [{ label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso } }],
  };
}

function magnetic(): MagneticModel {
  return {
    id: "mn-mag", structureId: "mn",
    propagation: [[0, 0, 0.5]],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [MOMENT, 0, 0], formFactorId: "Mn2" }],
  };
}

const MOMENT_PARAM: RefinementParameter = {
  id: "mom_Mn1_0", label: "Mn1 M (Mx)", kind: "momentMode", value: MOMENT, initialValue: MOMENT, min: -12, max: 12, fixed: true,
};
const MOMENT_BINDING: ParameterBinding = {
  parameterId: "mom_Mn1_0", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn1", momentBasis: [1, 0, 0],
};

const magneticBuild = { magnetic: magnetic(), params: [MOMENT_PARAM], bindings: [MOMENT_BINDING] };

/** Synthetic neutron G(r) from the truth model (nuclear + magnetic). */
function truthPattern(): PdfPattern {
  const truth = structureWith(4.4, 0.5);
  const shell: PdfPattern = {
    id: "mpdf", name: "mpdf", scatteringType: "neutron",
    points: Array.from({ length: 400 }, (_, k) => ({ r: 0.5 + k * 0.02, gObs: 0 })),
    qdamp: 0.02,
  };
  const spec = buildMpdfSpec(truth, shell, magneticBuild);
  const values: Record<string, number> = {};
  for (const p of spec.params) values[p.id] = p.value;
  const g = buildMpdfProblem(truth, spec.magnetic, shell, spec.params, spec.bindings).calculate(values);
  return { ...shell, points: shell.points.map((p, i) => ({ r: p.r, gObs: g[i]! })) };
}

/** A perturbed start with a mixed free set: linear PDF scale, nuclear geometry
 *  (cell + B → nuclear pair cache), and the moment (→ spin-field cache). */
function perturbedSpec(pattern: PdfPattern): Extract<EvaluatorSpec, { kind: "mpdf" }> {
  const structure = structureWith(4.43, 0.8);
  const built = buildMpdfSpec(structure, pattern, magneticBuild);
  const parameters = built.params.map((p) => {
    if (p.kind === "pdfScale" || p.kind === "cellLength" || p.kind === "bIso") return { ...p, fixed: false };
    if (p.kind === "momentMode") return { ...p, value: 1.8, initialValue: 1.8, fixed: false };
    return { ...p, fixed: true };
  });
  return { kind: "mpdf", structure, magnetic: built.magnetic, pattern, parameters, bindings: built.bindings };
}

describe("EvaluatorSpec {kind:'mpdf'} — pooled ≡ serial", () => {
  it("a faithful out-of-order evaluator reproduces the serial mPDF trajectory bit-for-bit", async () => {
    const spec = perturbedSpec(truthPattern());

    const serialProblem = buildProblemForSpec(spec);
    const parallelProblem = buildProblemForSpec(spec);
    const replica = buildProblemForSpec(spec); // a pool worker's copy
    const evaluator: BatchEvaluator = {
      evaluate: async (sets) => {
        const indexed = sets.map((values, i) => ({ i, values })).reverse(); // completion order ≠ submission order
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

  it("buildProblemForSpec(mpdf) matches a directly-built problem (same construction path)", () => {
    const pattern = truthPattern();
    const structure = structureWith(4.43, 0.8);
    const built = buildMpdfSpec(structure, pattern, magneticBuild);
    const spec: EvaluatorSpec = {
      kind: "mpdf", structure, magnetic: built.magnetic, pattern,
      parameters: built.params, bindings: built.bindings,
      restraints: built.restraints, fitRange: { min: 1.5 },
    };
    const fromSpec = buildProblemForSpec(spec);
    const direct = buildMpdfProblem(structure, built.magnetic, pattern, built.params, built.bindings, built.restraints, { min: 1.5 });
    const values: Record<string, number> = {};
    for (const p of built.params) values[p.id] = p.value;
    expect(Array.from(fromSpec.calculate(values))).toEqual(Array.from(direct.calculate(values)));
    expect(Array.from(fromSpec.weights)).toEqual(Array.from(direct.weights));
  });

  /**
   * The single-sublattice fixture above cannot see a spin-field/pair-cache
   * mismatch, because its spin count never changes. Two sublattices with one
   * moment free to pass through zero is where that class of bug lives — and a
   * pool member primes its replica's caches from a DIFFERENT value-set than the
   * driver, so any value-dependence in the cached geometry shows up here first.
   */
  it("holds with two sublattices when a moment passes through zero", async () => {
    const structure: StructureModel = {
      id: "mn", name: "Mn2", cell: { a: 4.4, b: 4.4, c: 4.4, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: { operations: [IDENTITY_OP] },
      sites: [
        { label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
        { label: "Mn2", element: "Mn", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
      ],
    };
    const twoSublattice: MagneticModel = {
      id: "mn-mag", structureId: "mn", propagation: [[0, 0, 0]],
      moments: [
        { siteLabel: "Mn1", frame: "crystallographic", components: [3, 0, 0], formFactorId: "Mn2" },
        { siteLabel: "Mn2", frame: "crystallographic", components: [0, 0, 0], formFactorId: "Mn2" },
      ],
    };
    const build = {
      magnetic: twoSublattice,
      params: [
        { id: "m1", label: "Mn1", kind: "momentMode", value: 3, initialValue: 3, min: -12, max: 12, fixed: false },
        // Seeded AT zero — the default seed, and the value the old magnitude
        // filter made discontinuous.
        { id: "m2", label: "Mn2", kind: "momentMode", value: 0, initialValue: 0, min: -12, max: 12, fixed: false },
      ] as RefinementParameter[],
      bindings: [
        { parameterId: "m1", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn1", momentBasis: [1, 0, 0] },
        { parameterId: "m2", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn2", momentBasis: [1, 0, 0] },
      ] as ParameterBinding[],
    };
    const shell: PdfPattern = {
      id: "mpdf2", name: "mpdf2", scatteringType: "neutron",
      points: Array.from({ length: 300 }, (_, k) => ({ r: 0.5 + k * 0.02, gObs: 0 })),
      qdamp: 0.02,
    };
    const built = buildMpdfSpec(structure, shell, build);
    const values: Record<string, number> = {};
    for (const p of built.params) values[p.id] = p.value;
    const truth = buildMpdfProblem(structure, built.magnetic, shell, built.params, built.bindings).calculate({ ...values, m2: 1.5 });
    const pattern: PdfPattern = { ...shell, points: shell.points.map((p, i) => ({ r: p.r, gObs: truth[i]! })) };

    const parameters = built.params.map((p) =>
      p.kind === "pdfScale" || p.kind === "momentMode" ? { ...p, fixed: false } : { ...p, fixed: true },
    );
    const spec: EvaluatorSpec = { kind: "mpdf", structure, magnetic: built.magnetic, pattern, parameters, bindings: built.bindings };

    const replica = buildProblemForSpec(spec);
    const evaluator: BatchEvaluator = {
      evaluate: async (sets) => {
        const indexed = sets.map((v, i) => ({ i, v })).reverse();
        const out = new Array<Float64Array>(sets.length);
        for (const { i, v } of indexed) out[i] = replica.calculate(v);
        return out;
      },
    };
    const a = refine(buildProblemForSpec(spec), { maxIterations: 12 });
    const b = await refineParallel(buildProblemForSpec(spec), { maxIterations: 12 }, evaluator);

    expect(b.history.length).toBe(a.history.length);
    for (let i = 0; i < a.history.length; i++) {
      expect(Object.is(b.history[i]!.chiSquared, a.history[i]!.chiSquared), `iteration ${i} χ²`).toBe(true);
    }
    for (const id of Object.keys(a.parameters)) {
      expect(Object.is(b.parameters[id], a.parameters[id]), `parameter ${id}`).toBe(true);
    }
    // And the free moment actually moved off its zero seed toward the truth —
    // otherwise the bit-identity above would be vacuous.
    expect(Math.abs(a.parameters["m2"]!)).toBeGreaterThan(1.0);
  });

  it("the in-thread runner recovers the truth moment, flat and staged alike", () => {
    const pattern = truthPattern();
    const spec = perturbedSpec(pattern);
    const req = {
      type: "refineMpdf" as const, requestId: 1,
      structure: spec.structure, magnetic: spec.magnetic, pattern,
      parameters: [...spec.parameters], bindings: [...spec.bindings],
      options: { maxIterations: 40, convergenceTolerance: 1e-12 },
    };
    const flat = runMpdfRefinement(req);
    expect(Math.abs(flat.parameters["mom_Mn1_0"]!)).toBeCloseTo(MOMENT, 2);
    expect(flat.agreement.rWeighted ?? 1).toBeLessThan(1e-3);

    const staged = runMpdfRefinement({ ...req, staged: MPDF_STAGE_KINDS });
    expect(Math.abs(staged.parameters["mom_Mn1_0"]!)).toBeCloseTo(MOMENT, 2);
  });
});
