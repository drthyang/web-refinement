import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine, refineParallel, type BatchEvaluator } from "@/core/refinement/engine";
import { buildPdfProblem, buildPdfSpec, type PdfRefinementProblem } from "@/core/workflow/pdf";
import { computeGofR } from "@/core/pdf/forwardModel";
import { computeGofRWithColumns } from "@/core/pdf/gradients";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { enumeratePairs } from "@/core/pdf/pairEnumerator";
import { PDFFIT2_GOLDEN, type Pdffit2GoldenCase } from "@/core/pdf/pdffit2Golden";

/**
 * F1.1 gate for the REAL-SPACE track — every analytic PDF Jacobian column must
 * agree with the central finite-difference column it replaces, on a realistic
 * terminated problem (the PDFfit2 goldens). Also pins the fused pass's value
 * curve bit-identical to `computeGofR` (the lockstep guarantee: derivative math
 * lives in a second module, and this test is what keeps the two in step).
 */

const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };

function structureFor(c: Pdffit2GoldenCase): StructureModel {
  if (c.ops && c.sitesAniso) {
    const cell: UnitCell = { a: c.a, b: c.a, c: c.c ?? c.a, alpha: 90, beta: 90, gamma: 90 };
    const operations = c.ops.map((op, i) => ({
      rotation: op.r as unknown as [[number, number, number], [number, number, number], [number, number, number]],
      translation: [op.t[0]!, op.t[1]!, op.t[2]!] as [number, number, number],
      xyz: `op${i}`,
    }));
    const sites: AtomSite[] = c.sitesAniso.map(([el, x, y, z, u], i) => ({
      label: `${el}${i + 1}`,
      element: el,
      position: [x, y, z],
      occupancy: 1,
      adp: { kind: "anisotropic", uAniso: [u[0]!, u[1]!, u[2]!, u[3]!, u[4]!, u[5]!] },
    }));
    return { id: c.name, name: c.name, cell, spaceGroup: { operations }, sites };
  }
  const cell: UnitCell = { a: c.a, b: c.a, c: c.a, alpha: 90, beta: 90, gamma: 90 };
  const sites: AtomSite[] = c.sites.map(([el, x, y, z, u], i) => ({
    label: `${el}${i + 1}`,
    element: el,
    position: [x, y, z],
    occupancy: 1,
    adp: { kind: "isotropic", bIso: 8 * Math.PI * Math.PI * u },
  }));
  return { id: c.name, name: c.name, cell, spaceGroup: { operations: [IDENTITY_OP] }, sites };
}

function patternFor(c: Pdffit2GoldenCase, opts?: { noTermination?: boolean }): PdfPattern {
  const step = (c.rmax - c.rmin) / (c.n - 1);
  return {
    id: c.name,
    name: c.name,
    scatteringType: c.scatteringType,
    points: c.g.map((g, i) => ({ r: c.rmin + i * step, gObs: g })),
    // Without qmax the bandLimit termination is inactive. The FD-vs-analytic
    // gates prefer that: the termination convolution DELOCALIZES the forward
    // model's ±5σ window-quantization FD artifacts (isolated spikes of size
    // peak·e^{−12.5}/2h) across the whole curve, contaminating the FD oracle
    // globally — with it off, artifacts stay isolated and the Richardson
    // filter in expectColumnMatch removes them cleanly. The termination path
    // itself is identical linear code for value and columns (one bandLimit
    // call each) and keeps its own smoke gate at a documented tolerance.
    ...(opts?.noTermination ? {} : { qmax: c.qmax }),
    qdamp: c.qdamp,
    qbroad: c.qbroad,
  };
}

/** Problem for a golden case with the given kinds freed (values seeded). */
function problemFor(
  c: Pdffit2GoldenCase,
  freeKinds: ReadonlySet<string>,
  mutate?: (p: RefinementParameter) => RefinementParameter,
  opts?: { noTermination?: boolean },
): PdfRefinementProblem {
  const structure = structureFor(c);
  const pattern = patternFor(c, opts);
  const spec = buildPdfSpec(structure, pattern);
  const params = spec.params.map((p) => {
    let q: RefinementParameter = { ...p };
    if (p.id === "delta2") q = { ...q, value: c.delta2 };
    if (p.id === "spdiameter" && c.spdiameter !== undefined) q = { ...q, value: c.spdiameter };
    q = { ...q, fixed: !freeKinds.has(q.kind) };
    return mutate ? mutate(q) : q;
  });
  return buildPdfProblem(structure, pattern, params, spec.bindings, spec.restraints, { min: 1.0 });
}

