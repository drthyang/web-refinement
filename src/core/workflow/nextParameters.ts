/**
 * Automated next-parameter diagnostic (roadmap F1.5) — the first
 * agent-in-the-loop hook: rank the currently-FIXED parameter groups by the
 * χ² improvement freeing them is expected to buy.
 *
 * Method: at the current values, compute each fixed parameter's Jacobian
 * column by central difference (cheap — the problem's geometry cache makes
 * non-geometry columns nearly free), then the Gauss–Newton estimate of the
 * per-group improvement: solve the group's small normal equations
 * (JᵀJ)Δ = Jᵀr and report Δχ² ≈ (Jᵀr)ᵀΔ. This is exact for a linear model
 * and the standard first-order estimate otherwise — enough to ORDER the
 * groups, which is all a controller (human or agent) needs.
 *
 * DOMAIN: a first-order probe is LOCAL. When peaks are displaced by more than
 * their width (badly wrong cell/zero), position-type groups are under-credited
 * — the linearized model cannot slide a peak further than ~its FWHM — and
 * intensity-type groups over-claim. That regime is flagged by the
 * assessment's unexplained-peaks finding, not by this ranking; run this after
 * the pattern is at least roughly aligned.
 */

import type { ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { chiSquared } from "@/core/refinement/factors";
import { solveSymmetricPseudoInverse, type Matrix } from "@/core/math/linalg";
import { DEFAULT_STAGE_KINDS, type StageKinds } from "@/core/workflow/structureRefinement";

export interface NextParameterGroup {
  /** Kind-group name (the staged-refinement vocabulary: scale, cell, ADP, …). */
  readonly group: string;
  readonly kinds: readonly ParameterKind[];
  /** The fixed parameters this group would free. */
  readonly parameterIds: readonly string[];
  /** Gauss–Newton estimate of the χ² this group would remove. */
  readonly expectedChiDrop: number;
  /** Predicted wR after freeing this group alone (same denominator as wRnow). */
  readonly predictedWr: number;
  /**
   * χ² drop relative to the current χ² (0–1). CAVEAT: on an already-converged
   * model any group can claim a large FRACTION of a negligible residual —
   * judge absolute progress by `predictedWr` vs `wrNow`, use this only to
   * order candidates.
   */
  readonly expectedRelativeImprovement: number;
  /** ‖Jᵀr‖ of the group — raw residual sensitivity. */
  readonly gradientNorm: number;
}

export interface NextParameterRanking {
  readonly chiSquared: number;
  /** Weighted profile R at the current values. */
  readonly wrNow: number;
  /** Groups with at least one fixed parameter, best candidate first. */
  readonly groups: readonly NextParameterGroup[];
}

/**
 * Rank fixed parameter groups by expected χ² improvement. `problem` must be
 * built over ALL parameters (free and fixed); only fixed, non-tied parameters
 * are probed. Groups default to the staged-refinement kind groups.
 */
export function rankNextParameterGroups(
  problem: RefinementProblem,
  groups: readonly StageKinds[] = DEFAULT_STAGE_KINDS,
): NextParameterRanking {
  const values: Record<string, number> = {};
  for (const p of problem.parameters) values[p.id] = p.value;
  const baseline = problem.calculate(values);
  const m = problem.observations.length;
  const sqrtW = new Float64Array(m);
  const r = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    sqrtW[i] = Math.sqrt(problem.weights[i]!);
    r[i] = sqrtW[i]! * (problem.observations[i]! - baseline[i]!);
  }
  const chi = chiSquared(problem.observations, baseline, problem.weights);
  let sumWObs2 = 0;
  for (let i = 0; i < m; i++) sumWObs2 += problem.weights[i]! * problem.observations[i]! * problem.observations[i]!;
  const wrOf = (c: number): number => (sumWObs2 > 0 ? Math.sqrt(Math.max(c, 0) / sumWObs2) : 0);

  const column = (p: RefinementParameter): Float64Array => {
    const h = Math.max(1e-6, Math.abs(p.value) * 1e-5);
    const forward = { ...values, [p.id]: p.value + h };
    const backward = { ...values, [p.id]: p.value - h };
    const yF = problem.calculate(forward);
    const yB = problem.calculate(backward);
    const col = new Float64Array(m);
    // J = ∂r/∂p = −√w·∂calc/∂p (matches the engine's convention).
    for (let i = 0; i < m; i++) col[i] = (-sqrtW[i]! * (yF[i]! - yB[i]!)) / (2 * h);
    return col;
  };

  const out: NextParameterGroup[] = [];
  for (const g of groups) {
    const kindSet = new Set(g.kinds);
    const fixed = problem.parameters.filter((p) => p.fixed && !p.expression && kindSet.has(p.kind));
    if (fixed.length === 0) continue;
    const cols = fixed.map(column);
    const k = cols.length;
    // Group normal equations from the probed columns.
    const jtj: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const jtr = new Array<number>(k).fill(0);
    for (let a = 0; a < k; a++) {
      for (let i = 0; i < m; i++) jtr[a]! += cols[a]![i]! * r[i]!;
      for (let b = a; b < k; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += cols[a]![i]! * cols[b]![i]!;
        jtj[a]![b] = s;
        jtj[b]![a] = s;
      }
    }
    // Gauss–Newton step for the group alone; Δχ² ≈ −2·gᵀΔ − ΔᵀJᵀJΔ reduces to
    // gᵀ(JᵀJ)⁻¹g at the GN optimum (g = Jᵀr with our sign convention −(−) = +).
    const { x: delta } = solveSymmetricPseudoInverse(jtj, jtr.map((v) => -v), 1e-8);
    let drop = 0;
    for (let a = 0; a < k; a++) drop += -jtr[a]! * delta[a]!;
    const gradientNorm = Math.sqrt(jtr.reduce((s, v) => s + v * v, 0));
    out.push({
      group: g.name,
      kinds: g.kinds,
      parameterIds: fixed.map((p) => p.id),
      expectedChiDrop: Math.max(drop, 0),
      predictedWr: wrOf(chi - Math.max(drop, 0)),
      expectedRelativeImprovement: chi > 0 ? Math.max(drop, 0) / chi : 0,
      gradientNorm,
    });
  }
  out.sort((a, b) => b.expectedChiDrop - a.expectedChiDrop);
  return { chiSquared: chi, wrNow: wrOf(chi), groups: out };
}
