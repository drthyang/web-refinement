/**
 * GPU-accelerated batch evaluation of single-phase nuclear powder Jacobian
 * columns. Each column (value-set) is a perturbed structure; the expensive,
 * geometry-heavy stage — |F_N|² over every reflection — is batched across all
 * columns in ONE GPU dispatch, then fed back into the ordinary CPU forward model
 * through the injection seam (buildPowderProblem's calculate honors precomputed
 * structure factors). So the profile/intensity/background assembly is byte-for-
 * byte the CPU path; only |F|² comes from the GPU, at its validated f32 precision.
 *
 * Columns are grouped by (cell, d-window): a Jacobian batch is dominated by
 * position/occupancy/ADP columns that all share the baseline cell (one big
 * group); the few cell columns each form their own small group. Runs inside the
 * evaluator worker, so the driver/UI thread stays free.
 */

import type { EvaluatorSpec } from "@/workers/protocol";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { GpuStructureFactor, SfReflection } from "@/workers/gpuStructureFactor";
import { structureFactorInputs } from "@/workers/gpuStructureFactor";
import { expandStructureAtoms, type ExpandedAtom } from "@/core/diffraction/structureFactor";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { reflectionDRange } from "@/core/workflow/powder";
import { generateReflections } from "@/core/diffraction/reflections";

type PowderSpec = Extract<EvaluatorSpec, { kind: "powder" }>;

interface ColumnInfo {
  readonly set: Record<string, number>;
  readonly atoms: ExpandedAtom[];
  readonly reflections: SfReflection[];
  readonly reciprocal: { as: number; bs: number; cs: number };
  readonly dMin: number;
  readonly dMax: number;
  readonly groupKey: string;
}

/**
 * Evaluate a batch of value-sets, sourcing |F|² from the GPU. `problem` is the
 * matching powder problem (from buildProblemForSpec) whose `calculate` honors
 * injected structure factors. Returns yCalc per set, in input order.
 */
export async function evaluatePowderBatchOnGpu(
  spec: PowderSpec,
  problem: RefinementProblem,
  gpu: GpuStructureFactor,
  sets: readonly Record<string, number>[],
): Promise<Float64Array[]> {
  const radiation = spec.pattern.radiation;
  // Per column: apply the parameters, then derive the reflection list, atom list
  // and reciprocal metric the kernel needs — the SAME reflectionDRange +
  // generateReflections the injected calculate re-runs, so the |F|² order aligns.
  const infos: ColumnInfo[] = sets.map((set) => {
    const resolved = resolveTies(spec.parameters, set);
    const applied = applyParameters(spec.structure, spec.bindings, resolved);
    const { dMin, dMax } = reflectionDRange(spec.pattern, applied);
    const hkls = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax).map((r) => ({ h: r.h, k: r.k, l: r.l }));
    const { reflections, reciprocal } = structureFactorInputs(applied.model, hkls);
    const c = applied.model.cell;
    return {
      set,
      atoms: expandStructureAtoms(applied.model),
      reflections,
      reciprocal,
      dMin,
      dMax,
      // Columns share a GPU dispatch only when their reflection list is identical
      // — i.e. same cell and same d-window.
      groupKey: `${c.a},${c.b},${c.c},${c.alpha},${c.beta},${c.gamma}|${dMin}|${dMax}`,
    };
  });

  // Group by reflection list; batch each group's |F|² in one dispatch.
  const groups = new Map<string, ColumnInfo[]>();
  for (const info of infos) {
    const g = groups.get(info.groupKey);
    if (g) g.push(info);
    else groups.set(info.groupKey, [info]);
  }
  const f2ByColumn = new Map<ColumnInfo, Float64Array>();
  for (const group of groups.values()) {
    const rep = group[0]!;
    const gpuOut = await gpu.computeIntensities(group.map((g) => g.atoms), rep.reflections, radiation, rep.reciprocal);
    group.forEach((g, i) => f2ByColumn.set(g, Float64Array.from(gpuOut[i]!)));
  }

  // Reassemble in input order, injecting each column's |F|² into the CPU model.
  return infos.map((info) =>
    problem.calculate(info.set, { structureFactors: { f2: f2ByColumn.get(info)!, dMin: info.dMin, dMax: info.dMax } }),
  );
}
