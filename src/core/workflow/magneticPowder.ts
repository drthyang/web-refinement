/**
 * Magnetic powder refinement (Phase 7): combine nuclear and magnetic Bragg
 * intensities into a single powder profile, keeping the two components
 * separable, and refine moments + scales against an observed pattern.
 *
 * Nuclear and magnetic peaks share the same CW/TOF placement (via powder.ts
 * `buildPeaks`/`placePeaks`) and one shared (GSAS-II) scale. Magnetic peaks are
 * satellites at G±k for a single commensurate k.
 *
 * Documented approximations: the magnetic intensity uses the perpendicular
 * projection for the representative reflection of each family (no full cone
 * average over symmetry-equivalent Q directions), and satellite multiplicity is
 * approximated by the parent nuclear multiplicity.
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
import { buildPeaks, placePeaks, reflectionDRange } from "@/core/workflow/powder";
import { generateReflections } from "@/core/diffraction/reflections";
import { lorentzPolarization } from "@/core/diffraction/intensity";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { dSpacing } from "@/core/crystal/unitCell";
import { synthesizePattern } from "@/core/diffraction/profile";

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

  // Nuclear peaks: reuse the full CW/TOF placement (Caglioti/TCH/FCJ 2θ width or
  // the TOF back-to-back-exponential shape), so magnetic data of either kind fits.
  const nuclear = buildPeaks(pattern, applied, true);

  // Shared (GSAS-II) scale: the nuclear histogram scale multiplies the magnetic
  // intensity too. An optional `magneticScale` binding is a dimensionless ratio
  // on top (default 1 = fully shared). No explicit V_mag/V_nuc factor is needed:
  // the propagation-vector (k) formalism keeps moments on the nuclear cell.
  const magFactor = bindings.some((b) => b.kind === "magneticScale")
    ? values[bindings.find((b) => b.kind === "magneticScale")!.parameterId] ?? 1
    : 1;
  const magScale = applied.scale * magFactor;

  const kVec = appliedMag.propagation[0] ?? [0, 0, 0];
  const isK0 = kVec.every((v) => Math.abs(v) < 1e-9);

  // Magnetic satellites at G ± k (single commensurate k). k = 0 → the nuclear
  // position (the ±k satellites coincide, so emit once). |F_M|² evaluated at the
  // non-integer satellite indices carries the k-phase automatically. Parent
  // nuclear multiplicity approximates the exact star-of-k satellite multiplicity.
  // Nuclear systematic absences do NOT apply to the magnetic structure factor
  // (`absences: false`): AFM structures put their satellites exactly at
  // nuclear-extinct positions — a gray anti-translation lattice (BNS P_c…)
  // even makes the (0,0,½)′ op look like a centring, and filtering would
  // delete every magnetic peak. |F_M|² itself decides what is absent.
  const { dMin, dMax } = reflectionDRange(pattern, applied);
  const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax, { absences: false });
  const magIntensities: { d: number; intensity: number }[] = [];
  for (const r of reflections) {
    const sats: [number, number, number][] = isK0
      ? [[r.h, r.k, r.l]]
      : [[r.h + kVec[0]!, r.k + kVec[1]!, r.l + kVec[2]!], [r.h - kVec[0]!, r.k - kVec[1]!, r.l - kVec[2]!]];
    for (const [mh, mk, ml] of sats) {
      const dSat = dSpacing(applied.model.cell, mh, mk, ml);
      if (!Number.isFinite(dSat) || dSat <= 0 || dSat < dMin || dSat > dMax) continue;
      const fm2 = magneticStructureFactor(applied.model, appliedMag, mh, mk, ml).squared;
      const lp = lorentzPolarization(pattern.radiation, dSat);
      magIntensities.push({ d: dSat, intensity: magScale * r.multiplicity * lp * fm2 });
    }
  }
  const magneticPeaks = placePeaks(pattern, applied, magIntensities);
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
