/**
 * Magnetic single-crystal refinement workflow (Phases 6): combine nuclear and
 * magnetic Bragg intensities, keep the two contributions separately visible, and
 * refine magnetic moment components and scales.
 *
 * For unpolarized neutrons the nuclear–magnetic interference term vanishes, so
 *   I(hkl) = scale_N · |F_N|² + scale_M · |F_M⊥|².
 */

import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { momentBindingKey, type MagneticModel, type MagneticMoment } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";

/** Apply momentX/Y/Z parameter values onto a magnetic model's moments. */
export function applyMagneticMoments(
  magnetic: MagneticModel,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): MagneticModel {
  const moments: MagneticMoment[] = magnetic.moments.map((m) => ({
    ...m,
    components: [...m.components] as Vec3,
  }));
  // Keyed by the binding key (site label + split-orbit suffix): a magnetic
  // subgroup that splits a site's crystallographic orbit yields several moment
  // entries per site label, each addressed independently.
  const byKey = new Map(moments.map((m) => [momentBindingKey(m), m]));

  // Symmetry-mode bindings define the moment as m = Σ value·basis, so zero any
  // mode-driven site first, then accumulate its allowed modes.
  const modeDriven = new Set(
    bindings.filter((b) => b.kind === "momentMode" && b.targetKey).map((b) => b.targetKey!),
  );
  for (const key of modeDriven) {
    const m = byKey.get(key);
    if (m) (m.components as [number, number, number]) = [0, 0, 0];
  }

  for (const binding of bindings) {
    const v = values[binding.parameterId];
    if (v === undefined || !binding.targetKey) continue;
    const moment = byKey.get(binding.targetKey);
    if (!moment) continue;
    if (binding.kind === "momentMode" && binding.momentBasis) {
      const c = moment.components as [number, number, number];
      c[0] += v * binding.momentBasis[0]!;
      c[1] += v * binding.momentBasis[1]!;
      c[2] += v * binding.momentBasis[2]!;
    } else if (binding.kind === "momentX" || binding.kind === "momentY" || binding.kind === "momentZ") {
      const idx = binding.kind === "momentX" ? 0 : binding.kind === "momentY" ? 1 : 2;
      (moment.components as [number, number, number])[idx] = v;
    }
  }
  return { ...magnetic, moments };
}

function scalesFrom(
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): { nuclear: number; magnetic: number } {
  let nuclear = 1;
  let magnetic = 1;
  for (const b of bindings) {
    const v = values[b.parameterId];
    if (v === undefined) continue;
    if (b.kind === "scale") nuclear = v;
    if (b.kind === "magneticScale") magnetic = v;
  }
  return { nuclear, magnetic };
}

export interface MagneticReflectionCalc {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly iObs: number;
  readonly sigma?: number;
  readonly iNuclear: number;
  readonly iMagnetic: number;
  readonly iTotal: number;
}

function computeRows(
  structure: StructureModel,
  magnetic: MagneticModel,
  dataset: SingleCrystalDataset,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): MagneticReflectionCalc[] {
  const appliedMag = applyMagneticMoments(magnetic, bindings, values);
  const { nuclear, magnetic: magScale } = scalesFrom(bindings, values);
  return dataset.reflections.map((r) => {
    const iN = nuclear * nuclearStructureFactorSquared(structure, dataset.radiation, r.h, r.k, r.l);
    const iM = magScale * magneticStructureFactor(structure, appliedMag, r.h, r.k, r.l).squared;
    return {
      h: r.h,
      k: r.k,
      l: r.l,
      iObs: r.iObs,
      ...(r.sigma !== undefined ? { sigma: r.sigma } : {}),
      iNuclear: iN,
      iMagnetic: iM,
      iTotal: iN + iM,
    };
  });
}

export function buildMagneticSingleCrystalProblem(
  structure: StructureModel,
  magnetic: MagneticModel,
  dataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
): RefinementProblem {
  const observations = Float64Array.from(dataset.reflections.map((r) => r.iObs));
  const weights = weightsFromSigma(dataset.reflections.map((r) => r.sigma));

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const rows = computeRows(structure, magnetic, dataset, bindings, resolved);
    return Float64Array.from(rows.map((r) => r.iTotal));
  };

  return { parameters, observations, weights, calculate };
}

/** Per-reflection nuclear / magnetic / total intensities for the current model. */
export function magneticComparison(
  structure: StructureModel,
  magnetic: MagneticModel,
  dataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
): MagneticReflectionCalc[] {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  return computeRows(structure, magnetic, dataset, bindings, resolveTies(parameters, values));
}
