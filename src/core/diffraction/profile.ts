/**
 * Powder profile synthesis: spread integrated peak intensities into a
 * continuous pattern using a peak-shape function plus a polynomial background.
 *
 * Peak shapes (minimal engine):
 *  - Gaussian
 *  - pseudo-Voigt (Gaussian/Lorentzian mix via η)
 *
 * Peak width follows the Caglioti form FWHM² = U·tan²θ + V·tanθ + W (Caglioti,
 * Paoletti & Ricci, *Nucl. Instrum.* 3 (1958) 223); the minimal engine exposes a
 * single width parameter and optional U,V,W.
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
 *
 * Reference: Thompson, Cox & Hastings, *J. Appl. Cryst.* 20 (1987) 79.
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
  /** Symmetric width used for the Gaussian/pseudo-Voigt shapes and, for a TOF
   *  peak, as the support half-width proxy for the far-peak skip. */
  readonly fwhm: number;
  /** Per-peak pseudo-Voigt mixing (from TCH); falls back to the global η. */
  readonly eta?: number;
  /** Back-to-back-exponential TOF shape; present only for `shape: "tof"`. */
  readonly tof?: TofShape;
}

/**
 * Finger–Cox–Jephcoat axial-divergence asymmetry (S/L, H/L), the sample and
 * detector-slit half-heights over the diffractometer radius. Both are refinable;
 * S is often treated as adjustable to absorb divergent optics (Finger et al.,
 * 1994).
 */
export interface AxialDivergence {
  readonly sl: number;
  readonly hl: number;
}

/** Gauss–Legendre nodes/weights on [-1, 1], cached by point count. */
const glCache = new Map<number, { nodes: number[]; weights: number[] }>();
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const cached = glCache.get(n);
  if (cached) return cached;
  const nodes = new Array<number>(n).fill(0);
  const weights = new Array<number>(n).fill(0);
  const m = (n + 1) >> 1;
  for (let i = 0; i < m; i++) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5)); // initial root guess
    let dp = 0;
    for (let iter = 0; iter < 100; iter++) {
      let p1 = 1, p2 = 0;
      for (let j = 0; j < n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j + 1) * x * p2 - j * p3) / (j + 1);
      }
      dp = (n * (x * p1 - p2)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    nodes[i] = -x;
    nodes[n - 1 - i] = x;
    const w = 2 / ((1 - x * x) * dp * dp);
    weights[i] = w;
    weights[n - 1 - i] = w;
  }
  const result = { nodes, weights };
  glCache.set(n, result);
  return result;
}

/**
 * Expand a Bragg peak at `center2Theta` (degrees) into Finger–Cox–Jephcoat
 * sub-peaks that reproduce axial-divergence asymmetry — a long low-angle tail for
 * 2θ < 90° (Finger, Cox & Jephcoat, J. Appl. Cryst. 27, 892, 1994). Each returned
 * sub-peak is the symmetric profile shifted to a quadrature node between 2θ_min
 * and 2θ, weighted by W/(h·cos2φ); weights are normalized to sum to 1 (intensity
 * preserved). Returns a single unit-weight peak when the asymmetry is negligible
 * or 2θ ≥ 90° (not modelled; irrelevant for the low-angle regime this targets).
 */
export function fcjSubPeaks(
  center2Theta: number,
  axial: AxialDivergence,
  nQuad = 16,
): { center: number; weight: number }[] {
  const single = [{ center: center2Theta, weight: 1 }];
  const { sl, hl } = axial;
  const sum = sl + hl;
  if (sum <= 1e-7 || center2Theta <= 0 || center2Theta >= 90) return single;

  const rad = Math.PI / 180;
  const cos2T = Math.cos(center2Theta * rad);
  const dif = Math.abs(hl - sl);
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  // Eq (4)/(5): the ramp foot (2θ_min) and the inflection (2θ_infl), in degrees.
  const twoThetaMin = Math.acos(clamp(cos2T * Math.sqrt(sum * sum + 1))) / rad;
  const twoThetaInfl = Math.acos(clamp(cos2T * Math.sqrt(dif * dif + 1))) / rad;
  if (!(twoThetaMin < center2Theta - 1e-9)) return single;

  const { nodes, weights } = gaussLegendre(nQuad);
  const mid = 0.5 * (center2Theta + twoThetaMin);
  const half = 0.5 * (center2Theta - twoThetaMin);
  const minSH = Math.min(sl, hl);
  const cos2T2 = cos2T * cos2T;
  const subs: { center: number; weight: number }[] = [];
  let norm = 0;
  for (let k = 0; k < nQuad; k++) {
    const phi = mid + half * nodes[k]!; // 2φ node (degrees)
    const cphi = Math.cos(phi * rad);
    const hL2 = (cphi * cphi) / cos2T2 - 1; // (h/L)² from eq (1)
    if (hL2 <= 1e-12) continue; // at/above the singularity 2φ = 2θ
    const hL = Math.sqrt(hL2);
    const w = phi < twoThetaInfl ? sum - hL : 2 * minSH; // eq (7a)/(7b)
    if (w <= 0) continue;
    const g = (weights[k]! * w) / (hL * cphi); // eq (6) weight, L/2H cancels in norm
    subs.push({ center: phi, weight: g });
    norm += g;
  }
  if (norm <= 0 || subs.length === 0) return single;
  for (const s of subs) s.weight /= norm;
  return subs;
}

