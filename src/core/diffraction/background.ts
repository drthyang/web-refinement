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
export type BackgroundType =
  | "chebyshev"
  | "cosine"
  | "powerSeries"
  | "linInterpolate"
  | "logInterpolate"
  | "polynomial";

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

/**
 * Interpolation-background anchor positions (GSAS-II style): the N coefficients
 * are background *values* at N points spanning [xMin, xMax], spaced evenly in x
 * (linear) or in log(x) (log). Endpoints are pinned to xMin/xMax. Memoized on the
 * last (n, range, log) since a whole pattern shares one set of anchors.
 */
let anchorCache: { key: string; pos: number[] } | null = null;
function interpAnchors(n: number, xMin: number, xMax: number, log: boolean): number[] {
  const useLog = log && xMin > 0 && xMax > xMin;
  const key = `${n}|${xMin}|${xMax}|${useLog ? 1 : 0}`;
  if (anchorCache && anchorCache.key === key) return anchorCache.pos;
  const pos = new Array<number>(n);
  if (n === 1) {
    pos[0] = xMin;
  } else if (useLog) {
    const a = Math.log(xMin), b = Math.log(xMax);
    for (let i = 0; i < n; i++) pos[i] = Math.exp(a + (i * (b - a)) / (n - 1));
    pos[0] = xMin;
    pos[n - 1] = xMax;
  } else {
    for (let i = 0; i < n; i++) pos[i] = xMin + (i * (xMax - xMin)) / (n - 1);
  }
  anchorCache = { key, pos };
  return pos;
}

/** Piecewise-linear interpolation of `coeffs` placed at `pos`; flat past the ends. */
function interpolateAt(x: number, pos: readonly number[], coeffs: readonly number[]): number {
  const n = coeffs.length;
  if (n === 1) return coeffs[0]!;
  if (x <= pos[0]!) return coeffs[0]!;
  if (x >= pos[n - 1]!) return coeffs[n - 1]!;
  let j = 0;
  while (j < n - 2 && x > pos[j + 1]!) j++;
  const p0 = pos[j]!, p1 = pos[j + 1]!;
  const t = p1 > p0 ? (x - p0) / (p1 - p0) : 0;
  return coeffs[j]! + t * (coeffs[j + 1]! - coeffs[j]!);
}

/** GSAS-II "lin interpolate": N background values evenly spaced in x, linearly
 *  interpolated between. Each coefficient is the background height at its point. */
export function linInterpolateBackground(
  x: number,
  coeffs: readonly number[],
  xMin: number,
  xMax: number,
): number {
  if (coeffs.length === 0) return 0;
  return interpolateAt(x, interpAnchors(coeffs.length, xMin, xMax, false), coeffs);
}

/** GSAS-II "log interpolate": as lin interpolate, but the points are evenly
 *  spaced in log(x) — denser at low x, better for a wide TOF/Q abscissa. */
export function logInterpolateBackground(
  x: number,
  coeffs: readonly number[],
  xMin: number,
  xMax: number,
): number {
  if (coeffs.length === 0) return 0;
  return interpolateAt(x, interpAnchors(coeffs.length, xMin, xMax, true), coeffs);
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
    case "linInterpolate":
      return linInterpolateBackground(x, coeffs, xMin, xMax);
    case "logInterpolate":
      return logInterpolateBackground(x, coeffs, xMin, xMax);
    case "polynomial":
      return polynomialBackground(x, coeffs);
  }
}

/**
 * Estimate background coefficients from the data's LOWER ENVELOPE — the robust
 * automatic starting value (roadmap F1.3). Peaks only ever add intensity, so a
 * low percentile of the observed counts inside each of ~2n windows tracks the
 * background; the chosen basis is then least-squares fitted to those envelope
 * points. Interpolation bases take the envelope heights directly.
 *
 * Seeding the background BEFORE the scale matters: with a zero background
 * seed, the auto-scale absorbs the background level into the peaks and the
 * refinement starts in a false basin (the classic over-scaled start).
 */
export function estimateBackground(
  xValues: readonly number[],
  yObs: readonly number[],
  type: BackgroundType,
  nTerms: number,
): number[] {
  const n = Math.min(xValues.length, yObs.length);
  if (n === 0 || nTerms <= 0) return new Array<number>(Math.max(nTerms, 0)).fill(0);
  let xMin = Infinity;
  let xMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xValues[i]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
  }

  // Lower-envelope anchors: the 10th percentile of each window (min is too
  // noise-sensitive; a low percentile is robust to a few undershooting points).
  const nWindows = Math.max(8, 2 * nTerms + 4);
  const anchors: { x: number; y: number }[] = [];
  const perWindow = Math.max(4, Math.floor(n / nWindows));
  for (let w = 0; w < nWindows; w++) {
    const start = Math.floor((w * n) / nWindows);
    const end = Math.min(n, Math.max(start + perWindow, Math.floor(((w + 1) * n) / nWindows)));
    if (end <= start) continue;
    const ys: number[] = [];
    let xSum = 0;
    for (let i = start; i < end; i++) {
      ys.push(yObs[i]!);
      xSum += xValues[i]!;
    }
    ys.sort((a, b) => a - b);
    anchors.push({ x: xSum / (end - start), y: ys[Math.floor(ys.length * 0.1)]! });
  }
  if (anchors.length === 0) return new Array<number>(nTerms).fill(0);

  if (type === "linInterpolate" || type === "logInterpolate") {
    // Interpolation coefficients ARE background heights at n equidistant
    // anchor points: read the envelope at those positions directly.
    const out: number[] = [];
    for (let k = 0; k < nTerms; k++) {
      const xk = nTerms === 1 ? (xMin + xMax) / 2 : xMin + (k * (xMax - xMin)) / (nTerms - 1);
      let best = anchors[0]!;
      for (const a of anchors) if (Math.abs(a.x - xk) < Math.abs(best.x - xk)) best = a;
      out.push(type === "logInterpolate" ? Math.max(best.y, 1e-6) : best.y);
    }
    return out;
  }

  // Least-squares fit of the basis to the envelope anchors: normal equations
  // over the per-term basis functions (evaluate each term via a unit vector).
  const m = anchors.length;
  const design: number[][] = anchors.map((a) =>
    Array.from({ length: nTerms }, (_, t) => {
      const unit = new Array<number>(nTerms).fill(0);
      unit[t] = 1;
      return evaluateBackground(a.x, unit, type, xMin, xMax);
    }),
  );
  const ata: number[][] = Array.from({ length: nTerms }, () => new Array<number>(nTerms).fill(0));
  const atb = new Array<number>(nTerms).fill(0);
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < nTerms; a++) {
      atb[a]! += design[i]![a]! * anchors[i]!.y;
      for (let b = a; b < nTerms; b++) ata[a]![b]! += design[i]![a]! * design[i]![b]!;
    }
  }
  for (let a = 0; a < nTerms; a++) for (let b = 0; b < a; b++) ata[a]![b] = ata[b]![a]!;
  // Tiny ridge for stability on short patterns; Gaussian elimination.
  for (let a = 0; a < nTerms; a++) ata[a]![a]! += 1e-9 * (ata[a]![a]! || 1);
  const coeffs = solveDense(ata, atb);
  return coeffs ?? new Array<number>(nTerms).fill(0);
}

/** Solve A·x = b (dense, symmetric positive-ish) by Gaussian elimination with
 *  partial pivoting; null when singular. Small n only (background terms). */
function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / M[i]![i]!);
}
