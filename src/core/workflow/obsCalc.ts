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
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { placePeaks, reflectionDRange, type PowderProfile } from "@/core/workflow/powder";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, lorentzPolarization } from "@/core/diffraction/intensity";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { dSpacing } from "@/core/crystal/unitCell";
import { evaluateBackground } from "@/core/diffraction/background";
import { gaussian, pseudoVoigt, tofBackToBack, type ProfilePeak } from "@/core/diffraction/profile";

export interface ReflectionObsCalc {
  /** Nuclear Bragg reflection, or a magnetic satellite at G ± k. */
  readonly kind: "nuclear" | "magnetic";
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly iObs: number;
  readonly iCalc: number;
}

/** One peak (nuclear or magnetic) contributing to the decomposition. */
interface Component {
  readonly kind: "nuclear" | "magnetic";
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly iCalc: number;
  readonly sub: ProfilePeak[];
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
  magnetic: MagneticModel | null = null,
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

  // Every peak (nuclear + magnetic) that contributes to the profile, each with
  // its normalized (intensity-1) sub-peaks, so its calculated profile at xᵢ is
  // Σ_sub sub.intensity·peakValue(sub, xᵢ). Nuclear and magnetic share the one
  // `total` below, so overlapping obs intensity is apportioned across both.
  const components: Component[] = reflections.map((r, i) => ({
    kind: "nuclear" as const,
    h: r.h, k: r.k, l: r.l, d: r.d,
    iCalc: intensities[i]!.intensity,
    sub: placePeaks(pattern, applied, [{ d: r.d, intensity: 1 }]),
  }));

  // Magnetic satellites at G ± k (single commensurate k), on the same scale as
  // the nuclear peaks — mirrors buildCombinedPeaks in magneticPowder.ts. Only
  // reflections carrying a non-negligible |F_M|² are kept, matching the magnetic
  // Bragg tick row (so the scatter and the plot's magnetic peaks agree).
  if (magnetic && magnetic.moments.length > 0) {
    const appliedMag = applyMagneticMoments(magnetic, bindings, resolved);
    const magScaleBinding = bindings.find((b) => b.kind === "magneticScale");
    const magFactor = magScaleBinding ? resolved[magScaleBinding.parameterId] ?? 1 : 1;
    const magScale = applied.scale * magFactor;
    const kVec = appliedMag.propagation[0] ?? [0, 0, 0];
    const isK0 = kVec.every((v) => Math.abs(v) < 1e-9);
    const mags: Component[] = [];
    for (const r of reflections) {
      const sats: [number, number, number][] = isK0
        ? [[r.h, r.k, r.l]]
        : [[r.h + kVec[0]!, r.k + kVec[1]!, r.l + kVec[2]!], [r.h - kVec[0]!, r.k - kVec[1]!, r.l - kVec[2]!]];
      for (const [mh, mk, ml] of sats) {
        const dSat = dSpacing(applied.model.cell, mh, mk, ml);
        if (!Number.isFinite(dSat) || dSat <= 0 || dSat < dMin || dSat > dMax) continue;
        const fm2 = magneticStructureFactor(applied.model, appliedMag, mh, mk, ml).squared;
        const lp = lorentzPolarization(pattern.radiation, dSat);
        mags.push({
          kind: "magnetic", h: mh, k: mk, l: ml, d: dSat,
          iCalc: magScale * r.multiplicity * lp * fm2,
          sub: placePeaks(pattern, applied, [{ d: dSat, intensity: 1 }]),
        });
      }
    }
    const maxMag = mags.reduce((m, c) => (c.iCalc > m ? c.iCalc : m), 0);
    if (maxMag > 0) {
      const eps = maxMag * 1e-4;
      for (const c of mags) if (c.iCalc > eps) components.push(c);
    }
  }

  // Total calculated peak intensity (background excluded) at each point.
  const total = new Float64Array(x.length);
  const contrib = components.map((cmp) => {
    const arr = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (const pk of cmp.sub) s += pk.intensity * peakValue(pk, x[i]!);
      const c = s * cmp.iCalc;
      arr[i] = c;
      total[i]! += c;
    }
    return arr;
  });

  const out: ReflectionObsCalc[] = [];
  components.forEach((cmp, ri) => {
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
    out.push({ kind: cmp.kind, h: cmp.h, k: cmp.k, l: cmp.l, d: cmp.d, iObs, iCalc });
  });
  return out;
}
