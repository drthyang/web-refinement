import { describe, it, expect } from "vitest";
import { evaluatePowderBatchOnGpu } from "@/workers/gpuPowderEvaluator";
import { buildProblemForSpec } from "@/workers/runPowder";
import type { EvaluatorSpec } from "@/workers/protocol";
import type { GpuStructureFactor, SfReflection } from "@/workers/gpuStructureFactor";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import { powderCurves } from "@/core/workflow/powder";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * The GPU powder evaluator's PLUMBING — grouping columns by cell, aligning the
 * batched |F|² back to each column, and injecting through the forward model —
 * validated in node with a STUB GPU that returns the CPU's own |F|² (through the
 * real Float32Array interface). The actual kernel numerics are validated on
 * hardware (gpuValidationHarness); here a plumbing bug (wrong column order,
 * mis-grouping, misaligned injection) would swap strong/weak reflections and blow
 * the deviation far past the f32 contract, so it is caught without a GPU.
 */
describe("evaluatePowderBatchOnGpu (plumbing, stub GPU)", () => {
  const structure = exampleStructure();
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };

  // Stub kernel: |F_N|² from the expanded atom list + reflection, mirroring the
  // WGSL formula in f64 (then truncated to f32 by the Float32Array return, like
  // real hardware). Neutron isotropic is enough to exercise the plumbing.
  function stubF2(atoms: readonly ExpandedAtom[], r: SfReflection): number {
    let fr = 0;
    let fi = 0;
    for (const a of atoms) {
      const b = neutronScatteringLength(a.element, a.isotope);
      const dw = a.adp.kind === "isotropic" ? Math.exp(-a.adp.bIso * r.s * r.s) : 1;
      const w = a.occupancy * b * dw;
      const arg = r.h * a.position[0]! + r.k * a.position[1]! + r.l * a.position[2]!;
      const phase = 2 * Math.PI * (arg - Math.floor(arg));
      fr += w * Math.cos(phase);
      fi += w * Math.sin(phase);
    }
    return fr * fr + fi * fi;
  }
  const stubGpu = {
    computeIntensities: (models: readonly (readonly ExpandedAtom[])[], reflections: readonly SfReflection[]) =>
      Promise.resolve(models.map((atoms) => Float32Array.from(reflections.map((r) => stubF2(atoms, r))))),
  } as unknown as GpuStructureFactor;

  function makeSpec(): { spec: Extract<EvaluatorSpec, { kind: "powder" }>; params: ReturnType<typeof buildPowderSpec>["params"] } {
    const grid = Array.from({ length: 900 }, (_, i) => 10 + (i * 80) / 899);
    let pattern: PowderPattern = { id: "p", name: "s", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 }, points: grid.map((x) => ({ x, yObs: 0 })) };
    const spec0 = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const sim = powderCurves(structure, pattern, spec0.params.map((p) => (p.kind === "scale" ? { ...p, value: 4 } : p)), spec0.bindings, spec0.profile);
    pattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: (sim.yCalc[i] ?? 0) + 15 })) };
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const params = spec.params.map((p) => ({ ...p, value: p.kind === "scale" ? 4 : p.value }));
    const evalSpec: Extract<EvaluatorSpec, { kind: "powder" }> = {
      kind: "powder", structure, pattern, parameters: params, bindings: spec.bindings, shape: spec.profile.shape,
      ...(spec.profile.eta !== undefined ? { eta: spec.profile.eta } : {}),
    };
    return { spec: evalSpec, params };
  }

  it("GPU-injected batch matches the CPU forward model within the f32 contract", async () => {
    const { spec, params } = makeSpec();
    const problem = buildProblemForSpec(spec);
    const base: Record<string, number> = {};
    for (const p of params) base[p.id] = p.value;

    // A realistic Jacobian batch: baseline + perturbations of several kinds,
    // including a CELL perturbation (its own reflection group) to exercise the
    // multi-group path and the same-cell grouping of the rest.
    const bump = (kinds: string[], d: number): Record<string, number> => {
      const s = { ...base };
      for (const p of params) if (kinds.includes(p.kind)) s[p.id] = p.value + d;
      return s;
    };
    const sets = [base, bump(["occupancy"], -0.02), bump(["bIso"], 0.3), bump(["positionShift"], 1e-3), bump(["cellLength"], 5e-3), bump(["scale"], 1)];

    const gpuOut = await evaluatePowderBatchOnGpu(spec, problem, stubGpu, sets);
    const cpuOut = sets.map((s) => problem.calculate(s));

    expect(gpuOut.length).toBe(sets.length);
    for (let c = 0; c < sets.length; c++) {
      let scale = 1e-30;
      for (const v of cpuOut[c]!) scale = Math.max(scale, Math.abs(v));
      let maxRel = 0;
      for (let i = 0; i < cpuOut[c]!.length; i++) maxRel = Math.max(maxRel, Math.abs(gpuOut[c]![i]! - cpuOut[c]![i]!) / scale);
      expect(maxRel, `column ${c}`).toBeLessThan(1e-4);
    }
  });
});
