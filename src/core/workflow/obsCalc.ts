/**
 * Per-reflection observed vs calculated integrated intensities for a powder
 * pattern (the data behind an F_obs vs F_calc plot).
 *
 * Powder intensities overlap, so |F_obs| is not measured directly — it is
 * *apportioned* from the observed profile by the calculated peak shapes (the
 * standard Rietveld decomposition):
 *   I_obs(k) = Σᵢ [ Sₖ(xᵢ)·I_calc(k) / Σⱼ Sⱼ(xᵢ)·I_calc(j) ] · (y_obs(i) − bkg(i)),
 * where Sₖ is the normalized peak profile. With a perfect fit (y_obs = y_calc)
 * this returns I_obs(k) = I_calc(k). Returns intensities; |F| ∝ √I.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { placePeaks, reflectionDRange, type PowderProfile } from "@/core/workflow/powder";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities } from "@/core/diffraction/intensity";
import { evaluateBackground } from "@/core/diffraction/background";
import { gaussian, pseudoVoigt, tofBackToBack, type ProfilePeak } from "@/core/diffraction/profile";

export interface ReflectionObsCalc {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly iObs: number;
  readonly iCalc: number;
}

/** Normalized profile value of one placed peak at x (∫ ≈ 1). */
function peakValue(pk: ProfilePeak, x: number): number {
  if (pk.tof) return tofBackToBack(x - pk.center, pk.tof);
  if (pk.eta !== undefined) return pseudoVoigt(x, pk.center, pk.fwhm, pk.eta);
  return gaussian(x, pk.center, pk.fwhm);
}

/**
 * Rietveld-decomposed observed vs calculated intensities per reflection for the
 * current parameters. Reflections whose peaks fall outside the measured abscissa
 * are dropped.
 */
export function powderReflectionObsCalc(
  structure: StructureModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
): ReflectionObsCalc[] {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const applied = applyParameters(structure, bindings, resolved);

  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const bgType = profile.backgroundType ?? "chebyshev";
  const bkg = x.map((xv) => evaluateBackground(xv, applied.background, bgType, xMin, xMax));

  const { dMin, dMax } = reflectionDRange(pattern, applied);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
  const applyLorentz = profile.lorentz ?? true;
  const intensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale, applied.po, applyLorentz);

  // Each reflection's normalized (intensity-1) sub-peaks, so its calculated
  // profile at xᵢ is Σ_sub sub.intensity·peakValue(sub, xᵢ).
  const perRefl = reflections.map((r, i) => ({
    r,
    iCalc: intensities[i]!.intensity,
    sub: placePeaks(pattern, applied, [{ d: r.d, intensity: 1 }]),
  }));

  // Total calculated peak intensity (background excluded) at each point.
  const total = new Float64Array(x.length);
  const contrib = perRefl.map((pr) => {
    const arr = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (const pk of pr.sub) s += pk.intensity * peakValue(pk, x[i]!);
      const c = s * pr.iCalc;
      arr[i] = c;
      total[i]! += c;
    }
    return arr;
  });

  const out: ReflectionObsCalc[] = [];
  perRefl.forEach((pr, ri) => {
    const c = contrib[ri]!;
    // I_calc and I_obs are both the peak's summed calc profile: I_calc = Σᵢ cₖ(i),
    // and I_obs apportions the observed point intensity by the same weights, so
    // they are on one scale (iObs = iCalc for a perfect fit) and the ratio is
    // meaningful. This is proportional to the integrated intensity.
    let iObs = 0;
    let iCalc = 0;
    let inRange = false;
    for (let i = 0; i < x.length; i++) {
      const t = total[i]!;
      if (c[i]! <= 0) continue;
      iCalc += c[i]!;
      if (t > 0) {
        inRange = true;
        iObs += (c[i]! / t) * (yObs[i]! - bkg[i]!);
      }
    }
    if (!inRange || iCalc <= 0) return; // peak outside the measured range
    out.push({ h: pr.r.h, k: pr.r.k, l: pr.r.l, d: pr.r.d, iObs, iCalc });
  });
  return out;
}
