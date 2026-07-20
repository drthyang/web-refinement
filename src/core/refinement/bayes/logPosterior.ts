/**
 * Log-posterior assembly for posterior sampling.
 *
 * THE LIKELIHOOD MUST MATCH HOW THE DATA WERE PRODUCED AND PROCESSED — no
 * model is automatically better. The practical selection rule:
 *
 *   raw independent counts            → "poisson"      (counting statistics)
 *   processed intensities, honest σ   → "fixed"        (Gaussian, w = 1/σ²)
 *   outliers / imperfect model        → "studentT"     (heavy-tailed Gaussian)
 *   unknown/unreliable error scale    → "marginalized" (Gaussian, σ integrated
 *                                                       out under Jeffreys)
 *
 * The PDF default is "marginalized": G(r) is fitted with deliberate UNIT
 * weights (correlated Fourier errors make per-point 1/σ² a lie — see
 * workflow/pdf.ts), so a naive exp(−χ²/2) would treat every grid point as an
 * independent measurement and collapse the posterior to absurd overconfidence.
 * Marginalizing the unknown global error scale σ² under a Jeffreys prior:
 *
 *   p(data|θ) = ∫ N(r; 0, σ²/w) · dσ/σ  ∝  (χ²(θ))^(−N/2)
 *   ⇒ logL(θ) = −(N/2)·ln χ²(θ)
 *
 * — the exact Bayesian analog of the engine's frequentist reduced-χ² ESD
 * scaling (engine.ts covariance × χ²/dof), so in the well-conditioned Gaussian
 * limit posterior widths reproduce the linearized ESDs. N is the number of
 * CONTRIBUTING observations (positive weight), matching the engine's dof rule.
 *
 * HONESTY NOTE (all models): every likelihood here treats the residuals as
 * per-point INDEPENDENT. For G(r) that is an approximation, not a rigorous
 * likelihood — the finite-Qmax Fourier transform correlates neighboring r
 * points, and the marginalized scale absorbs only the OVERALL misweighting,
 * not the correlation structure. The rigorous ladder (correlated-residual
 * model, then covariance propagated from the F(Q) reduction) is recorded in
 * PDF_MPDF_ROADMAP §8; until then, credible intervals are relative to the
 * declared noise model.
 */

import type { RefinementParameter } from "@/core/refinement/types";

export type NoiseModel = "marginalized" | "fixed" | "poisson" | "studentT";

/** Student-t degrees of freedom when unspecified: heavy enough tails to shrug
 *  off outliers, close enough to Gaussian to stay efficient on clean data. */
export const DEFAULT_STUDENT_NU = 5;

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

/** Log-likelihood from χ² under a χ²-expressible noise model (the two models
 *  a scalar χ² gradient can drive — NUTS is restricted to these). */
export function logLikelihood(chi2: number, nUsed: number, model: NoiseModel): number {
  if (!Number.isFinite(chi2) || chi2 < 0) return Number.NEGATIVE_INFINITY;
  if (model === "marginalized") {
    // χ² = 0 (exact fit) is a measure-zero degenerate point when the error
    // scale is marginalized (−(N/2)·ln χ² → +∞); the fixed model is finite
    // there (−χ²/2 = 0).
    return chi2 > 0 ? -(nUsed / 2) * Math.log(chi2) : Number.POSITIVE_INFINITY;
  }
  if (model !== "fixed") {
    throw new Error(`logLikelihood: noise model "${model}" is not χ²-expressible — use logLikelihoodCurve`);
  }
  return -chi2 / 2;
}

/**
 * Log-likelihood from the full curves — supports every noise model. Points
 * with weight ≤ 0 are masked (excluded), matching the engine's N rule.
 *
 * Caveats the caller owns:
 *  - "poisson" requires `yObs` to be RAW COUNTS and `yCalc` the modeled rate
 *    (weights act only as the exclusion mask; a non-positive rate at a
 *    contributing point is impossible → −∞). Do not combine with restraint
 *    rows — every weighted row is treated as a count.
 *  - "studentT" uses the per-point scales from the weights (σᵢ = 1/√wᵢ) with
 *    `nu` degrees of freedom; constants independent of the parameters are
 *    dropped throughout (only differences of logL matter to a sampler).
 */
export function logLikelihoodCurve(
  yObs: Float64Array,
  yCalc: Float64Array,
  weights: Float64Array,
  nUsed: number,
  model: NoiseModel,
  nu: number = DEFAULT_STUDENT_NU,
): number {
  if (model === "marginalized" || model === "fixed") {
    // Same summation order as factors.ts chiSquared — bit-identical results.
    let chi2 = 0;
    for (let i = 0; i < yObs.length; i++) {
      const d = yObs[i]! - yCalc[i]!;
      chi2 += weights[i]! * d * d;
    }
    return logLikelihood(chi2, nUsed, model);
  }
  if (model === "poisson") {
    let s = 0;
    for (let i = 0; i < yObs.length; i++) {
      if (weights[i]! <= 0) continue; // masked/excluded point
      const mu = yCalc[i]!;
      if (!(mu > 0)) return Number.NEGATIVE_INFINITY;
      s += yObs[i]! * Math.log(mu) - mu;
    }
    return s;
  }
  // studentT: independent scaled-t residuals, robust to outliers.
  const halfNuP1 = (nu + 1) / 2;
  let s = 0;
  for (let i = 0; i < yObs.length; i++) {
    const w = weights[i]!;
    if (w <= 0) continue;
    const d = yObs[i]! - yCalc[i]!;
    s -= halfNuP1 * Math.log(1 + (w * d * d) / nu);
  }
  return s;
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