function centralDifference(problem: PdfRefinementProblem, id: string, base: number, h: number): Float64Array {
  const values: Record<string, number> = {};
  for (const p of problem.parameters) values[p.id] = p.value;
  const yF = problem.calculate({ ...values, [id]: base + h });
  const yB = problem.calculate({ ...values, [id]: base - h });
  const col = new Float64Array(yF.length);
  for (let i = 0; i < col.length; i++) col[i] = (yF[i]! - yB[i]!) / (2 * h);
  return col;
}

/**
 * Assert an analytic column matches FD to relTol of the FD column's max —
 * with a Richardson-consistency filter on the FD ORACLE: the forward model's
 * ±5σ accumulation window makes each pair's support endpoints jump across grid
 * points as σ (or a peak center) moves, injecting isolated FD spikes of size
 * peak·e^{−12.5}/(2h) that scale as 1/h — they are oracle noise, not column
 * error. Points where FD(h) and FD(h/2) disagree are exactly those artifact
 * points (a true derivative agrees to O(h²)); they are excluded, must stay
 * rare, and the analytic column is checked against the finer FD elsewhere.
 */
function expectColumnMatch(problem: PdfRefinementProblem, id: string, base: number, analytic: Float64Array, relTol: number): void {
  const h = Math.max(1e-6, Math.abs(base) * 1e-5);
  const fd1 = centralDifference(problem, id, base, h);
  const fd2 = centralDifference(problem, id, base, h / 2);
  let maxAbs = 0;
  for (const v of fd1) maxAbs = Math.max(maxAbs, Math.abs(v));
  expect(maxAbs, `${id}: parameter moves the pattern`).toBeGreaterThan(0);
  let worst = 0;
  let excluded = 0;
  for (let i = 0; i < fd1.length; i++) {
    if (Math.abs(fd1[i]! - fd2[i]!) > relTol * maxAbs) {
      excluded++; // window-quantization artifact point (see docstring)
      continue;
    }
    worst = Math.max(worst, Math.abs(analytic[i]! - fd2[i]!));
  }
  expect(excluded / fd1.length, `${id}: artifact points must be rare`).toBeLessThan(0.02);
  expect(worst / maxAbs, `${id}: |analytic − FD| / max|FD|`).toBeLessThan(relTol);
}

describe("PDF analytic Jacobian — lockstep", () => {
  it("fused pass value curve is bit-identical to computeGofR (Ni golden config)", () => {
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;
    const structure = structureFor(c);
    const atoms = expandStructureAtoms(structure);
    const grid = Float64Array.from({ length: c.n }, (_, i) => c.rmin + (i * (c.rmax - c.rmin)) / (c.n - 1));
    const params = {
      scatteringType: c.scatteringType,
      scale: 1,
      qdamp: c.qdamp,
      qbroad: c.qbroad,
      delta1: 0,
      delta2: c.delta2,
    };
    const pairs = enumeratePairs(structure.cell, atoms, c.rmax + 1);
    const value = computeGofR(structure.cell, atoms, grid, params, pairs);
    const fused = computeGofRWithColumns(structure.cell, atoms, grid, params, pairs, [
      { kind: "sigma", target: "delta2" },
      { kind: "qdamp" },
    ]);
    let maxDiff = 0;
    for (let i = 0; i < value.length; i++) maxDiff = Math.max(maxDiff, Math.abs(value[i]! - fused.g[i]!));
    expect(maxDiff).toBe(0);
  });
});

