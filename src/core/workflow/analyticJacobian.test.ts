import { describe, it, expect } from "vitest";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";
import { refine, refineParallel, type BatchEvaluator, type RefinementProblem } from "@/core/refinement/engine";

/**
 * F1.1 gate — every analytic Jacobian column must agree with the central
 * finite-difference column it replaces. This is the oracle that keeps the
 * closed-form derivatives honest: the analytic path is a second implementation
 * of the model's local behavior, and FD is the ground truth it is checked
 * against on a realistic model. First validated kinds: site occupancy and
 * isotropic B_iso (coupling-free — the derivative flows only through |F|²).
 */
describe("analytic Jacobian columns (F1.1)", () => {
  const structure = exampleStructure();
  // Realistic angle-dependent Caglioti widths + TCH Lorentzian: exactly the
  // regime where a naive "centers ride, widths fixed" shortcut would be wrong,
  // so passing here means the occ/B columns really are coupling-free.
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };

  function makeProblem(freeKinds: ReadonlySet<string>) {
    const grid = Array.from({ length: 1200 }, (_, i) => 10 + (i * 80) / 1199);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 15 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const params = spec.params.map((p) => ({
      ...p,
      value: p.kind === "scale" ? 4 : p.value,
      fixed: !(p.kind === "scale" || p.kind === "background" || freeKinds.has(p.kind)),
    }));
    return buildPowderProblem(structure, pattern, params, spec.bindings, spec.profile);
  }

  function centralDifference(problem: ReturnType<typeof buildPowderProblem>, id: string, base: number): Float64Array {
    const values: Record<string, number> = {};
    for (const p of problem.parameters) values[p.id] = p.value;
    const h = Math.max(1e-6, Math.abs(base) * 1e-5);
    const yF = problem.calculate({ ...values, [id]: base + h });
    const yB = problem.calculate({ ...values, [id]: base - h });
    const col = new Float64Array(yF.length);
    for (let i = 0; i < col.length; i++) col[i] = (yF[i]! - yB[i]!) / (2 * h);
    return col;
  }

  it("occupancy and B_iso columns match central differences; other kinds fall back", () => {
    const problem = makeProblem(new Set(["occupancy", "bIso"]));
    const freeParams = problem.parameters.filter((p) => !p.fixed);
    const freeValues = freeParams.map((p) => p.value);
    const analytic = problem.analyticColumns!(freeParams, freeValues);
    expect(analytic.length).toBe(freeParams.length);

    let checkedOcc = 0;
    let checkedB = 0;
    for (let j = 0; j < freeParams.length; j++) {
      const p = freeParams[j]!;
      if (p.kind !== "occupancy" && p.kind !== "bIso") {
        // scale/background and anything else stay on finite differences.
        expect(analytic[j]).toBeNull();
        continue;
      }
      const a = analytic[j];
      expect(a).not.toBeNull();
      const fd = centralDifference(problem, p.id, p.value);
      let maxAbs = 0;
      for (const v of fd) maxAbs = Math.max(maxAbs, Math.abs(v));
      expect(maxAbs).toBeGreaterThan(0); // the parameter actually moves the pattern
      let worst = 0;
      for (let i = 0; i < fd.length; i++) worst = Math.max(worst, Math.abs(a![i]! - fd[i]!));
      expect(worst / maxAbs).toBeLessThan(1e-5);
      if (p.kind === "occupancy") checkedOcc++;
      else checkedB++;
    }
    expect(checkedOcc).toBeGreaterThan(0);
    expect(checkedB).toBeGreaterThan(0);
  });

  it("the parallel driver never computes analytic columns (keeps them off the UI thread)", async () => {
    // The freeze regression: analytic structure-factor derivatives are computed
    // inline on whichever thread runs the generator. For refineParallel that is
    // the UI/driver thread, so it must send every column to the pool instead.
    const base = makeProblem(new Set(["occupancy", "bIso"]));
    let analyticCalls = 0;
    const spied: RefinementProblem = {
      ...base,
      analyticColumns: (fp, fv) => {
        analyticCalls++;
        return base.analyticColumns!(fp, fv);
      },
    };
    const evaluator: BatchEvaluator = {
      evaluate: (sets) => Promise.resolve(sets.map((s) => spied.calculate(s))),
    };
    await refineParallel(spied, { maxIterations: 4 }, evaluator);
    expect(analyticCalls).toBe(0);
  });

  it("opt-in serial analytic path converges to the same minimum as finite differences", () => {
    const problem = makeProblem(new Set(["occupancy", "bIso"]));
    const fd = refine(problem, { maxIterations: 20 });
    const analytic = refine(problem, { maxIterations: 20, analyticDerivatives: true });
    // Analytic and FD columns agree to <1e-5 relative, so both LM runs land in
    // the same basin at effectively the same wR.
    const wrFd = fd.agreement.rWeighted ?? 0;
    const wrAn = analytic.agreement.rWeighted ?? 0;
    expect(Math.abs(wrAn - wrFd)).toBeLessThan(1e-4);
    for (const id of Object.keys(fd.parameters)) {
      const a = analytic.parameters[id]!;
      const f = fd.parameters[id]!;
      expect(Math.abs(a - f)).toBeLessThan(1e-6 * (1 + Math.abs(f)));
    }
  });

  it("a problem with restraints exposes no analytic columns (conservative fallback)", () => {
    const grid = Array.from({ length: 400 }, (_, i) => 10 + (i * 80) / 399);
    const pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 1 })),
    };
    const spec = buildPowderSpec(structure, pattern, inst, true, 2, {});
    const occ = spec.params.find((p) => p.kind === "occupancy");
    expect(occ).toBeDefined();
    const restraint = { id: "r", label: "occ", target: occ!.value, sigma: 0.01, terms: [{ parameterId: occ!.id, coefficient: 1 }] };
    const problem = buildPowderProblem(structure, pattern, spec.params, spec.bindings, spec.profile, [restraint]);
    expect(problem.analyticColumns).toBeUndefined();
  });
});
