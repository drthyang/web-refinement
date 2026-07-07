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

import { evaluateBackground, type BackgroundType } from "@/core/diffraction/background";

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

/** Gaussian FWHM(θ) from Caglioti U,V,W (θ in radians). Clamped to a small floor. */
export function cagliotiFwhm(twoThetaDeg: number, p: CagliotiParams): number {
  const theta = (twoThetaDeg / 2) * (Math.PI / 180);
  const t = Math.tan(theta);
  const fwhm2 = p.u * t * t + p.v * t + p.w;
  return Math.sqrt(Math.max(fwhm2, 1e-6));
}

/** Lorentzian size–strain coefficients (GSAS-II convention). */
export interface LorentzianParams {
  /** Size (Scherrer) term, broadening ∝ 1/cosθ. */
  readonly x: number;
  /** Microstrain term, broadening ∝ tanθ. */
  readonly y: number;
}

/** Lorentzian FWHM(θ) from GSAS-II X,Y: Γ_L = X/cosθ + Y·tanθ. Floored at 0. */
export function lorentzianFwhm(twoThetaDeg: number, p: LorentzianParams): number {
  const theta = (twoThetaDeg / 2) * (Math.PI / 180);
  return Math.max(p.x / Math.cos(theta) + p.y * Math.tan(theta), 0);
}

/**
 * Thompson–Cox–Hastings pseudo-Voigt: combine a Gaussian FWHM Γ_G and a
 * Lorentzian FWHM Γ_L (same unit) into the total pseudo-Voigt FWHM Γ and the
 * mixing fraction η. This is the standard approximation to a true Voigt used by
 * GSAS-II / FullProf, and is what lets independent Gaussian (instrument) and
 * Lorentzian (sample size–strain) broadening coexist in one peak.
 *
 *   Γ⁵ = Γ_G⁵ + 2.69269 Γ_G⁴Γ_L + 2.42843 Γ_G³Γ_L² + 4.47163 Γ_G²Γ_L³
 *        + 0.07842 Γ_G Γ_L⁴ + Γ_L⁵
 *   η  = 1.36603 (Γ_L/Γ) − 0.47719 (Γ_L/Γ)² + 0.11116 (Γ_L/Γ)³
 */
export function tchPseudoVoigt(gammaG: number, gammaL: number): { fwhm: number; eta: number } {
  const g = Math.max(gammaG, 1e-9);
  const l = Math.max(gammaL, 0);
  const g2 = g * g, g3 = g2 * g, g4 = g3 * g, g5 = g4 * g;
  const l2 = l * l, l3 = l2 * l, l4 = l3 * l, l5 = l4 * l;
  const fwhm = Math.pow(
    g5 + 2.69269 * g4 * l + 2.42843 * g3 * l2 + 4.47163 * g2 * l3 + 0.07842 * g * l4 + l5,
    0.2,
  );
  const r = l / fwhm;
  const eta = Math.min(Math.max(1.36603 * r - 0.47719 * r * r + 0.11116 * r * r * r, 0), 1);
  return { fwhm, eta };
}

export interface ProfilePeak {
  readonly center: number;
  readonly intensity: number;
  readonly fwhm: number;
  /** Per-peak pseudo-Voigt mixing (from TCH); falls back to the global η. */
  readonly eta?: number;
}

export type PeakShape = "gaussian" | "pseudoVoigt";

export interface ProfileOptions {
  readonly shape: PeakShape;
  /** Mixing parameter for pseudo-Voigt; ignored for Gaussian. */
  readonly eta?: number;
  /** Background coefficients (c0 first). Interpreted per `backgroundType`. */
  readonly background?: readonly number[];
  /** Background model; defaults to Chebyshev (well-conditioned for wide x). */
  readonly backgroundType?: BackgroundType;
}

function shapeAt(x: number, peak: ProfilePeak, opts: ProfileOptions): number {
  if (opts.shape === "gaussian") {
    return gaussian(x, peak.center, peak.fwhm);
  }
  // A per-peak η (from the TCH combination of Gaussian + Lorentzian widths) wins
  // over the global η; the global value is the single-width fallback.
  return pseudoVoigt(x, peak.center, peak.fwhm, peak.eta ?? opts.eta ?? 0.5);
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
  // Chebyshev normalization needs the abscissa span; compute it once.
  const bgType = opts.backgroundType ?? "chebyshev";
  let xMin = Infinity;
  let xMax = -Infinity;
  if (opts.background && opts.background.length > 0) {
    for (const x of xValues) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }
  for (let i = 0; i < xValues.length; i++) {
    const x = xValues[i]!;
    let sum = evaluateBackground(x, opts.background, bgType, xMin, xMax);
    for (const peak of peaks) {
      // Skip peaks far outside their effective support for efficiency.
      if (Math.abs(x - peak.center) > 20 * peak.fwhm) continue;
      sum += peak.intensity * shapeAt(x, peak, opts);
    }
    y[i] = sum;
  }
  return y;
}
