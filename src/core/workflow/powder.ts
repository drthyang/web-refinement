/**
 * Powder atomic refinement workflow: structure + powder pattern + parameters →
 * RefinementProblem, plus obs/calc/difference curves for plotting and export.
 *
 * Handles constant-wavelength data (2θ, d, or Q) with a Caglioti/TCH width and
 * time-of-flight data with the back-to-back-exponential profile. `placePeaks`
 * factors out the abscissa placement + instrument profile so the magnetic path
 * (satellites at G±k) reuses the exact same positioning and resolution.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { LinearRestraint, ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma, excludedPointMask, applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters, type AppliedModel } from "@/core/workflow/apply";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, cylinderAbsorption } from "@/core/diffraction/intensity";
import { braggTheta } from "@/core/crystal/unitCell";
import { dFromTof } from "@/core/diffraction/instrument";
import { synthesizePattern, cagliotiFwhm, lorentzianFwhm, tchPseudoVoigt, fcjSubPeaks, type ProfilePeak, type ProfileOptions, type PeakShape } from "@/core/diffraction/profile";
import { evaluateBackground, type BackgroundType } from "@/core/diffraction/background";
import { quarticStrainInvariants, stephensStrainFwhmDeg, type QuarticInvariant } from "@/core/diffraction/anisoStrain";
import { uniaxialSizeFwhmDeg } from "@/core/diffraction/anisoSize";

/** Inclusive abscissa window that restricts refinement to a sub-range of the
 * pattern. Either bound may be omitted to leave that side unrestricted. */
export interface FitRange {
  readonly min?: number;
  readonly max?: number;
}

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

/** Smallest d-spacing (Å) modelled for a TOF pattern. The data extends to very
 *  high Q (tiny d); enumerating every reflection there is pointless (the peaks
 *  overlap into the background) and costly, so the modelled range is floored. */
const TOF_DMIN_FLOOR = 0.5;

/** d-range covered by a TOF pattern, from its TOF extent and calibration. */
function tofDRange(
  pattern: PowderPattern,
  cal: { difC: number; difA: number; difB: number },
  zero: number,
): { dMin: number; dMax: number } {
  const xs = pattern.points.map((p) => p.x);
  const p = { kind: "tof" as const, difC: cal.difC, difA: cal.difA, difB: cal.difB, zero };
  // TOF increases monotonically with d, so min/max TOF map to min/max d.
  const dLo = dFromTof(p, Math.min(...xs));
  const dHi = dFromTof(p, Math.max(...xs));
  return { dMin: Math.max(Math.min(dLo, dHi), TOF_DMIN_FLOOR), dMax: Math.max(dLo, dHi) };
}

/** Back-to-back-exponential TOF peaks: positions from the diffractometer
 *  constants, d-dependent α/β/σ from the profile coefficients. */
function buildTofPeaks(
  intensities: readonly { d: number; intensity: number }[],
  applied: AppliedModel,
): ProfilePeak[] {
  const cal = applied.tof!;
  const tp = applied.tofProfile;
  const peaks: ProfilePeak[] = [];
  for (const p of intensities) {
    const d = p.d;
    if (d <= 0) continue;
    const center = cal.difC * d + cal.difA * d * d + cal.difB / d + applied.zeroShift;
    const alpha = Math.max((tp?.alpha0 ?? 0) + (tp?.alpha1 ?? 0) / d, 1e-6);
    const beta = Math.max((tp?.beta0 ?? 0) + (tp?.beta1 ?? 0) / (d * d * d * d), 1e-6);
    const sig2 = Math.max((tp?.sig0 ?? 0) + (tp?.sig1 ?? 0) * d * d + (tp?.sig2 ?? 0) * d * d * d * d, 1e-6);
    const sigma = Math.sqrt(sig2);
    // Support proxy for the far-peak skip: Gaussian FWHM plus both exponential
    // decay lengths, so the long β tail is not clipped.
    const effFwhm = 2.3548 * sigma + 1 / alpha + 1 / beta;
    peaks.push({ center, intensity: p.intensity, fwhm: effFwhm, tof: { alpha, beta, sigma } });
  }
  return peaks;
}

