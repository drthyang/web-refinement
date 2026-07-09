/**
 * Microstructure extraction: turn refined **peak-broadening coefficients** into
 * the numbers a materials study reports — volume-weighted crystallite size
 * ⟨D⟩ and microstrain ε — with instrument-resolution deconvolution and error
 * propagation. This is the analysis layer on top of the Thompson–Cox–Hastings
 * profile (`profile.ts`): the profile *fits* the broadening; this *interprets* it.
 *
 * Conventions (matching the code's GSAS-II units — Lorentzian X, Y are in
 * **centidegrees** 2θ, so the FWHM used elsewhere is `(X/cosθ + Y·tanθ)/100`):
 *
 *   • Size (Scherrer, Lorentzian `X`, broadening ∝ 1/cosθ):
 *       D = 18000·K·λ / (π·X)                                   [Å]
 *     The cosθ cancels between the Scherrer relation and the 1/cosθ shape, so a
 *     pure size term gives one angle-independent D. K is the Scherrer shape
 *     constant (≈0.9 for FWHM of roughly spherical crystallites; K = 1 with the
 *     integral breadth gives the volume-weighted column length). Matches
 *     GSAS-II's `p = 18000·K·λ/(π·LX)`.
 *
 *   • Microstrain (Williamson–Hall, Lorentzian `Y`, broadening ∝ tanθ):
 *       ε = π·Y / 72000            (dimensionless, β = 4·ε·tanθ)
 *     Reported also as ε·100 (%) and ε·10⁶ (ppm). Matches GSAS-II's
 *     microstrain = LY·π/72000·10⁶ ppm.
 *
 * Instrument deconvolution: a Lorentzian ⊗ Lorentzian adds *breadths*, so the
 * sample coefficients are `X_s = X_total − X_instr`, `Y_s = Y_total − Y_instr`
 * (the instrument standard — LaB₆/Si/CeO₂ — is refined the same way and its X,Y
 * subtracted before extraction). A Gaussian ⊗ Gaussian adds *variances*
 * (`U_s = U_total − U_instr` for the Caglioti tan²θ strain term), provided for
 * completeness.
 *
 * References:
 *  - P. Scherrer, Göttinger Nachrichten 2 (1918) 98 — crystallite-size broadening.
 *  - G. K. Williamson & W. H. Hall, Acta Metall. 1 (1953) 22 — size–strain
 *    separation (the "Williamson–Hall" plot).
 *  - A. R. Stokes & A. J. C. Wilson, Proc. Camb. Phil. Soc. 40 (1944) 197 —
 *    strain broadening β = 4·e·tanθ.
 *  - D. Balzar, in *Defect and Microstructure Analysis by Diffraction* (1999) —
 *    integral-breadth methods, Voigt deconvolution.
 *  - B. H. Toby, *Powder Diffr.* 21 (2006) 67; GSAS-II documentation — the
 *    18000/π and π/72000 numeric conventions reproduced here.
 */

/** A value with an optional standard uncertainty (esd). */
export interface Uncertain {
  readonly value: number;
  readonly esd?: number;
}

export interface SizeStrainInput {
  /** Refined Lorentzian size coefficient X (GSAS-II centidegrees). */
  readonly x: number;
  /** Refined Lorentzian strain coefficient Y (GSAS-II centidegrees). */
  readonly y: number;
  /** Wavelength (Å). Required for the size (needs a length scale). */
  readonly wavelength: number;
  /** esd of X, if the covariance is available. */
  readonly xEsd?: number;
  /** esd of Y. */
  readonly yEsd?: number;
  /** Scherrer shape constant K (default 0.9, FWHM of ~spherical crystallites). */
  readonly scherrerK?: number;
  /** Instrument-standard coefficients to deconvolute (subtracted before extraction). */
  readonly instrument?: { readonly x?: number; readonly y?: number; readonly xEsd?: number; readonly yEsd?: number };
}

export interface SizeStrainResult {
  /** Volume-weighted crystallite size (nm), from the Lorentzian size term. */
  readonly sizeNm: Uncertain;
  /** Crystallite size in Å (the raw Scherrer length). */
  readonly sizeAngstrom: Uncertain;
  /** Microstrain ε (dimensionless), from the Lorentzian strain term. */
  readonly strain: Uncertain;
  /** Microstrain in ppm (ε·10⁶) — GSAS-II's reporting unit. */
  readonly strainPpm: Uncertain;
  /** Microstrain as a percentage (ε·100). */
  readonly strainPercent: Uncertain;
  /** Sample-only coefficients after instrument deconvolution. */
  readonly sampleX: number;
  readonly sampleY: number;
  /** True when an instrument standard was subtracted. */
  readonly deconvoluted: boolean;
  /** Warnings (e.g. sample broadening ≤ 0 after deconvolution — size unresolved). */
  readonly notes: string[];
}

const SIZE_CONST = 18000 / Math.PI; // D[Å] = SIZE_CONST·K·λ/X, X in centidegrees
const STRAIN_CONST = Math.PI / 72000; // ε = STRAIN_CONST·Y, Y in centidegrees

/** Quadrature combination of two esds (independent errors). */
function combineEsd(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return Math.sqrt((a ?? 0) ** 2 + (b ?? 0) ** 2);
}

/**
 * Extract crystallite size and microstrain from the refined Lorentzian X, Y.
 * When an `instrument` standard is supplied, its X, Y are subtracted first
 * (Lorentzian breadths subtract). esds propagate as relative errors
 * (σ_D/D = σ_X/X, σ_ε/ε = σ_Y/Y), combined in quadrature with the standard's.
 */
