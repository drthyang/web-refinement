import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";
import { buildPowderSpec } from "@/app/powderSpec";
import { buildPowderProblem, buildPeaks, powderCurves } from "@/core/workflow/powder";
import { buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { applyParameters } from "@/core/workflow/apply";
import { synthesizePattern, type ProfileOptions } from "@/core/diffraction/profile";
import { resolveTies } from "@/core/refinement/constraints";
import { refine } from "@/core/refinement/engine";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter } from "@/core/refinement/types";

/**
 * The geometry cache inside the powder problems (createPeakBuilder /
 * createCombinedPeakBuilder) must be EXACT, not approximately right: a
 * cache-hit evaluation is required to be bit-identical to a cold evaluation
 * at the same values. These tests drive a problem instance through
 * hit/miss transitions (profile-only change → hit; geometry change → miss;
 * scale change → hit with the hoisted multiplier) and compare every point
 * against an uncached reference — with `toBe`-level equality via
 * Object.is on each element, not a tolerance.
 */

const structure = exampleStructure();
const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 0.2, v: -0.04, w: 0.02, x: 0.3, y: 0.05 };

function makePattern(): PowderPattern {
  const grid = Array.from({ length: 800 }, (_, i) => 10 + (i * 80) / 799);
  return {
    id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
    points: grid.map((x) => ({ x, yObs: 100 + 10 * Math.sin(x) })),
  };
}

const exactEqual = (a: Float64Array, b: Float64Array): void => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      expect.fail(`point ${i}: cached ${a[i]} !== reference ${b[i]}`);
    }
  }
};

describe("peak geometry cache — exactness", () => {
  const pattern = makePattern();
  const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});

  /** Uncached reference: the plain buildPeaks path at the given values. */
  const reference = (params: readonly RefinementParameter[]): Float64Array => {
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const resolved = resolveTies(params, values);
    const applied = applyParameters(structure, spec.bindings, resolved);
    const peaks = buildPeaks(pattern, applied, spec.profile.lorentz ?? true);
    const opts: ProfileOptions = {
      shape: spec.profile.shape,
      ...(spec.profile.eta !== undefined ? { eta: spec.profile.eta } : {}),
      ...(applied.background.length ? { background: applied.background } : {}),
    };
    return synthesizePattern(pattern.points.map((p) => p.x), peaks, opts);
  };

  it("cache hits and misses are bit-identical to the uncached path", () => {
    const problem = buildPowderProblem(structure, pattern, spec.params, spec.bindings, spec.profile);
    const valuesOf = (ps: readonly RefinementParameter[]): Record<string, number> =>
      Object.fromEntries(ps.map((p) => [p.id, p.value]));

    // Cold evaluation.
    exactEqual(problem.calculate(valuesOf(spec.params)), reference(spec.params));

    // Profile-only change → cache HIT path.
    const profileChanged = spec.params.map((p) => (p.kind === "profileW" || p.kind === "peakWidth" ? { ...p, value: p.value * 1.3 } : p));
    exactEqual(problem.calculate(valuesOf(profileChanged)), reference(profileChanged));

    // Scale change → HIT with the hoisted unit-scale multiplier.
    const scaleChanged = profileChanged.map((p) => (p.kind === "scale" ? { ...p, value: 2.7182818 } : p));
    exactEqual(problem.calculate(valuesOf(scaleChanged)), reference(scaleChanged));

    // Background change → HIT.
    const bkgChanged = scaleChanged.map((p) => (p.kind === "background" ? { ...p, value: p.value + 3.14 } : p));
    exactEqual(problem.calculate(valuesOf(bkgChanged)), reference(bkgChanged));

    // Geometry (cell) change → MISS, recompute.
    const cellChanged = bkgChanged.map((p) => (p.kind === "cellLength" ? { ...p, value: p.value * 1.002 } : p));
    exactEqual(problem.calculate(valuesOf(cellChanged)), reference(cellChanged));

    // B_iso change (Debye–Waller → intensities) → MISS.
    const bChanged = cellChanged.map((p) => (p.kind === "bIso" ? { ...p, value: p.value + 0.4 } : p));
    exactEqual(problem.calculate(valuesOf(bChanged)), reference(bChanged));

    // And back to the previous values → HIT on the stale-key check must
    // still recompute correctly (key differs from the cached one).
    exactEqual(problem.calculate(valuesOf(cellChanged)), reference(cellChanged));
  });

  it("a full refinement through the cached problem converges to the reference optimum", () => {
    // Simulate truth, perturb scale + B, refine; the trajectory runs through
    // hundreds of hit/miss transitions — the result must match the truth.
    const truth = spec.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p));
    const sim = powderCurves(structure, pattern, truth, spec.bindings, spec.profile);
    const simPattern = { ...pattern, points: pattern.points.map((pt, i) => ({ x: pt.x, yObs: (sim.yCalc[i] ?? 0) + 20 })) };
    const spec2 = buildPowderSpec(structure, simPattern, inst, true, 3, {});
    const start = spec2.params.map((p) => {
      if (p.kind === "scale") return { ...p, value: 10, fixed: false };
      if (p.kind === "bIso") return { ...p, value: 1.0, fixed: false };
      return ["background"].includes(p.kind) ? p : { ...p, fixed: true };
    });
    const problem = buildPowderProblem(structure, simPattern, start, spec2.bindings, spec2.profile);
    const r = refine(problem, { maxIterations: 20 });
    expect(100 * (r.agreement.rWeighted ?? 1)).toBeLessThan(0.1);
    const scaleId = start.find((p) => p.kind === "scale")!.id;
    expect(r.parameters[scaleId]!).toBeCloseTo(4, 4);
  });
});

