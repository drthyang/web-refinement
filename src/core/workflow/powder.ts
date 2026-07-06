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
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma, excludedPointMask, applyExclusionMask } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters, type AppliedModel } from "@/core/workflow/apply";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities } from "@/core/diffraction/intensity";
import { braggTheta } from "@/core/crystal/unitCell";
import { synthesizePattern, type ProfilePeak, type ProfileOptions, type PeakShape } from "@/core/diffraction/profile";
import type { BackgroundType } from "@/core/diffraction/background";

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
  const intensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale, undefined, applyLorentz);
  const fwhm = Math.max(applied.peakWidth, 1e-4);

  const peaks: ProfilePeak[] = [];
  for (const p of intensities) {
    const center = dToX(pattern, p.d);
    if (Number.isNaN(center)) continue;
    peaks.push({ center, intensity: p.intensity, fwhm });
  }
  return peaks;
}

export function buildPowderProblem(
  structure: StructureModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const observations = Float64Array.from(yObs);
  const weights = applyExclusionMask(
    weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1))),
    excludedPointMask(yObs),
  );
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
    return synthesizePattern(xValues, peaks, opts);
  };

  return { parameters, observations, weights, calculate };
}

export interface PowderCurves {
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
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
  const diff = yObs.map((o, i) => o - (yCalc[i] ?? 0));
  return { x, yObs, yCalc: Array.from(yCalc), diff };
}
