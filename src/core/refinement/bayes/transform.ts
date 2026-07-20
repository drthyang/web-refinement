/**
 * Parameter-space transforms for posterior sampling.
 *
 * The sampler walks in an UNBOUNDED space so proposals can never leave a
 * parameter's [min, max] box — a two-sided bound maps through a logit, a
 * one-sided bound through a log, and an unbounded parameter through the
 * identity. Each transform carries the log-Jacobian of the bounded→unbounded
 * change of variables; adding it to the log-posterior keeps a uniform-in-bounds
 * prior genuinely uniform (without it the transform would silently warp the
 * prior toward the box edges). The logit choice is also HMC-ready: a future
 * NUTS sampler needs an unconstrained, differentiable space, and reflection or
 * rejection at bounds would break detailed balance there.
 */

import type { RefinementParameter } from "@/core/refinement/types";

export interface TransformSpec {
  readonly kind: "identity" | "logit" | "logLower" | "logUpper";
  /** Lower bound (logit / logLower). */
  readonly min?: number;
  /** Upper bound (logit / logUpper). */
  readonly max?: number;
}

/** Plan one transform per free parameter from its declared bounds. */
export function planTransforms(freeParams: readonly RefinementParameter[]): TransformSpec[] {
  return freeParams.map((p) => {
    const hasMin = p.min !== undefined && Number.isFinite(p.min);
    const hasMax = p.max !== undefined && Number.isFinite(p.max);
    if (hasMin && hasMax && p.max! > p.min!) return { kind: "logit", min: p.min!, max: p.max! };
    if (hasMin) return { kind: "logLower", min: p.min! };
    if (hasMax) return { kind: "logUpper", max: p.max! };
    return { kind: "identity" };
  });
}

/** Numerically-stable logistic σ(q) = 1/(1+e^{−q}). */
function sigmoid(q: number): number {
  return q >= 0 ? 1 / (1 + Math.exp(-q)) : Math.exp(q) / (1 + Math.exp(q));
}

/**
 * Nudge a bounded value strictly inside its box before transforming: a value
 * sitting exactly ON a bound (the LM hard-clamp leaves them there) would map to
 * ±Infinity and poison the whole chain.
 */
function insideBox(x: number, lo: number, hi: number): number {
  const eps = 1e-12 * Math.max(1, Math.abs(hi - lo));
  return Math.min(Math.max(x, lo + eps), hi - eps);
}

/** Bounded → unbounded. */
export function toUnbounded(x: number, t: TransformSpec): number {
  switch (t.kind) {
    case "identity":
      return x;
    case "logit": {
      const u = (insideBox(x, t.min!, t.max!) - t.min!) / (t.max! - t.min!);
      return Math.log(u / (1 - u));
    }
    case "logLower":
      return Math.log(Math.max(x - t.min!, 1e-300));
    case "logUpper":
      return Math.log(Math.max(t.max! - x, 1e-300));
  }
}

/** Unbounded → bounded (always lands strictly inside the box). */
export function toBounded(q: number, t: TransformSpec): number {
  switch (t.kind) {
    case "identity":
      return q;
    case "logit":
      return t.min! + (t.max! - t.min!) * sigmoid(q);
    case "logLower":
      return t.min! + Math.exp(q);
    case "logUpper":
      return t.max! - Math.exp(q);
  }
}

/**
 * log|dx/dq| of the unbounded→bounded map at q — the change-of-variables term
 * added to the log-posterior so densities stated in bounded space stay correct.
 */
export function logJacobian(q: number, t: TransformSpec): number {
  switch (t.kind) {
    case "identity":
      return 0;
    case "logit": {
      // dx/dq = (max−min)·σ(q)·(1−σ(q))
      const s = sigmoid(q);
      return Math.log(t.max! - t.min!) + Math.log(Math.max(s, 1e-300)) + Math.log(Math.max(1 - s, 1e-300));
    }
    case "logLower":
    case "logUpper":
      // |dx/dq| = e^q
      return q;
  }
}
