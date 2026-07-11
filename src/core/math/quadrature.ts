/**
 * Gauss–Legendre quadrature: nodes and weights for numerical integration.
 *
 * An n-point rule integrates polynomials up to degree 2n−1 exactly on [−1, 1],
 * and converges spectrally for smooth integrands. Used by the absorption
 * transmission integral (volume average of exp(−μ·path) over a crystal shape).
 */

export interface GaussRule {
  /** Node abscissae on [−1, 1], ascending. */
  readonly nodes: readonly number[];
  /** Quadrature weights; Σ weights = 2 (the length of [−1, 1]). */
  readonly weights: readonly number[];
}

/**
 * n-point Gauss–Legendre nodes and weights on [−1, 1], found by Newton's method
 * on the Legendre polynomial Pₙ (roots are the nodes). Symmetric about 0, so
 * only half are iterated and mirrored.
 */
export function gaussLegendre(n: number): GaussRule {
  if (n < 1 || !Number.isInteger(n)) {
    throw new Error(`gaussLegendre: n must be a positive integer, got ${n}`);
  }
  const nodes = new Array<number>(n);
  const weights = new Array<number>(n);
  const half = (n + 1) >> 1;

  for (let i = 0; i < half; i++) {
    // Chebyshev-like initial guess for the (i+1)-th root, refined by Newton.
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let deriv = 0;
    for (let iter = 0; iter < 100; iter++) {
      // Evaluate Pₙ(x) and Pₙ₋₁(x) by the recurrence.
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      // Pₙ'(x) = n (x·Pₙ − Pₙ₋₁) / (x² − 1).
      deriv = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / deriv;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    const w = 2 / ((1 - x * x) * deriv * deriv);
    nodes[i] = -x;
    nodes[n - 1 - i] = x;
    weights[i] = w;
    weights[n - 1 - i] = w;
  }
  return { nodes, weights };
}