// --- Error functions (Numerical Recipes 6.2 rational form, |err| ≲ 1.2e-7) ---
// The polynomial in t = 1/(1+|x|/2) shared by erfc and its scaled variant.
function erfcPoly(t: number): number {
  return t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
}

/** Complementary error function erfc(x) = 1 − erf(x), valid for all real x. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans = t * Math.exp(-z * z - 1.26551223 + erfcPoly(t));
  return x >= 0 ? ans : 2 - ans;
}

/**
 * Scaled complementary error function erfcx(x) = exp(x²)·erfc(x) for x ≥ 0.
 * Computed without forming exp(x²) so no catastrophic cancellation in the tail
 * (the exp(−x²) inside erfc cancels the exp(x²) analytically).
 */
export function erfcxNonneg(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  return t * Math.exp(-1.26551223 + erfcPoly(t));
}

/** Time-of-flight peak-shape parameters at one reflection (all in µs / µs⁻¹). */
export interface TofShape {
  /** Rising-edge exponential rate α (µs⁻¹). */
  readonly alpha: number;
  /** Falling-edge exponential rate β (µs⁻¹). */
  readonly beta: number;
  /** Gaussian standard deviation σ (µs). */
  readonly sigma: number;
}

/**
 * Back-to-back exponentials convolved with a Gaussian — the standard GSAS/
 * Von Dreele TOF peak shape (Jorgensen et al.; Von Dreele, Jorgensen & Windsor,
 * J. Appl. Cryst. 15, 581, 1982). A sharp rising edge (rate α) and a longer
 * falling tail (rate β) give the characteristic TOF asymmetry; the Gaussian σ
 * folds in the moderator/detector resolution. Normalized to unit area, so a
 * peak's integrated intensity multiplies it directly.
 *
 *   H(Δ) = αβ/[2(α+β)] · [ e^u erfc(y) + e^v erfc(z) ]
 *   u = α/2(ασ²+2Δ), y = (ασ²+Δ)/(σ√2);  v = β/2(βσ²−2Δ), z = (βσ²−Δ)/(σ√2)
 *
 * Evaluated in the erfcx form when the erfc argument is ≥ 0 (where e^u would
 * overflow) and directly otherwise (where e^u < 1), so it is stable across the
 * whole profile.
 */
export function tofBackToBack(delta: number, shape: TofShape): number {
  const alpha = Math.max(shape.alpha, 1e-9);
  const beta = Math.max(shape.beta, 1e-9);
  const sigma = Math.max(shape.sigma, 1e-6);
  const s2 = sigma * sigma;
  const norm = (alpha * beta) / (2 * (alpha + beta));
  const gauss = Math.exp(-(delta * delta) / (2 * s2));
  const inv = 1 / (sigma * Math.SQRT2);
  const y = (alpha * s2 + delta) * inv;
  const z = (beta * s2 - delta) * inv;
  // e^u erfc(y) = e^{−Δ²/2σ²} erfcx(y) for y ≥ 0; e^u erfc(y) directly for y < 0.
  const termA = y >= 0 ? gauss * erfcxNonneg(y) : Math.exp(0.5 * alpha * (alpha * s2 + 2 * delta)) * erfc(y);
  const termB = z >= 0 ? gauss * erfcxNonneg(z) : Math.exp(0.5 * beta * (beta * s2 - 2 * delta)) * erfc(z);
  return norm * (termA + termB);
}

export type PeakShape = "gaussian" | "pseudoVoigt" | "tof";

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
  if (opts.shape === "tof" && peak.tof) {
    return tofBackToBack(x - peak.center, peak.tof);
  }
  if (opts.shape === "gaussian" || opts.shape === "tof") {
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
    y[i] = evaluateBackground(xValues[i]!, opts.background, bgType, xMin, xMax);
  }

  // Each peak contributes only within ±20 FWHM of its center. On a monotonic
  // grid (every real diffractogram) that support window is found by binary
  // search, making the cost Σ(window widths) instead of points × peaks — the
  // point-major loop with a per-pair distance test was >90% of every
  // refinement evaluation on synchrotron-scale data (20k points × 5k peaks).
  const n = xValues.length;
  const ascending = n < 2 || xValues[0]! <= xValues[n - 1]!;
  let monotonic = true;
  for (let i = 1; i < n; i++) {
    if (ascending ? xValues[i]! < xValues[i - 1]! : xValues[i]! > xValues[i - 1]!) {
      monotonic = false;
      break;
    }
  }

  if (monotonic) {
    // First index whose x is inside the window approaching from the low side.
    const lowerBound = (v: number): number => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ascending ? xValues[mid]! < v : xValues[mid]! > v) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const peak of peaks) {
      const half = 20 * peak.fwhm;
      const start = lowerBound(ascending ? peak.center - half : peak.center + half);
      for (let i = start; i < n; i++) {
        const x = xValues[i]!;
        if (ascending ? x > peak.center + half : x < peak.center - half) break;
        y[i] = y[i]! + peak.intensity * shapeAt(x, peak, opts);
      }
    }
  } else {
    // Non-monotonic grid: fall back to the point-major loop (the parsers never
    // produce one, but synthetic callers might).
    for (let i = 0; i < n; i++) {
      const x = xValues[i]!;
      let sum = 0;
      for (const peak of peaks) {
        if (Math.abs(x - peak.center) > 20 * peak.fwhm) continue;
        sum += peak.intensity * shapeAt(x, peak, opts);
      }
      y[i] = y[i]! + sum;
    }
  }
  return y;
}