/** d-range (Å) spanned by the pattern, CW or TOF (uses the applied calibration). */
export function reflectionDRange(pattern: PowderPattern, applied: AppliedModel): { dMin: number; dMax: number } {
  return pattern.xUnit === "tof" && applied.tof !== undefined
    ? tofDRange(pattern, applied.tof, applied.zeroShift)
    : dRange(pattern);
}

export function buildPeaks(pattern: PowderPattern, applied: AppliedModel, applyLorentz = true): ProfilePeak[] {
  const { dMin, dMax } = reflectionDRange(pattern, applied);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
  const intensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale, applied.po, applyLorentz);
  return placePeaks(pattern, applied, intensities);
}

/**
 * Place pre-computed {d, intensity} peaks at the pattern's abscissa with the
 * instrument profile: CW Caglioti/TCH-pseudo-Voigt width, Finger–Cox–Jephcoat
 * axial asymmetry and cylinder absorption on a 2θ pattern, or the TOF
 * back-to-back-exponential shape. Shared by the nuclear peaks and the magnetic
 * satellites so both get identical positioning + resolution.
 */
/** Cache the (space-group-determined) Stephens invariants by operation list. */
const invariantCache = new WeakMap<object, QuarticInvariant[]>();
function strainInvariantsFor(applied: AppliedModel): QuarticInvariant[] {
  const ops = applied.model.spaceGroup.operations;
  let inv = invariantCache.get(ops);
  if (!inv) {
    inv = quarticStrainInvariants(ops);
    invariantCache.set(ops, inv);
  }
  return inv;
}

export function placePeaks(
  pattern: PowderPattern,
  applied: AppliedModel,
  intensities: readonly { d: number; intensity: number; h?: number; k?: number; l?: number }[],
): ProfilePeak[] {
  const isTof = pattern.xUnit === "tof" && applied.tof !== undefined;
  if (isTof) return buildTofPeaks(intensities, applied);
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
  // Anisotropic microstructure (2θ CW only). Stephens strain adds to the Gaussian
  // width (variance add); uniaxial size adds to the Lorentzian (breadth add).
  const isCW = pattern.xUnit === "twoTheta" && pattern.radiation.kind !== "neutron-tof";
  const wavelength = pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : NaN;
  const useStephens = isCW && applied.stephensStrain !== undefined;
  const useUniaxial = isCW && applied.uniaxialSize !== undefined;
  const invariants = useStephens ? strainInvariantsFor(applied) : null;

  const peaks: ProfilePeak[] = [];
  for (const p of intensities) {
    let center = dToX(pattern, p.d);
    if (Number.isNaN(center)) continue;
    center += applied.zeroShift;
    let gaussianFwhm = useCaglioti ? cagliotiFwhm(center, applied.caglioti!) / 100 : constWidth;
    const hasHkl = p.h !== undefined && p.k !== undefined && p.l !== undefined;
    // Stephens anisotropic strain → extra Gaussian width, added in quadrature.
    if (useStephens && hasHkl && invariants) {
      const gStrain = stephensStrainFwhmDeg(p.h!, p.k!, p.l!, applied.model.cell, wavelength, applied.stephensStrain!, invariants);
      if (gStrain > 0) gaussianFwhm = Math.sqrt(gaussianFwhm * gaussianFwhm + gStrain * gStrain);
    }
    // Uniaxial anisotropic size → extra Lorentzian breadth (added to isotropic X,Y).
    let gammaL = useTch ? lorentzianFwhm(center, applied.lorentzian!) / 100 : 0;
    if (useUniaxial && hasHkl) {
      gammaL += uniaxialSizeFwhmDeg(p.h!, p.k!, p.l!, applied.model.cell, wavelength, applied.uniaxialSize!);
    }
    let fwhm: number;
    let eta: number | undefined;
    if (gammaL > 0) {
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
  fitRange?: FitRange,
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const observations = Float64Array.from([...yObs, ...restraints.map((r) => r.target)]);
  const diffractionWeights = applyExclusionMask(
    applyExclusionMask(
      weightsFromSigma(pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1))),
      excludedPointMask(yObs),
    ),
    fitRangeMask(xValues, fitRange),
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
