/**
 * Powder profile synthesis: spread integrated peak intensities into a
 * continuous pattern using a peak-shape function plus a polynomial background.
 *
 * Peak shapes (minimal engine):
 *  - Gaussian
 *  - pseudo-Voigt (Gaussian/Lorentzian mix via η)
 *
 * Peak width follows a simplified Caglioti form FWHM² = U·tan²θ + V·tanθ + W;
 * the minimal engine exposes a single width parameter and optional U,V,W.
 */

const LN2 = Math.LN2;
const SQRT_LN2_OVER_PI = Math.sqrt(LN2 / Math.PI);

export function gaussian(x: number, center: number, fwhm: number): number {
  const sigmaFactor = (2 * SQRT_LN2_OVER_PI) / fwhm;
  const t = (x - center) / fwhm;
  return sigmaFactor * Math.exp(-4 * LN2 * t * t);
}

export function lorentzian(x: number, center: number, fwhm: number): number {
  const hwhm = fwhm / 2;
  return (hwhm / Math.PI) / ((x - center) * (x - center) + hwhm * hwhm);
}

/** Pseudo-Voigt: η·L + (1−η)·G, η ∈ [0,1]. */
export function pseudoVoigt(x: number, center: number, fwhm: number, eta: number): number {
  const e = Math.min(Math.max(eta, 0), 1);
  return e * lorentzian(x, center, fwhm) + (1 - e) * gaussian(x, center, fwhm);
}

export interface CagliotiParams {
  readonly u: number;
  readonly v: number;
  readonly w: number;
}

/** FWHM(θ) from Caglioti U,V,W (θ in radians). Clamped to a small positive floor. */
export function cagliotiFwhm(twoThetaDeg: number, p: CagliotiParams): number {
  const theta = (twoThetaDeg / 2) * (Math.PI / 180);
  const t = Math.tan(theta);
  const fwhm2 = p.u * t * t + p.v * t + p.w;
  return Math.sqrt(Math.max(fwhm2, 1e-6));
}

export interface ProfilePeak {
  readonly center: number;
  readonly intensity: number;
  readonly fwhm: number;
}

export type PeakShape = "gaussian" | "pseudoVoigt";

export interface ProfileOptions {
  readonly shape: PeakShape;
  /** Mixing parameter for pseudo-Voigt; ignored for Gaussian. */
  readonly eta?: number;
  /** Polynomial background coefficients c0 + c1·x + c2·x² + …. */
  readonly background?: readonly number[];
}

function backgroundAt(x: number, coeffs: readonly number[] | undefined): number {
  if (!coeffs || coeffs.length === 0) return 0;
  let value = 0;
  let xp = 1;
  for (const c of coeffs) {
    value += c * xp;
    xp *= x;
  }
  return value;
}

function shapeAt(x: number, peak: ProfilePeak, opts: ProfileOptions): number {
  if (opts.shape === "gaussian") {
    return gaussian(x, peak.center, peak.fwhm);
  }
  return pseudoVoigt(x, peak.center, peak.fwhm, opts.eta ?? 0.5);
}

/**
 * Evaluate the full calculated pattern y(x) over an abscissa grid: the sum of
 * profile-spread peaks plus the polynomial background.
 */
export function synthesizePattern(
  xValues: readonly number[],
  peaks: readonly ProfilePeak[],
  opts: ProfileOptions,
): Float64Array {
  const y = new Float64Array(xValues.length);
  for (let i = 0; i < xValues.length; i++) {
    const x = xValues[i]!;
    let sum = backgroundAt(x, opts.background);
    for (const peak of peaks) {
      // Skip peaks far outside their effective support for efficiency.
      if (Math.abs(x - peak.center) > 20 * peak.fwhm) continue;
      sum += peak.intensity * shapeAt(x, peak, opts);
    }
    y[i] = sum;
  }
  return y;
}
