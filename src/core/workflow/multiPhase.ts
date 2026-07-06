/**
 * Multi-phase powder refinement: sum the profile contributions of several
 * crystallographic phases (each with its own scale, cell, and atoms) into one
 * calculated pattern with a shared background. This matches real multi-phase
 * data such as the two-phase (Mn₃Ga + MnO) POWGEN refinement in `data/`.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import type { ProfilePeak, ProfileOptions, PeakShape } from "@/core/diffraction/profile";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { buildPeaks } from "@/core/workflow/powder";
import { synthesizePattern } from "@/core/diffraction/profile";

export interface PowderPhase {
  readonly structure: StructureModel;
  /** Phase id used to route bindings (scale/cell/atoms) to this phase. */
  readonly id: string;
}

function isSharedBinding(b: ParameterBinding): boolean {
  return b.kind === "peakWidth" || b.kind === "background" || b.kind === "zeroShift";
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
    const phaseBindings = bindings.filter((b) => b.targetId === phase.id || isSharedBinding(b));
    const applied = applyParameters(phase.structure, phaseBindings, values);
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
  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    return computePattern(phases, pattern, bindings, resolved, xValues, profile);
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