describe("PDF analytic Jacobian — column vs FD (F1.1 gate)", () => {
  it("envelope/width/occupancy columns match FD on the Ni golden", () => {
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;
    const free = new Set(["qdamp", "qbroad", "delta1", "delta2", "bIso", "occupancy"]);
    const problem = problemFor(c, free, (p) =>
      // Nonzero seeds so every derivative direction is active (δ1 at 0 has a
      // one-sided bound but the derivative itself is interior-valid).
      p.id === "delta1" ? { ...p, value: 0.2 } : p,
    );
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const freeValues = freeParams.map((p) => p.value);
    const analytic = problem.analyticColumns!(freeParams, freeValues);
    expect(analytic.length).toBe(freeParams.length);

    const checked = new Map<string, number>();
    for (let j = 0; j < freeParams.length; j++) {
      const p = freeParams[j]!;
      if (!free.has(p.kind)) continue;
      const a = analytic[j];
      expect(a, `${p.id} (${p.kind}) should have an analytic column`).not.toBeNull();
      expectColumnMatch(problem, p.id, p.value, a!, 1e-5);
      checked.set(p.kind, (checked.get(p.kind) ?? 0) + 1);
    }
    for (const kind of free) expect(checked.get(kind) ?? 0, `kind ${kind} exercised`).toBeGreaterThan(0);
  });

  it("spdiameter column matches FD on the nanoparticle golden (and is null at 0)", () => {
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "ni_nano_neutron")!;
    const problem = problemFor(c, new Set(["spdiameter"]));
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    const j = freeParams.findIndex((p) => p.kind === "spdiameter");
    expect(analytic[j]).not.toBeNull();
    expectColumnMatch(problem, freeParams[j]!.id, freeParams[j]!.value, analytic[j]!, 1e-5);

    // At diameter 0 (bulk) the envelope is disabled — boundary left to FD.
    const bulk = problemFor(PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!, new Set(["spdiameter"]));
    const bulkFree = bulk.parameters.filter((p) => !p.fixed);
    const bulkCols = bulk.analyticColumns!(bulkFree, bulkFree.map((p) => p.value));
    expect(bulkCols[bulkFree.findIndex((p) => p.kind === "spdiameter")]).toBeNull();
  });

  it("uAniso columns match FD through symmetry-rotated mode bases (rutile golden)", () => {
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "rutile_aniso_xray")!;
    // Tight gate with termination off (see patternFor) — the U values are tiny
    // (~0.001–0.01) so their FD step is the 1e-6 floor, which maximizes the
    // window-quantization artifact the convolution would otherwise smear.
    const problem = problemFor(c, new Set(["uAniso"]), undefined, { noTermination: true });
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    let checked = 0;
    for (let j = 0; j < freeParams.length; j++) {
      if (freeParams[j]!.kind !== "uAniso") continue;
      expect(analytic[j], `${freeParams[j]!.id}`).not.toBeNull();
      expectColumnMatch(problem, freeParams[j]!.id, freeParams[j]!.value, analytic[j]!, 1e-5);
      checked++;
    }
    expect(checked).toBeGreaterThan(1); // several symmetry-adapted U modes

    // Terminated smoke gate: same columns through the bandLimit path. The FD
    // oracle here carries the delocalized artifact energy (measured ~2–10×10⁻³
    // relative), so the tolerance documents the ORACLE limit, not column error.
    const terminated = problemFor(c, new Set(["uAniso"]));
    const tFree = terminated.parameters.filter((p) => !p.fixed);
    const tCols = terminated.analyticColumns!(tFree, tFree.map((p) => p.value));
    for (let j = 0; j < tFree.length; j++) {
      if (tFree[j]!.kind !== "uAniso") continue;
      expectColumnMatch(terminated, tFree[j]!.id, tFree[j]!.value, tCols[j]!, 2e-2);
    }
  });

  it("positionShift columns match FD, including a mode moving both pair atoms", () => {
    // Ni P1 (4 fcc sites): a hand-built distortion mode displacing TWO sites
    // along different axes through ONE parameter — pairs between those sites
    // see both endpoints move (the R′ = n̂·(du_j − du_i) case), and pairs
    // between images of one site see du_i = du_j.
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;
    const structure = structureFor(c);
    const pattern = patternFor(c);
    const spec = buildPdfSpec(structure, pattern);
    const params: RefinementParameter[] = [
      ...spec.params.map((p) => ({ ...p, fixed: true, ...(p.id === "delta2" ? { value: c.delta2 } : {}) })),
      {
        id: "mode_1",
        label: "distortion mode",
        kind: "positionShift",
        value: 0.004,
        initialValue: 0.004,
        fixed: false,
      },
    ];
    const bindings: ParameterBinding[] = [
      ...spec.bindings,
      { parameterId: "mode_1", kind: "positionShift", targetId: structure.id, targetKey: "Ni1", axis: [0.01, 0.02, 0] },
      { parameterId: "mode_1", kind: "positionShift", targetId: structure.id, targetKey: "Ni2", axis: [0, -0.015, 0.01] },
    ];
    const problem = buildPdfProblem(structure, pattern, params, bindings, spec.restraints, { min: 1.0 });
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    const j = freeParams.findIndex((p) => p.id === "mode_1");
    expect(analytic[j]).not.toBeNull();
    expectColumnMatch(problem, "mode_1", 0.004, analytic[j]!, 1e-5);
  });

  it("positionShift columns match FD with ANISOTROPIC ADPs (n̂-rotation term)", () => {
    // Rutile carries anisotropic U — moving an atom rotates n̂ and thereby the
    // projected msd: the dmsd = 2·(U_sum n̂)·dn̂ term must be present.
    const c = PDFFIT2_GOLDEN.find((g) => g.name === "rutile_aniso_xray")!;
    const structure = structureFor(c);
    const pattern = patternFor(c);
    const spec = buildPdfSpec(structure, pattern);
    const params: RefinementParameter[] = [
      ...spec.params.map((p) => ({ ...p, fixed: true, ...(p.id === "delta2" ? { value: c.delta2 } : {}) })),
      { id: "mode_o", label: "O shift", kind: "positionShift", value: 0.003, initialValue: 0.003, fixed: false },
    ];
    const oSite = structure.sites.find((s) => s.element === "O")!;
    const bindings: ParameterBinding[] = [
      ...spec.bindings,
      { parameterId: "mode_o", kind: "positionShift", targetId: structure.id, targetKey: oSite.label, axis: [0.01, 0.01, 0] },
    ];
    const problem = buildPdfProblem(structure, pattern, params, bindings, spec.restraints, { min: 1.0 });
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    const j = freeParams.findIndex((p) => p.id === "mode_o");
    expect(analytic[j]).not.toBeNull();
    expectColumnMatch(problem, "mode_o", 0.003, analytic[j]!, 1e-5);
  });
});