describe("combined nuclear+magnetic peak cache — exactness", () => {
  it("moment and profile transitions are bit-identical to a fresh problem", () => {
    const ex = exampleMagnetic();
    const grid = Array.from({ length: 600 }, (_, i) => 10 + (i * 80) / 599);
    const pattern: PowderPattern = {
      id: "p", name: "m", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 2.41 },
      points: grid.map((x) => ({ x, yObs: 50 })),
    };
    const scale: RefinementParameter = { id: "scale", label: "s", kind: "scale", value: 5, initialValue: 5, fixed: false };
    const width: RefinementParameter = { id: "width", label: "w", kind: "peakWidth", value: 0.25, initialValue: 0.25, fixed: false };
    const params = [scale, width, ...magneticParameters(ex.magnetic)];
    const bindings = [
      { parameterId: "scale", kind: "scale" as const, targetId: ex.structure.id },
      { parameterId: "width", kind: "peakWidth" as const, targetId: pattern.id },
      ...magneticBindings(ex.magnetic),
    ];
    const cached = buildMagneticPowderProblem(ex.structure, ex.magnetic, pattern, params, bindings, { shape: "gaussian" });
    // Reference: a FRESH problem per evaluation (its first call is always cold).
    const fresh = (values: Record<string, number>): Float64Array =>
      buildMagneticPowderProblem(ex.structure, ex.magnetic, pattern, params, bindings, { shape: "gaussian" }).calculate(values);
    const base: Record<string, number> = {};
    for (const p of params) base[p.id] = p.value;

    const exact = (values: Record<string, number>): void => {
      const a = cached.calculate(values);
      const b = fresh(values);
      for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) expect.fail(`point ${i}: ${a[i]} !== ${b[i]}`);
      }
    };

    exact(base); // cold
    exact({ ...base, width: 0.4 }); // profile change → both caches HIT
    exact({ ...base, width: 0.4, scale: 9.5 }); // shared scale → HIT via hoisted multiplier
    const momentId = params.find((p) => p.kind.startsWith("moment"))!.id;
    exact({ ...base, width: 0.4, scale: 9.5, [momentId]: (base[momentId] ?? 0) + 0.7 }); // moment → magnetic MISS, nuclear HIT
  });
});