export function extractSizeStrain(input: SizeStrainInput): SizeStrainResult {
  const K = input.scherrerK ?? 0.9;
  const notes: string[] = [];
  const deconvoluted = input.instrument !== undefined;

  const sampleX = input.x - (input.instrument?.x ?? 0);
  const sampleY = input.y - (input.instrument?.y ?? 0);
  const xEsd = combineEsd(input.xEsd, input.instrument?.xEsd);
  const yEsd = combineEsd(input.yEsd, input.instrument?.yEsd);

  // Size from the Lorentzian size term. A non-positive sample X means the sample
  // is not resolvably size-broadened beyond the instrument — report Infinity.
  let sizeA: number;
  let sizeAEsd: number | undefined;
  if (sampleX > 1e-9) {
    sizeA = (SIZE_CONST * K * input.wavelength) / sampleX;
    sizeAEsd = xEsd !== undefined ? sizeA * (xEsd / sampleX) : undefined;
  } else {
    sizeA = Infinity;
    notes.push(
      deconvoluted
        ? "Sample size broadening ≤ 0 after instrument deconvolution: crystallites larger than the resolution limit (size unresolved)."
        : "Lorentzian size coefficient X ≤ 0: no resolvable size broadening.",
    );
  }

  // Microstrain from the Lorentzian strain term (can be negative if over-fit;
  // report the magnitude with a note).
  let eps = STRAIN_CONST * sampleY;
  let epsEsd = yEsd !== undefined ? Math.abs(STRAIN_CONST * yEsd) : undefined;
  if (sampleY < 0) {
    notes.push("Lorentzian strain coefficient Y < 0 after deconvolution: microstrain below the resolution limit (treated as ~0).");
    eps = 0;
    epsEsd = yEsd !== undefined ? Math.abs(STRAIN_CONST * yEsd) : undefined;
  }

  const sizeNm: Uncertain = { value: sizeA / 10, ...(sizeAEsd !== undefined ? { esd: sizeAEsd / 10 } : {}) };
  const sizeAngstrom: Uncertain = { value: sizeA, ...(sizeAEsd !== undefined ? { esd: sizeAEsd } : {}) };
  const strain: Uncertain = { value: eps, ...(epsEsd !== undefined ? { esd: epsEsd } : {}) };
  const strainPpm: Uncertain = { value: eps * 1e6, ...(epsEsd !== undefined ? { esd: epsEsd * 1e6 } : {}) };
  const strainPercent: Uncertain = { value: eps * 100, ...(epsEsd !== undefined ? { esd: epsEsd * 100 } : {}) };

  return { sizeNm, sizeAngstrom, strain, strainPpm, strainPercent, sampleX, sampleY, deconvoluted, notes };
}

/** One measured peak for a Williamson–Hall analysis. */
export interface PeakBreadth {
  /** Bragg angle θ (degrees) — half of 2θ. */
  readonly thetaDeg: number;
  /** Integral breadth β of the peak (degrees 2θ). Use FWHM if that is what was fit. */
  readonly breadthDeg: number;
}

export interface WilliamsonHallResult {
  /** Volume-weighted size (nm) from the intercept Kλ/D. */
  readonly sizeNm: number;
  /** Microstrain ε (dimensionless) from the slope 4ε. */
  readonly strain: number;
  readonly strainPpm: number;
  /** Linear-fit quality (R²) of β·cosθ vs 4·sinθ. */
  readonly rSquared: number;
  /** Fitted intercept (Kλ/D) and slope (4ε), for plotting the WH line. */
  readonly intercept: number;
  readonly slope: number;
}

/**
 * Williamson–Hall analysis from a set of individually-measured peak breadths
 * (e.g. from Le Bail / single-peak fits): the linear model
 *   β·cosθ = K·λ/D + 4·ε·sinθ
 * fit by least squares in the variables (sinθ, β·cosθ). The intercept gives the
 * size, the slope gives the strain. Angles in **radians** internally; breadths
 * converted from degrees. This is the model-independent cross-check on the
 * profile-coefficient extraction above.
 */
export function williamsonHall(peaks: readonly PeakBreadth[], wavelength: number, scherrerK = 0.9): WilliamsonHallResult {
  const DEG = Math.PI / 180;
  const xs: number[] = []; // 4 sinθ
  const ys: number[] = []; // β cosθ  (β in radians of 2θ)
  for (const p of peaks) {
    const th = p.thetaDeg * DEG;
    xs.push(4 * Math.sin(th));
    ys.push(p.breadthDeg * DEG * Math.cos(th));
  }
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i]!, 0);
  const denom = n * sxx - sx * sx;
  const slope = Math.abs(denom) > 1e-12 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;

  // R² of the fit.
  const meanY = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i]!;
    ssRes += (ys[i]! - pred) ** 2;
    ssTot += (ys[i]! - meanY) ** 2;
  }
  const rSquared = ssTot > 1e-15 ? 1 - ssRes / ssTot : 1;

  // x = 4·sinθ, so β·cosθ = intercept + slope·(4 sinθ) ⇒ slope IS ε directly.
  const sizeA = intercept > 1e-12 ? (scherrerK * wavelength) / intercept : Infinity;
  const strain = slope;
  return { sizeNm: sizeA / 10, strain, strainPpm: strain * 1e6, rSquared, intercept, slope };
}
