/**
 * Powder atomic refinement workflow: structure + powder pattern + parameters →
 * RefinementProblem, plus obs/calc/difference curves for plotting and export.
 *
 * Minimal engine: constant-wavelength data (2θ, d, or Q). The single peak-width
 * parameter is used directly as the profile FWHM in the pattern's x-unit. TOF
 * profile handling is out of scope (see LIMITATIONS.md).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { LinearRestraint, ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma, excludedPointMask, applyExclusionMask } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters, type AppliedModel } from "@/core/workflow/apply";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, cylinderAbsorption } from "@/core/diffraction/intensity";
import { braggTheta } from "@/core/crystal/unitCell";
import { synthesizePattern, cagliotiFwhm, lorentzianFwhm, tchPseudoVoigt, fcjSubPeaks, type ProfilePeak, type ProfileOptions, type PeakShape } from "@/core/diffraction/profile";
import { evaluateBackground, type BackgroundType } from "@/core/diffraction/background";

/** Powder profile + intensity options for the refinement workflow. */
export interface PowderProfile {
  readonly shape: PeakShape;
  /** Pseudo-Voigt mixing; ignored for Gaussian. */
  readonly eta?: number;
  /** Apply the 2θ Lorentz factor. Default true; false for pre-reduced I(Q). */
  readonly lorentz?: boolean;
  /** Background model. Default Chebyshev. */
  readonly backgroundType?: BackgroundType;
}

/** Convert a d-spacing to the pattern's abscissa unit. Returns NaN if undefined. */
function dToX(pattern: PowderPattern, d: number): number {
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : undefined);
  switch (pattern.xUnit) {
    case "twoTheta": {
      if (wl === undefined) return NaN;
      const theta = braggTheta(d, wl);
      return Number.isNaN(theta) ? NaN : (2 * theta * 180) / Math.PI;
    }
    case "dSpacing":
      return d;
    case "q":
      return (2 * Math.PI) / d;
    case "tof":
      return NaN; // not modelled in the minimal engine
  }
}

function dRange(pattern: PowderPattern): { dMin: number; dMax: number } {
  const xs = pattern.points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : 1.54);
  switch (pattern.xUnit) {
    case "twoTheta": {
      const dAt = (twoThetaDeg: number): number => wl / (2 * Math.sin((twoThetaDeg / 2) * (Math.PI / 180)));
      return { dMin: dAt(xMax), dMax: dAt(xMin) };
    }
    case "dSpacing":
      return { dMin: xMin, dMax: xMax };
    case "q":
      return { dMin: (2 * Math.PI) / xMax, dMax: (2 * Math.PI) / xMin };
    case "tof":
      return { dMin: 0.5, dMax: 5 };
  }
}

