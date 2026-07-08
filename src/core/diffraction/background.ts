/**
 * Powder background functions.
 *
 * A raw-power polynomial (c0 + c1·x + c2·x² + …) is numerically hopeless for a
 * wide abscissa: at TOF ~ 10⁵ or Q ~ 16, the high powers overflow or swamp the
 * conditioning. The Chebyshev form evaluates on a normalized t ∈ [−1, 1], so all
 * terms stay O(1) and the coefficients are well separated — the standard choice
 * in GSAS-II / TOPAS. Both forms are provided; Chebyshev is the default for
 * refinement.
 */

/**
 * Smooth-background basis (GSAS-II-style). The three refinable forms below each
 * use N coefficients over the same normalized abscissa, so switching type keeps
 * the coefficient count and stays well-conditioned across a wide range
 * (2θ/Q/d/TOF):
 *  - `chebyshev`   — Chebyshev polynomials Tₙ(t), t ∈ [−1, 1] (default).
 *  - `cosine`      — Fourier cosine series Σ cₙ·cos(nπ·s), s ∈ [0, 1].
 *  - `powerSeries` — polynomial in the *normalized* t ∈ [−1, 1] (Σ cₙ·tⁿ).
 * `polynomial` is the raw-power series (c0 + c1·x + …), kept for compatibility;
 * it overflows on a wide abscissa and is not offered for refinement.
 */
export type BackgroundType = "chebyshev" | "cosine" | "powerSeries" | "polynomial";

/** Map an abscissa value onto the Chebyshev domain t ∈ [−1, 1]. */
function toChebyshevT(x: number, xMin: number, xMax: number): number {
  const span = xMax - xMin;
  return span > 0 ? (2 * (x - xMin)) / span - 1 : 0;
}

/** Σ cₙ·Tₙ(t) with Tₙ the Chebyshev polynomials of the first kind (recurrence). */
export function chebyshevBackground(
  x: number,
  coeffs: readonly number[],
  xMin: number,
  xMax: number,
): number {
  if (coeffs.length === 0) return 0;
  const t = toChebyshevT(x, xMin, xMax);
  let tPrev = 1; // T0
  let tCur = t; // T1
  let sum = coeffs[0]!; // c0·T0
  if (coeffs.length > 1) sum += coeffs[1]! * t;
  for (let n = 2; n < coeffs.length; n++) {
    const tNext = 2 * t * tCur - tPrev;
    sum += coeffs[n]! * tNext;
    tPrev = tCur;
    tCur = tNext;
  }
  return sum;
}

/** Fourier cosine series Σ cₙ·cos(nπ·s) with s = (x−xMin)/(xMax−xMin) ∈ [0, 1].
 *  n=0 gives the constant c₀; all terms are bounded (|cos| ≤ 1). */
export function cosineBackground(
  x: number,
  coeffs: readonly number[],
  xMin: number,
  xMax: number,
): number {
  if (coeffs.length === 0) return 0;
  const span = xMax - xMin;
  const s = span > 0 ? (x - xMin) / span : 0;
  let sum = 0;
  for (let n = 0; n < coeffs.length; n++) sum += coeffs[n]! * Math.cos(n * Math.PI * s);
  return sum;
}

/** Power series Σ cₙ·tⁿ in the *normalized* t ∈ [−1, 1] — a monomial basis that,
 *  unlike the raw-power polynomial, stays finite on a wide abscissa. */
export function powerSeriesBackground(
  x: number,
  coeffs: readonly number[],
  xMin: number,
  xMax: number,
): number {
  if (coeffs.length === 0) return 0;
  const t = toChebyshevT(x, xMin, xMax);
  let sum = 0;
  let tp = 1;
  for (const c of coeffs) {
    sum += c * tp;
    tp *= t;
  }
  return sum;
}

/** Raw-power polynomial c0 + c1·x + c2·x² + … (kept for compatibility). */
export function polynomialBackground(x: number, coeffs: readonly number[]): number {
  let value = 0;
  let xp = 1;
  for (const c of coeffs) {
    value += c * xp;
    xp *= x;
  }
  return value;
}

/** Evaluate a background of the given type at x (Chebyshev needs the x-range). */
export function evaluateBackground(
  x: number,
  coeffs: readonly number[] | undefined,
  type: BackgroundType,
  xMin: number,
  xMax: number,
): number {
  if (!coeffs || coeffs.length === 0) return 0;
  switch (type) {
    case "chebyshev":
      return chebyshevBackground(x, coeffs, xMin, xMax);
    case "cosine":
      return cosineBackground(x, coeffs, xMin, xMax);
    case "powerSeries":
      return powerSeriesBackground(x, coeffs, xMin, xMax);
    case "polynomial":
      return polynomialBackground(x, coeffs);
  }
}