describe("PDF analytic Jacobian — nulls, restraints, engine contract", () => {
  const ni = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;

  it("cell, sratio/rcut and tie-referenced parameters fall back to FD (null)", () => {
    const problem = problemFor(ni, new Set(["cellLength", "sratio", "rcut", "delta2"]), (p) =>
      p.id === "rcut" ? { ...p, value: 2.8 } : p,
    );
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    for (let j = 0; j < freeParams.length; j++) {
      const kind = freeParams[j]!.kind;
      if (kind === "cellLength" || kind === "sratio" || kind === "rcut") expect(analytic[j]).toBeNull();
      if (kind === "delta2") expect(analytic[j]).not.toBeNull();
    }
  });

  it("a free parameter referenced by a tie expression falls back to FD", () => {
    const c = ni;
    const structure = structureFor(c);
    const pattern = patternFor(c);
    const spec = buildPdfSpec(structure, pattern);
    // Tie delta1 to follow delta2: moving delta2 now ALSO moves delta1 — the
    // analytic delta2 column would miss that path, so it must be refused.
    const params = spec.params.map((p) => {
      if (p.id === "delta2") return { ...p, value: c.delta2, fixed: false };
      if (p.id === "delta1") return { ...p, expression: "= 0.5*delta2", fixed: true };
      if (p.id === "qdamp") return { ...p, fixed: false };
      return { ...p, fixed: true };
    });
    const problem = buildPdfProblem(structure, pattern, params, spec.bindings, spec.restraints, { min: 1.0 });
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    expect(analytic[freeParams.findIndex((p) => p.id === "delta2")]).toBeNull();
    // qdamp is not tie-referenced — still analytic.
    expect(analytic[freeParams.findIndex((p) => p.id === "qdamp")]).not.toBeNull();
  });

  it("restraints are supported: columns still offered, restraint rows = term coefficients", () => {
    const c = ni;
    const structure = structureFor(c);
    const pattern = patternFor(c);
    const spec = buildPdfSpec(structure, pattern);
    const params = spec.params.map((p) => ({
      ...p,
      fixed: !(p.kind === "occupancy" || p.id === "delta2"),
      ...(p.id === "delta2" ? { value: c.delta2 } : {}),
    }));
    const occIds = params.filter((p) => p.kind === "occupancy").map((p) => p.id);
    expect(occIds.length).toBeGreaterThan(0);
    const restraints = [
      {
        id: "occ-sum",
        label: "Σocc",
        target: occIds.length,
        sigma: 0.01,
        terms: occIds.map((id) => ({ parameterId: id, coefficient: 1 })),
      },
    ];
    const problem = buildPdfProblem(structure, pattern, params, spec.bindings, restraints, { min: 1.0 });
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const analytic = problem.analyticColumns!(freeParams, freeParams.map((p) => p.value));
    const nData = pattern.points.length;
    for (let j = 0; j < freeParams.length; j++) {
      const p = freeParams[j]!;
      const a = analytic[j];
      expect(a, p.id).not.toBeNull();
      expectColumnMatch(problem, p.id, p.value, a!, 1e-5);
      // The restraint row derivative is the term coefficient (1 for occupancies,
      // 0 for delta2).
      expect(a![nData]).toBe(p.kind === "occupancy" ? 1 : 0);
    }
  });

  it("refineParallel never calls analyticColumns (engine contract)", async () => {
    const base = problemFor(ni, new Set(["delta2", "qdamp"]));
    let calls = 0;
    const problem = {
      ...base,
      analyticColumns: (fp: readonly RefinementParameter[], fv: readonly number[]) => {
        calls++;
        return base.analyticColumns!(fp, fv);
      },
    };
    const evaluator: BatchEvaluator = {
      evaluate: (sets) => Promise.resolve(sets.map((s) => problem.calculate(s))),
    };
    await refineParallel(problem, { maxIterations: 2, analyticDerivatives: true }, evaluator);
    expect(calls).toBe(0);
  });

  it("FD and analytic refinements land in the same basin (Ni: scale+qdamp+δ2+B)", () => {
    const make = (): PdfRefinementProblem =>
      problemFor(ni, new Set(["pdfScale", "qdamp", "delta2", "bIso"]), (p) => {
        // Start slightly off the optimum so the fit has real work to do.
        if (p.id === "delta2") return { ...p, value: c0Delta2 };
        if (p.kind === "bIso") return { ...p, value: p.value * 1.2 };
        return p;
      });
    const c0Delta2 = ni.delta2 * 0.8;
    const fd = refine(make(), { maxIterations: 30, convergenceTolerance: 1e-8 });
    const an = refine(make(), { maxIterations: 30, convergenceTolerance: 1e-8, analyticDerivatives: true });
    const dRw = Math.abs((fd.agreement.rWeighted ?? 0) - (an.agreement.rWeighted ?? 0));
    expect(dRw).toBeLessThan(1e-4);
    for (const id of Object.keys(fd.parameters)) {
      const a = fd.parameters[id]!;
      const b = an.parameters[id]!;
      expect(Math.abs(a - b), id).toBeLessThan(1e-6 * (1 + Math.abs(a)));
    }
  });
});

