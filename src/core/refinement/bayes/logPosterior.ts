/**
 * Log-posterior assembly for posterior sampling.
 *
 * The likelihood is Gaussian in the weighted residuals, but the PDF workflow
 * deliberately uses UNIT weights (correlated Fourier errors make per-point 1/σ²
 * a lie — see workflow/pdf.ts), so a naive exp(−χ²/2) would treat every grid
 * point as an independent measurement and collapse the posterior to absurd
 * overconfidence. The default noise model therefore marginalizes an unknown
 * global error scale σ² under a Jeffreys prior:
 *
 *   p(data|θ) = ∫ N(r; 0, σ²/w) · dσ/σ  ∝  (χ²(θ))^(−N/2)
 *   ⇒ logL(θ) = −(N/2)·ln χ²(θ)
 *
 * — the exact Bayesian analog of the engine's frequentist reduced-χ² ESD
 * scaling (engine.ts covariance × χ²/dof), so in the well-conditioned Gaussian
 * limit posterior widths reproduce the linearized ESDs. N is the number of
 * CONTRIBUTING observations (positive weight), matching the engine's dof rule.
 * The "fixed" model (−χ²/2) is for problems with honestly-calibrated weights.
 */

import type { RefinementParameter } from "@/core/refinement/types";

export type NoiseModel = "marginalized" | "fixed";

/** Prior on one parameter, stated in BOUNDED (original) space. */
export interface PriorSpec {
  readonly kind: "uniform" | "normal";
  /** normal only: center. */
  readonly mu?: number;
  /** normal only: width (> 0). */
  readonly sigma?: number;
}

/** Count of contributing observations (positive weight) — the engine's N rule. */
export function nUsedOf(weights: Float64Array): number {
  let n = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i]! > 0) n++;
  return n;
}

/** Log-likelihood from χ² under the chosen noise model. */
export function logLikelihood(chi2: number, nUsed: number, model: NoiseModel): number {
  if (!Number.isFinite(chi2) || chi2 <= 0) {
    // χ² = 0 (exact fit) is a measure-zero degenerate point for the marginalized
    // model; treat non-finite/non-positive χ² as an impossible state.
    return chi2 === 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return model === "marginalized" ? -(nUsed / 2) * Math.log(chi2) : -chi2 / 2;
}

/**
 * Log-prior over the free parameters, stated in bounded space. Uniform-in-bounds
 * contributes 0 (the box constraint itself lives in the logit transform); a
 * normal prior contributes the usual −(x−μ)²/2σ² up to a constant.
 */
export function logPrior(
  freeParams: readonly RefinementParameter[],
  boundedValues: readonly number[],
  priors: Readonly<Record<string, PriorSpec>> | undefined,
): number {
  if (!priors) return 0;
  let sum = 0;
  for (let j = 0; j < freeParams.length; j++) {
    const spec = priors[freeParams[j]!.id];
    if (!spec || spec.kind === "uniform") continue;
    const sigma = spec.sigma;
    if (sigma === undefined || !(sigma > 0)) continue;
    const d = (boundedValues[j]! - (spec.mu ?? 0)) / sigma;
    sum += -0.5 * d * d;
  }
  return sum;
}