export function buildPeaks(pattern: PowderPattern, applied: AppliedModel, applyLorentz = true): ProfilePeak[] {
  const { dMin, dMax } = dRange(pattern);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
  const intensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale, applied.po, applyLorentz);
  const constWidth = Math.max(applied.peakWidth, 1e-4);
  // Angle-dependent Caglioti width only makes sense on a 2θ abscissa (the form
  // is defined in 2θ). GSAS-II gives U,V,W in centidegrees², so the FWHM comes
  // out in centidegrees — divide by 100 to reach the pattern's degree unit.
  const useCaglioti = applied.caglioti !== undefined && pattern.xUnit === "twoTheta";
  // Thompson–Cox–Hastings: an independent Lorentzian size–strain width (GSAS-II
  // X,Y, also centidegrees) combined with the Gaussian per peak into a per-peak
  // FWHM and η. This is the peak-shape model real synchrotron/CW data needs.
  const useTch = applied.lorentzian !== undefined && pattern.xUnit === "twoTheta";
  // Finger–Cox–Jephcoat axial-divergence asymmetry: each peak is expanded into a
  // set of shifted sub-peaks with a low-angle tail (2θ patterns only).
  const useFcj = applied.axial !== undefined && pattern.xUnit === "twoTheta";
  const applyAbsorption = applied.muR > 0 && pattern.xUnit === "twoTheta";

  const peaks: ProfilePeak[] = [];
  for (const p of intensities) {
    let center = dToX(pattern, p.d);
    if (Number.isNaN(center)) continue;
    center += applied.zeroShift;
    const gaussianFwhm = useCaglioti ? cagliotiFwhm(center, applied.caglioti!) / 100 : constWidth;
    let fwhm: number;
    let eta: number | undefined;
    if (useTch) {
      const gammaL = lorentzianFwhm(center, applied.lorentzian!) / 100;
      const tch = tchPseudoVoigt(gaussianFwhm, gammaL);
      fwhm = Math.max(tch.fwhm, 1e-4);
      eta = tch.eta;
    } else {
      fwhm = Math.max(gaussianFwhm, 1e-4);
    }
    // GSAS-II cylinder absorption A(μR, 2θ) multiplies the calculated intensity.
    const intensity = applyAbsorption ? p.intensity * cylinderAbsorption(applied.muR, center) : p.intensity;
    if (useFcj) {
      for (const sub of fcjSubPeaks(center, applied.axial!)) {
        const i = intensity * sub.weight;
        peaks.push(eta !== undefined ? { center: sub.center, intensity: i, fwhm, eta } : { center: sub.center, intensity: i, fwhm });
      }
    } else {
      peaks.push(eta !== undefined ? { center, intensity, fwhm, eta } : { center, intensity, fwhm });
    }
  }
  return peaks;
}

export function buildPowderProblem(
  structure: StructureModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
  restraints: readonly LinearRestraint[] = [],
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const observations = Float64Array.from([...yObs, ...restraints.map((r) => r.target)]);
  const diffractionWeights = applyExclusionMask(
    weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1))),
    excludedPointMask(yObs),
  );
  const weights = new Float64Array(observations.length);
  weights.set(diffractionWeights, 0);
  for (let i = 0; i < restraints.length; i++) {
    const sigma = Math.max(restraints[i]!.sigma, 1e-12);
    weights[xValues.length + i] = 1 / (sigma * sigma);
  }
  const applyLorentz = profile.lorentz ?? true;

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const peaks = buildPeaks(pattern, applied, applyLorentz);
    const opts: ProfileOptions = {
      shape: profile.shape,
      ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      ...(profile.backgroundType !== undefined ? { backgroundType: profile.backgroundType } : {}),
      ...(applied.background.length ? { background: applied.background } : {}),
    };
    const yCalc = synthesizePattern(xValues, peaks, opts);
    if (restraints.length === 0) return yCalc;
    const withRestraints = new Float64Array(yCalc.length + restraints.length);
    withRestraints.set(yCalc, 0);
    for (let i = 0; i < restraints.length; i++) {
      const restraint = restraints[i]!;
      let value = 0;
      for (const term of restraint.terms) value += term.coefficient * (resolved[term.parameterId] ?? 0);
      withRestraints[yCalc.length + i] = value;
    }
    return withRestraints;
  };

  return { parameters, observations, weights, calculate };
}

export interface PowderCurves {
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
  readonly yBackground?: number[];
  readonly diff: number[];
}

/** Observed / calculated / difference curves for the current parameters. */
export function powderCurves(
  structure: StructureModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
): PowderCurves {
  const problem = buildPowderProblem(structure, pattern, parameters, bindings, profile);
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const yCalc = problem.calculate(values);
  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const resolved = resolveTies(parameters, values);
  const applied = applyParameters(structure, bindings, resolved);
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const bgType = profile.backgroundType ?? "chebyshev";
  const yBackground = x.map((xv) => evaluateBackground(xv, applied.background, bgType, xMin, xMax));
  const diff = yObs.map((o, i) => o - (yCalc[i] ?? 0));
  return { x, yObs, yCalc: Array.from(yCalc), yBackground, diff };
}