describe("PDF gradChi2 — scalar gradient (NUTS contract)", () => {
  it("matches central differences of χ², including the FD fill-in for cell", () => {
    const ni = PDFFIT2_GOLDEN.find((g) => g.name === "ni_neutron")!;
    // cellLength free exercises the fill-in path (analytic column is null).
    const problem = problemFor(ni, new Set(["pdfScale", "delta2", "qdamp", "cellLength"]));
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const freeValues = freeParams.map((p) => p.value);
    const { chi2, grad } = problem.gradChi2(freeParams, freeValues);
    expect(chi2).toBeGreaterThan(0);
    expect(grad.length).toBe(freeParams.length);

    const values: Record<string, number> = {};
    for (const p of problem.parameters) values[p.id] = p.value;
    const chi2Of = (rec: Record<string, number>): number => {
      const y = problem.calculate(rec);
      let s = 0;
      for (let k = 0; k < problem.observations.length; k++) {
        const d = problem.observations[k]! - y[k]!;
        s += problem.weights[k]! * d * d;
      }
      return s;
    };
    let gradNorm = 0;
    for (const g of grad) gradNorm = Math.max(gradNorm, Math.abs(g));
    expect(gradNorm).toBeGreaterThan(0);
    for (let j = 0; j < freeParams.length; j++) {
      const id = freeParams[j]!.id;
      const base = freeValues[j]!;
      const h = Math.max(1e-7, Math.abs(base) * 1e-6);
      const fd = (chi2Of({ ...values, [id]: base + h }) - chi2Of({ ...values, [id]: base - h })) / (2 * h);
      expect(Math.abs(grad[j]! - fd) / gradNorm, id).toBeLessThan(1e-5);
    }
  });
});
