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

export type BackgroundType = "polynomial" | "chebyshev";

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
  return type === "chebyshev"
    ? chebyshevBackground(x, coeffs, xMin, xMax)
    : polynomialBackground(x, coeffs);
}
