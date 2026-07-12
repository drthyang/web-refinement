import { describe, it, expect } from "vitest";
import { buildPowderProblem, powderCurves, reflectionDRange } from "@/core/workflow/powder";
import { buildPowderSpec } from "@/app/powderSpec";
import { applyParameters } from "@/core/workflow/apply";
import { resolveTies } from "@/core/refinement/constraints";
import { generateReflections } from "@/core/diffraction/reflections";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";

/**
 * The |F|²-injection seam (the GPU evaluator's entry point) must be a PURE
 * pass-through of the CPU forward model: feeding calculate the structure factors
 * it would have computed itself yields a BIT-IDENTICAL pattern. That is what
 * makes the GPU path drift-free — it reuses the exact intensity/profile/
 * background assembly and only swaps where |F|² comes from, so the GPU result
 * differs from the CPU only by the f32 kernel's (validated, sub-esd) precision.
 */
describe("structure-factor injection seam", () => {
  const structure = exampleStructure();
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };

  function setup() {
    const grid = Array.from({ length: 1000 }, (_, i) => 10 + (i * 80) / 999);
    let pattern: PowderPattern = {
      id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 15 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    // Free the geometry groups (occupancy/B_iso/positions) — the ones whose
    // columns the GPU |F|² path accelerates.
    const params: RefinementParameter[] = spec.params.map((p) => ({
      ...p,
      value: p.kind === "scale" ? 4 : p.value,
      fixed: !["scale", "background", "occupancy", "bIso", "positionShift"].includes(p.kind),
    }));
    return { pattern, params, bindings: spec.bindings as ParameterBinding[], profile: spec.profile };
  }

  /** The CPU |F|² for a value-set, in generateReflections order, plus its window. */
  function cpuStructureFactors(pattern: PowderPattern, params: readonly RefinementParameter[], bindings: readonly ParameterBinding[], values: Record<string, number>) {
    const resolved = resolveTies(params, values);
    const applied = applyParameters(structure, bindings, resolved);
    const { dMin, dMax } = reflectionDRange(pattern, applied);
    const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
    const f2 = Float64Array.from(reflections.map((r) => nuclearStructureFactorSquared(applied.model, pattern.radiation, r.h, r.k, r.l)));
    return { f2, dMin, dMax };
  }

  it("injecting the CPU's own |F|² is bit-identical to computing it", () => {
    const { pattern, params, bindings, profile } = setup();
    const problem = buildPowderProblem(structure, pattern, params, bindings, profile);
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;

    const plain = problem.calculate(values);
    const injected = problem.calculate(values, { structureFactors: cpuStructureFactors(pattern, params, bindings, values) });

    expect(injected.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      expect(Object.is(injected[i], plain[i]), `point ${i}: ${injected[i]} !== ${plain[i]}`).toBe(true);
    }
  });

  it("a mismatched d-window is ignored (falls back to the CPU sum)", () => {
    const { pattern, params, bindings, profile } = setup();
    const problem = buildPowderProblem(structure, pattern, params, bindings, profile);
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const sf = cpuStructureFactors(pattern, params, bindings, values);

    const plain = problem.calculate(values);
    // Wrong window → the builder must NOT use this f2, computing on the CPU instead.
    const stale = problem.calculate(values, { structureFactors: { f2: new Float64Array(sf.f2.length).fill(999), dMin: sf.dMin + 1, dMax: sf.dMax } });
    for (let i = 0; i < plain.length; i++) expect(Object.is(stale[i], plain[i])).toBe(true);
  });

  it("a wrong-length |F|² for the right window is ignored (safety net)", () => {
    const { pattern, params, bindings, profile } = setup();
    const problem = buildPowderProblem(structure, pattern, params, bindings, profile);
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const sf = cpuStructureFactors(pattern, params, bindings, values);

    const plain = problem.calculate(values);
    const truncated = problem.calculate(values, { structureFactors: { f2: sf.f2.slice(0, sf.f2.length - 2), dMin: sf.dMin, dMax: sf.dMax } });
    for (let i = 0; i < plain.length; i++) expect(Object.is(truncated[i], plain[i])).toBe(true);
  });
});
