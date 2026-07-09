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

  // Symmetry-mode and shared-magnitude bindings define the moment fully, so
  // zero any driven site first, then accumulate.
  const driven = new Set(
    bindings
      .filter(
        (b) =>
          (b.kind === "momentMode" || b.kind === "momentMagnitude" || b.kind === "momentAngle") &&
          b.targetKey,
      )
      .map((b) => b.targetKey!),
  );
  for (const key of driven) {
    const m = byKey.get(key);
    if (m) (m.components as [number, number, number]) = [0, 0, 0];
  }

  // Shared-magnitude parametrization: per moment key, gather |M| with its ê₁
  // and the direction angles φ (→ê₂) and θ (→ê₃); the frame vectors ride on
  // the bindings (see ParameterBinding.momentBasis).
  interface Spherical { M: number; e1?: Vec3; phi: number; e2?: Vec3; theta: number; e3?: Vec3 }
  const spherical = new Map<string, Spherical>();

  for (const binding of bindings) {
    const v = values[binding.parameterId];
    if (v === undefined || !binding.targetKey) continue;
    if (binding.kind === "momentMagnitude" || binding.kind === "momentAngle") {
      if (!binding.momentBasis || !byKey.has(binding.targetKey)) continue;
      let s = spherical.get(binding.targetKey);
      if (!s) { s = { M: 0, phi: 0, theta: 0 }; spherical.set(binding.targetKey, s); }
      if (binding.kind === "momentMagnitude") {
        s.M = v;
        s.e1 = binding.momentBasis as Vec3;
      } else if (binding.angleIndex === 1) {
        s.theta = v;
        s.e3 = binding.momentBasis as Vec3;
      } else {
        s.phi = v;
        s.e2 = binding.momentBasis as Vec3;
      }
      continue;
    }
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

  // m = |M|·(cos θ·(cos φ·ê₁ + sin φ·ê₂) + sin θ·ê₃): with an orthonormal
  // frame the magnitude is |M| exactly, for every angle (degrees).
  const RAD = Math.PI / 180;
  for (const [key, s] of spherical) {
    const moment = byKey.get(key);
    if (!moment || !s.e1) continue;
    const cp = Math.cos(s.phi * RAD);
    const sp = Math.sin(s.phi * RAD);
    const ct = Math.cos(s.theta * RAD);
    const st = Math.sin(s.theta * RAD);
    const c = moment.components as [number, number, number];
    for (let i = 0; i < 3; i++) {
      c[i]! += s.M * (ct * (cp * (s.e1[i] ?? 0) + sp * (s.e2?.[i] ?? 0)) + st * (s.e3?.[i] ?? 0));
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
