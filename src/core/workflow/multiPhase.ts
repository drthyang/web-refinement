/**
 * Multi-phase powder refinement: sum the profile contributions of several
 * crystallographic phases (each with its own scale, cell, and atoms) into one
 * calculated pattern with a shared background. This matches real multi-phase
 * data such as the two-phase (Mn₃Ga + MnO) POWGEN refinement in `data/`.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { ProfilePeak, ProfileOptions, PeakShape } from "@/core/diffraction/profile";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { buildPeaks, createPeakBuilder } from "@/core/workflow/powder";
import { synthesizePattern } from "@/core/diffraction/profile";

export interface PowderPhase {
  readonly structure: StructureModel;
  /** Phase id used to route bindings (scale/cell/atoms) to this phase. */
  readonly id: string;
}

// One instrument illuminates every phase, so the whole instrument profile —
// background, zero, the Caglioti Gaussian + Lorentzian size/strain (incl. the
// isotropic TOF Mustrain), asymmetry, and the TOF calibration/profile — is
// shared across phases. Only scale, cell, atoms, and *anisotropic* sample
// microstructure (Stephens strain, uniaxial size) are per-phase (routed by id).
const SHARED_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "peakWidth", "background", "zeroShift",
  "profileU", "profileV", "profileW", "profileX", "profileY",
  "asymSL", "asymHL", "tofCalibration", "tofProfile", "mustrainIso",
]);
function isSharedBinding(b: ParameterBinding): boolean {
  return SHARED_KINDS.has(b.kind);
}

/**
 * The bindings that act on one phase: that phase's own parameters (routed by
 * `targetId`) plus every shared instrument/profile binding. Exported so the
 * F_obs/F_calc decomposition (obsCalc.ts) routes bindings to each phase exactly
 * as `computePattern` does here — the two must place identical peaks.
 */
export function phaseBindingsFor(
  bindings: readonly ParameterBinding[],
  phaseId: string,
): ParameterBinding[] {
  return bindings.filter((b) => b.targetId === phaseId || isSharedBinding(b));
}

/** Compute the combined multi-phase calculated pattern for given parameter values. */
function computePattern(
  phases: readonly PowderPhase[],
  pattern: PowderPattern,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
  xValues: readonly number[],
  profile: Pick<ProfileOptions, "shape" | "eta">,
): Float64Array {
  const allPeaks: ProfilePeak[] = [];
  let background: number[] = [];
  for (const phase of phases) {
    const applied = applyParameters(phase.structure, phaseBindingsFor(bindings, phase.id), values);
    allPeaks.push(...buildPeaks(pattern, applied));
    if (applied.background.length) background = applied.background;
  }
  const opts: ProfileOptions = {
    shape: profile.shape,
    ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
    ...(background.length ? { background } : {}),
  };
  return synthesizePattern(xValues, allPeaks, opts);
}

export function buildMultiPhasePowderProblem(
  phases: readonly PowderPhase[],
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
): RefinementProblem {
  const xValues = pattern.points.map((p) => p.x);
  const observations = Float64Array.from(pattern.points.map((p) => p.yObs));
  const weights = weightsFromSigma(
    pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1)),
  );
  // Per-phase cached peak builders (see createPeakBuilder): each phase's
  // structure factors are reused whenever none of ITS geometry parameters
  // moved — a derivative column for phase A's cell leaves phase B's peaks
  // cached, and profile/scale/background columns reuse both.
  const phaseBuilders = phases.map((phase) => {
    const phaseBindings = phaseBindingsFor(bindings, phase.id);
    return { phase, phaseBindings, peaksFor: createPeakBuilder(pattern, phaseBindings, true) };
  });
  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const allPeaks: ProfilePeak[] = [];
    let background: number[] = [];
    for (const b of phaseBuilders) {
      const applied = applyParameters(b.phase.structure, b.phaseBindings, resolved);
      allPeaks.push(...b.peaksFor(applied, resolved));
      if (applied.background.length) background = applied.background;
    }
    const opts: ProfileOptions = {
      shape: profile.shape,
      ...(profile.eta !== undefined ? { eta: profile.eta } : {}),
      ...(background.length ? { background } : {}),
    };
    return synthesizePattern(xValues, allPeaks, opts);
  };
  return { parameters, observations, weights, calculate };
}

export interface MultiPhaseCurves {
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
  readonly diff: number[];
}

export function multiPhaseCurves(
  phases: readonly PowderPhase[],
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: { shape: PeakShape; eta?: number } = { shape: "gaussian" },
): MultiPhaseCurves {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const xValues = pattern.points.map((p) => p.x);
  const yCalc = computePattern(phases, pattern, bindings, resolveTies(parameters, values), xValues, profile);
  const yObs = pattern.points.map((p) => p.yObs);
  return {
    x: [...xValues],
    yObs,
    yCalc: Array.from(yCalc),
    diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)),
  };
}
