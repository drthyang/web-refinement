/**
 * The Agent's correlation guardrail: never refine strongly correlated
 * parameters together.
 *
 * Before each refinement the page runs its own fit of the free set with no
 * iterations (port `probe`): the normal matrix at the current values, which is
 * the same covariance the refinement would report, without moving anything.
 * The correlations come off it. A pair at |ρ| ≥ CORRELATION_LIMIT, or a
 * combination the data cannot determine at all (a null direction), stops the
 * refinement; the model must fix one of each pair, or refine them in separate
 * stages. Measured on this data, over this fit window, so a pair that the
 * angular range separates (cell and zero over a wide 2θ range) is not stopped.
 *
 * Two background coefficients are exempt: they are one curve in a basis whose
 * terms trade off by construction (0.99 is usual), while the curve itself is
 * determined and no coefficient is a result anyone reports. A background term
 * against anything else (the scale soaking up peak intensity) still counts.
 */

import type { ParameterKind, RefinementOptions, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { correlationInsight } from "@/core/diagnostics/assessment";

/** The line the engine and `assess_refinement` already draw for a high correlation. */
export const CORRELATION_LIMIT = 0.95;

/**
 * The probe: no iterations, and correlations reported well under the limit,
 * so a passing check can still name its strongest pair.
 */
export const PROBE_OPTIONS: Partial<RefinementOptions> = { maxIterations: 0, correlationThreshold: 0.5, maxReportedCorrelations: 64 };

export interface CorrelatedPair {
  readonly a: string;
  readonly b: string;
  readonly coefficient: number;
  /** Why the pair is expected to correlate, and what to do (known pairs only). */
  readonly reason?: string;
}

export interface CorrelationCheck {
  /** Free pairs at or over the limit, strongest first. */
  readonly correlated: readonly CorrelatedPair[];
  /** Free parameters in a direction the data cannot determine at all. */
  readonly undetermined: readonly string[];
  /** The strongest pair under the limit (null when none reaches 0.5). */
  readonly strongest: CorrelatedPair | null;
}

/** Read the check off a probe (or any refinement result) of the given parameter set. */
export function readCorrelations(result: RefinementResult, parameters: readonly RefinementParameter[]): CorrelationCheck {
  const kind = new Map<string, ParameterKind>(parameters.map((p) => [p.id, p.kind]));
  const sameCurve = (a: string, b: string): boolean => kind.get(a) === "background" && kind.get(b) === "background";
  const pairs = (result.diagnostics?.highCorrelations ?? []).filter((c) => !sameCurve(c.parameterIdA, c.parameterIdB)).map((c): CorrelatedPair => {
    const ka = kind.get(c.parameterIdA);
    const kb = kind.get(c.parameterIdB);
    const reason = ka && kb ? correlationInsight(ka, kb) : undefined;
    return { a: c.parameterIdA, b: c.parameterIdB, coefficient: c.coefficient, ...(reason ? { reason } : {}) };
  });
  const correlated = pairs.filter((p) => Math.abs(p.coefficient) >= CORRELATION_LIMIT);
  return {
    correlated,
    undetermined: [...(result.diagnostics?.singularParameterIds ?? [])],
    strongest: pairs.find((p) => Math.abs(p.coefficient) < CORRELATION_LIMIT) ?? null,
  };
}

export const pairText = (p: CorrelatedPair): string => `${p.a} ↔ ${p.b} ${p.coefficient.toFixed(3)}`;

/** Why the refinement may not run, for the model; null when the free set is fine. */
export function correlationRefusal(check: CorrelationCheck): string | null {
  if (check.correlated.length === 0 && check.undetermined.length === 0) return null;
  const parts: string[] = ["Not refined: the free set holds parameters the data cannot separate, and correlated parameters are never refined together."];
  if (check.correlated.length > 0) {
    parts.push(
      `Correlated at the current values (|ρ| ≥ ${CORRELATION_LIMIT}): ` +
        check.correlated.map((p) => pairText(p) + (p.reason ? ` (${p.reason})` : "")).join("; ") + ".",
    );
  }
  if (check.undetermined.length > 0) parts.push(`Not determined by the data at all, together: ${check.undetermined.join(", ")}.`);
  parts.push("Fix one of each pair with set_free (usually the one the method frees later), or refine them in separate stages, then call refine again.");
  return parts.join(" ");
}

/** The approval card's short line for the same refusal. */
export function refusalLine(check: CorrelationCheck): string {
  const first = check.correlated[0];
  if (first) return `Not run: ${pairText(first)}${check.correlated.length > 1 ? ` and ${check.correlated.length - 1} more` : ""} correlated`;
  return `Not run: ${check.undetermined.join(", ")} not determined`;
}
