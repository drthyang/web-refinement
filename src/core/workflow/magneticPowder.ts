/**
 * Magnetic powder refinement (Phase 7): combine nuclear and magnetic Bragg
 * intensities into a single powder profile, keeping the two components
 * separable, and refine moments + scales against an observed pattern.
 *
 * Minimal engine: the magnetic intensity for a reflection uses the perpendicular
 * projection for the representative reflection of each family; a full cone
 * average over symmetry-equivalent Q directions is a documented approximation.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { ProfilePeak, ProfileOptions, PeakShape } from "@/core/diffraction/profile";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, lorentzPolarization } from "@/core/diffraction/intensity";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { braggTheta } from "@/core/crystal/unitCell";
import { synthesizePattern } from "@/core/diffraction/profile";

function dToTwoTheta(pattern: PowderPattern, d: number): number {
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : 1.54);
  const theta = braggTheta(d, wl);
  return Number.isNaN(theta) ? NaN : (2 * theta * 180) / Math.PI;
}

function dRange(pattern: PowderPattern): { dMin: number; dMax: number } {
  const xs = pattern.points.map((p) => p.x);
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : 1.54);
  const dAt = (tt: number) => wl / (2 * Math.sin((tt / 2) * (Math.PI / 180)));
  return { dMin: dAt(Math.max(...xs)), dMax: dAt(Math.min(...xs)) };
}

export interface MagneticPowderComponents {
  readonly x: number[];
  readonly yObs: number[];
  readonly yNuclear: number[];
  readonly yMagnetic: number[];
  readonly yCalc: number[];
  readonly diff: number[];
}

interface Peaks {
  readonly nuclear: ProfilePeak[];
  readonly magnetic: ProfilePeak[];
}

function buildCombinedPeaks(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  values: Readonly<Record<string, number>>,
  bindings: readonly ParameterBinding[],
): Peaks {
  const applied = applyParameters(structure, bindings, values);
  const appliedMag = applyMagneticMoments(magnetic, bindings, values);
  const magScale = bindings.some((b) => b.kind === "magneticScale")
    ? values[bindings.find((b) => b.kind === "magneticScale")!.parameterId] ?? 1
    : 1;

  const { dMin, dMax } = dRange(pattern);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
  const fwhm = Math.max(applied.peakWidth, 1e-4);

  const nuclearIntensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale);
  const nuclear: ProfilePeak[] = [];
  const magneticPeaks: ProfilePeak[] = [];

  for (let i = 0; i < reflections.length; i++) {
    const r = reflections[i]!;
    const center = dToTwoTheta(pattern, r.d);
    if (Number.isNaN(center)) continue;
    nuclear.push({ center, intensity: nuclearIntensities[i]!.intensity, fwhm });

    const fm2 = magneticStructureFactor(applied.model, appliedMag, r.h, r.k, r.l).squared;
    const lp = lorentzPolarization(pattern.radiation, r.d);
    const iMag = magScale * r.multiplicity * lp * fm2;
    magneticPeaks.push({ center, intensity: iMag, fwhm });
  }
  return { nuclear, magnetic: magneticPeaks };
}

export function buildMagneticPowderProblem(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const observations = Float64Array.from(pattern.points.map((p) => p.yObs));
  const weights = weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1)));

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const { nuclear, magnetic: magPeaks } = buildCombinedPeaks(structure, magnetic, pattern, resolved, bindings);
    const opts: ProfileOptions = {
      shape: profile.shape,
      ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      ...(applied.background.length ? { background: applied.background } : {}),
    };
    return synthesizePattern(xValues, [...nuclear, ...magPeaks], opts);
  };
  return { parameters, observations, weights, calculate };
}

/** Observed / nuclear / magnetic / total / difference curves for the current model. */
export function magneticPowderComponents(
  structure: StructureModel,
  magnetic: MagneticModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
): MagneticPowderComponents {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const xValues = pattern.points.map((p) => p.x);
  const applied = applyParameters(structure, bindings, resolved);
  const { nuclear, magnetic: magPeaks } = buildCombinedPeaks(structure, magnetic, pattern, resolved, bindings);
  const bkgOpts: ProfileOptions = { shape: profile.shape, ...(applied.background.length ? { background: applied.background } : {}) };
  const yNuclear = Array.from(synthesizePattern(xValues, nuclear, bkgOpts));
  const yMagnetic = Array.from(synthesizePattern(xValues, magPeaks, { shape: profile.shape }));
  const yObs = pattern.points.map((p) => p.yObs);
  const yCalc = yNuclear.map((n, i) => n + (yMagnetic[i] ?? 0));
  return {
    x: [...xValues],
    yObs,
    yNuclear,
    yMagnetic,
    yCalc,
    diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)),
  };
}
