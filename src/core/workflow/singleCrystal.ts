/**
 * Single-crystal atomic refinement workflow: turns a structure + reflection
 * dataset + parameters into a RefinementProblem for the engine, and provides
 * the observed/calculated comparison for plotting and export.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { singleCrystalIntensity } from "@/core/diffraction/intensity";

export interface SingleCrystalCalc {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly iObs: number;
  readonly iCalc: number;
  readonly sigma?: number;
}

export function buildSingleCrystalProblem(
  structure: StructureModel,
  dataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
): RefinementProblem {
  const observations = Float64Array.from(dataset.reflections.map((r) => r.iObs));
  const weights = weightsFromSigma(dataset.reflections.map((r) => r.sigma));

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const out = new Float64Array(dataset.reflections.length);
    for (let i = 0; i < dataset.reflections.length; i++) {
      const r = dataset.reflections[i]!;
      out[i] = singleCrystalIntensity(
        applied.model,
        dataset.radiation,
        r.h,
        r.k,
        r.l,
        applied.scale,
      );
    }
    return out;
  };

  return { parameters, observations, weights, calculate };
}

/** Observed vs calculated table for the current parameter values. */
export function singleCrystalComparison(
  structure: StructureModel,
  dataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
): SingleCrystalCalc[] {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const applied = applyParameters(structure, bindings, resolved);

  return dataset.reflections.map((r) => ({
    h: r.h,
    k: r.k,
    l: r.l,
    iObs: r.iObs,
    ...(r.sigma !== undefined ? { sigma: r.sigma } : {}),
    iCalc: singleCrystalIntensity(applied.model, dataset.radiation, r.h, r.k, r.l, applied.scale),
  }));
}
