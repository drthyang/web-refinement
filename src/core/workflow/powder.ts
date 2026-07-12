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
import type { CalculateOptions, LinearRestraint, ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma, excludedPointMask, applyExclusionMask, fitRangeMask } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters, type AppliedModel } from "@/core/workflow/apply";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, cylinderAbsorption, lorentzPolarization, marchDollase } from "@/core/diffraction/intensity";
import { nuclearStructureFactorPartials } from "@/core/diffraction/structureFactor";
import { braggTheta } from "@/core/crystal/unitCell";
import { dFromTof } from "@/core/diffraction/instrument";
import { synthesizePattern, cagliotiFwhm, lorentzianFwhm, tchPseudoVoigt, fcjSubPeaks, type ProfilePeak, type ProfileOptions, type PeakShape } from "@/core/diffraction/profile";
import { evaluateBackground, type BackgroundType } from "@/core/diffraction/background";
import { quarticStrainInvariants, stephensStrainFwhmDeg, stephensStrainSigmaTof, isotropicStrainSigmaTof, uniaxialStrainFwhmDeg, type QuarticInvariant } from "@/core/diffraction/anisoStrain";
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
  intensities: readonly { d: number; intensity: number; h?: number; k?: number; l?: number }[],
  applied: AppliedModel,
): ProfilePeak[] {
  const cal = applied.tof!;
  const tp = applied.tofProfile;
  // Stephens anisotropic microstrain adds an hkl-dependent Gaussian variance to
  // the TOF peak (in quadrature with the instrument σ²). Cached invariants.
  const stephens = applied.stephensStrain;
  const invariants = stephens ? strainInvariantsFor(applied) : null;
  const peaks: ProfilePeak[] = [];
  for (const p of intensities) {
    const d = p.d;
    if (d <= 0) continue;
    const center = cal.difC * d + cal.difA * d * d + cal.difB / d + applied.zeroShift;
    const alpha = Math.max((tp?.alpha0 ?? 0) + (tp?.alpha1 ?? 0) / d, 1e-6);
    const beta = Math.max((tp?.beta0 ?? 0) + (tp?.beta1 ?? 0) / (d * d * d * d) + (tp?.betaQ ?? 0) / (d * d), 1e-6);
    let sig2 = Math.max((tp?.sig0 ?? 0) + (tp?.sig1 ?? 0) * d * d + (tp?.sig2 ?? 0) * d * d * d * d + (tp?.sigQ ?? 0) / (d * d), 1e-6);
    // Isotropic Mustrain (GSAS-II): a constant Δd/d broadens ∝ d in TOF; add its
    // Gaussian variance in quadrature. σ_T = |dT/dd|·ε·d (see isotropicStrainSigmaTof).
    if (applied.mustrainIso !== undefined && applied.mustrainIso > 0) {
      const sIso = isotropicStrainSigmaTof(d, cal, applied.mustrainIso);
      if (sIso > 0) sig2 += sIso * sIso;
    }
    if (stephens && invariants && p.h !== undefined && p.k !== undefined && p.l !== undefined) {
      const sStrain = stephensStrainSigmaTof(p.h, p.k, p.l, applied.model.cell, cal, stephens, invariants);
      if (sStrain > 0) sig2 += sStrain * sStrain;
    }
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
 * Parameter kinds whose value changes the reflection intensity list
 * (d-spacings, |F|², multiplicity, LP, March–Dollase). Everything else —
 * scale (hoisted out as a pure multiplier), background, zero shift, all
 * profile widths/shapes, absorption, microstructure broadening — only affects
 * peak PLACEMENT or synthesis, which stay cheap and uncached.
 */
const GEOMETRY_BINDING_KINDS = new Set<ParameterKind>([
  "cellLength", "cellAngle", "positionShift", "uAniso", "bIso", "occupancy", "poRatio",
]);

/**
 * A peak builder with a single-entry geometry cache, for use inside a
 * refinement problem's `calculate` closure. The expensive stage — structure
 * factors over every reflection — is reused whenever no geometry parameter
 * moved since the previous evaluation. During a Levenberg–Marquardt iteration
 * that is every scale/background (linear) column, every profile/zero column,
 * and every synthesis-only trial, which dominate the Jacobian; geometry
 * columns necessarily recompute.
 *
 * EXACT by construction, not approximate: intensities are cached at unit
 * scale and multiplied by the current scale on retrieval, which is
 * bit-identical to a direct computation because `powderPeakIntensities`
 * multiplies scale last. The cache key is the exact string form of every
 * geometry-bound parameter value plus the reflection d-window (which for TOF
 * depends on the calibration and zero shift).
 */
/** Precomputed |F_N|² for a d-window, injected to skip the CPU structure-factor
 *  sum (the GPU evaluator's seam). */
export interface InjectedStructureFactors {
  readonly f2: Float64Array;
  readonly dMin: number;
  readonly dMax: number;
}

export function createPeakBuilder(
  pattern: PowderPattern,
  bindings: readonly ParameterBinding[],
  applyLorentz = true,
): (applied: AppliedModel, resolved: Readonly<Record<string, number>>, injected?: InjectedStructureFactors) => ProfilePeak[] {
  const geomIds = [...new Set(bindings.filter((b) => GEOMETRY_BINDING_KINDS.has(b.kind)).map((b) => b.parameterId))];
  let lastKey: string | null = null;
  let unitIntensities: ReturnType<typeof powderPeakIntensities> = [];

  return (applied, resolved, injected) => {
    const { dMin, dMax } = reflectionDRange(pattern, applied);
    let unit: ReturnType<typeof powderPeakIntensities>;
    // Injected |F|² path (GPU evaluator): recompute the unit intensities from the
    // supplied structure factors — same intensity assembly, |F|² sourced off-core.
    // Only when the d-window matches; the geometry cache is left untouched so a
    // later CPU-sum call still recomputes. `powderPeakIntensities` re-checks the
    // reflection count and silently falls back to the CPU sum on any mismatch.
    if (injected && injected.dMin === dMin && injected.dMax === dMax) {
      const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
      unit = powderPeakIntensities(applied.model, pattern.radiation, reflections, 1, applied.po, applyLorentz, injected.f2);
    } else {
      let key = `${dMin}|${dMax}`;
      for (const id of geomIds) key += `|${resolved[id]}`;
      if (key !== lastKey) {
        const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
        unitIntensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, 1, applied.po, applyLorentz);
        lastKey = key;
      }
      unit = unitIntensities;
    }
    const s = applied.scale;
    const intensities = s === 1 ? unit : unit.map((q) => ({ ...q, intensity: q.intensity * s }));
    return placePeaks(pattern, applied, intensities);
  };
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
  const useUniaxialStrain = isCW && applied.uniaxialStrain !== undefined && applied.lorentzian !== undefined;
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
    // Uniaxial anisotropic microstrain → replaces the isotropic Y·tanθ Lorentzian
    // strain with a direction-dependent one (net-zero at the isotropic seed).
    if (useUniaxialStrain && hasHkl) {
      const isoStrain = (applied.lorentzian!.y * Math.tan((center / 2) * (Math.PI / 180))) / 100;
      gammaL += uniaxialStrainFwhmDeg(p.h!, p.k!, p.l!, applied.model.cell, wavelength, applied.uniaxialStrain!) - isoStrain;
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

/**
 * Per-reflection structure-factor breakdown at the current model, plus the
 * intensity prefactor (multiplicity·Lp·PO·scale — everything the forward model
 * multiplies onto |F|²). Computed ONCE per analytic-column request and shared by
 * every occupancy/B_iso column, so freeing several such parameters costs a
 * single structure-factor pass rather than one per column. The prefactor is
 * rebuilt from the very helpers `powderPeakIntensities` uses, so the analytic
 * columns are consistent with the forward model by construction.
 */
interface DerivativeReflection {
  readonly d: number;
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly prefactor: number;
  readonly partials: ReturnType<typeof nuclearStructureFactorPartials>;
}

function derivativeReflections(applied: AppliedModel, pattern: PowderPattern, applyLorentz: boolean): DerivativeReflection[] {
  const { dMin, dMax } = reflectionDRange(pattern, applied);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
  const radiation = pattern.radiation;
  return reflections.map((r) => {
    const lp = applyLorentz ? lorentzPolarization(radiation, r.d) : 1;
    const poFactor = applied.po ? marchDollase(applied.model.cell, applied.po.axis, r.h, r.k, r.l, applied.po.ratio) : 1;
    return {
      d: r.d, h: r.h, k: r.k, l: r.l,
      prefactor: r.multiplicity * lp * poFactor * applied.scale,
      partials: nuclearStructureFactorPartials(applied.model, radiation, r.h, r.k, r.l),
    };
  });
}

/**
 * ∂(integrated intensity)/∂p per reflection for one occupancy or isotropic
 * B_iso parameter, derived from the shared per-reflection breakdown (roadmap
 * F1.1). Positions and widths do not depend on occupancy or B_iso, so the caller
 * spreads these derivative intensities with the ordinary profile to get
 * ∂yCalc/∂p.
 */
function nuclearDerivativeIntensities(
  reflections: readonly DerivativeReflection[],
  kind: "occupancy" | "bIso",
  siteLabels: readonly string[],
): { d: number; intensity: number; h: number; k: number; l: number }[] {
  const labels = new Set(siteLabels);
  return reflections.map((r) => {
    const { f, s, perSite } = r.partials;
    // A parameter bound to several symmetry-equivalent sites (a shared-B ADP
    // group) moves them together, so ∂|F|²/∂p sums the per-site contributions.
    let dF2 = 0;
    for (const site of perSite) {
      if (!labels.has(site.label)) continue;
      // Re(conj(F)·unitSite), with unitSite = ∂F/∂occ (occupancy pulled out).
      const reDot = f.re * site.unitSite.re + f.im * site.unitSite.im;
      // ∂|F|²/∂occ = 2·Re(conj F·unitSite);  ∂F/∂B = −s²·occ·unitSite (isotropic)
      // ⇒ ∂|F|²/∂B = −2·s²·occ·Re(conj F·unitSite). Anisotropic sites ignore B_iso
      // (apply.ts leaves them untouched), so they contribute zero — matching FD.
      dF2 += kind === "occupancy" ? 2 * reDot : site.isotropic ? -2 * s * s * site.occupancy * reDot : 0;
    }
    return { d: r.d, intensity: r.prefactor * dF2, h: r.h, k: r.k, l: r.l };
  });
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
  const peaksFor = createPeakBuilder(pattern, bindings, applyLorentz);

  const calculate = (values: Readonly<Record<string, number>>, options?: CalculateOptions): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const applied = applyParameters(structure, bindings, resolved);
    const peaks = peaksFor(applied, resolved, options?.structureFactors);
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

  // Analytic Jacobian columns (roadmap F1.1) for the coupling-free nuclear
  // structural kinds — site occupancy and isotropic B_iso — whose derivative
  // flows purely through |F|² (peak centers and widths are unaffected). Offered
  // only when there are no restraints (so a column's length is exactly the
  // pattern) and only for a parameter driven by a single such binding — which
  // makes the target site unambiguous and mirrors apply's last-write-wins site
  // assignment exactly. Every other parameter returns null and stays on the
  // finite-difference path.
  const analyticColumns =
    restraints.length === 0
      ? (freeParams: readonly RefinementParameter[], freeValues: readonly number[]): (Float64Array | null)[] => {
          const values: Record<string, number> = {};
          for (const p of parameters) values[p.id] = p.value;
          for (let j = 0; j < freeParams.length; j++) values[freeParams[j]!.id] = freeValues[j]!;
          const resolved = resolveTies(parameters, values);
          const applied = applyParameters(structure, bindings, resolved);
          const opts: ProfileOptions = {
            shape: profile.shape,
            ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
            ...(profile.backgroundType !== undefined ? { backgroundType: profile.backgroundType } : {}),
            // Background is independent of occupancy/B_iso, so it is deliberately
            // omitted here: the derivative is the peaks-only synthesis.
          };
          // Decide which columns are analytic before touching structure factors,
          // so a request with no occupancy/B_iso free skips the whole pass.
          const kindOf = (p: RefinementParameter): "occupancy" | "bIso" | null => {
            const bs = bindings.filter((b) => b.parameterId === p.id);
            if (bs.length === 0) return null;
            // Analytic only when every binding is the same coupling-free kind on a
            // named site (e.g. a shared-B ADP group); mixed/other kinds → FD.
            const kind = bs[0]!.kind;
            if (kind !== "occupancy" && kind !== "bIso") return null;
            return bs.every((b) => b.kind === kind && b.targetKey) ? kind : null;
          };
          const kinds = freeParams.map(kindOf);
          if (kinds.every((k) => k === null)) return kinds.map(() => null);
          // One structure-factor pass shared by every analytic column.
          const refl = derivativeReflections(applied, pattern, applyLorentz);
          return freeParams.map((p, i) => {
            const kind = kinds[i];
            if (!kind) return null;
            const labels = bindings.filter((b) => b.parameterId === p.id).map((b) => b.targetKey!);
            const derivPeaks = nuclearDerivativeIntensities(refl, kind, labels);
            return synthesizePattern(xValues, placePeaks(pattern, applied, derivPeaks), opts);
          });
        }
      : undefined;

  return { parameters, observations, weights, calculate, ...(analyticColumns ? { analyticColumns } : {}) };
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
