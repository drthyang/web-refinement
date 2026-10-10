/**
 * Diffraction data models for single-crystal and powder workflows.
 *
 * The design goal (Phase 2): both data types share one refinement engine but
 * plug in different calculated-data generators and residual functions. To make
 * that possible, both expose a common notion of "observations with weights",
 * while keeping their domain-specific fields distinct.
 */

/** Probe radiation. Determines which scattering table (b vs f) is used. */
export type Radiation =
  | { readonly kind: "neutron"; readonly wavelength: number }
  | {
      readonly kind: "xray";
      readonly wavelength: number;
      /**
       * Polarization fraction P (the beam fraction polarized perpendicular to
       * the diffraction plane). The CW polarization factor is (1−P)·cos²2θ + P;
       * P = 0.5 is the unpolarized lab value ((1+cos²2θ)/2), a monochromated
       * synchrotron is ~0.9–0.95. Absent ⇒ 0.5. (GSAS-II "Polariz.")
       */
      readonly polarization?: number;
      /**
       * The tube's second line, Kα₂: its wavelength (Å) and its intensity
       * relative to Kα₁ (≈ 0.5 for Cu, Co and Mo). Every reflection is drawn
       * at both wavelengths. Absent ⇒ a monochromatic beam. (GSAS-II Lam2,
       * I(L2)/I(L1).)
       */
      readonly kAlpha2?: KAlpha2;
    }
  /** Time-of-flight neutron: no single wavelength; d-spacing comes from TOF. */
  | { readonly kind: "neutron-tof" };

/** A lab tube's second emission line: wavelength (Å) and intensity relative to Kα₁. */
export interface KAlpha2 {
  readonly wavelength: number;
  readonly ratio: number;
}

/** Abscissa unit for a powder pattern point. */
export type PowderXUnit = "twoTheta" | "dSpacing" | "q" | "tof";

/** A single measured Bragg reflection (single-crystal). */
export interface SingleCrystalReflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  /** Observed integrated intensity. */
  readonly iObs: number;
  /** Standard uncertainty on `iObs`. When absent, unit weights are used. */
  readonly sigma?: number;
}

/** A single measured point in a powder pattern. */
export interface PowderPoint {
  /** Abscissa value; unit given by the parent pattern's `xUnit`. */
  readonly x: number;
  /** Observed intensity (counts or normalized). */
  readonly yObs: number;
  /** Standard uncertainty on `yObs`. Defaults to sqrt(yObs) for raw counts. */
  readonly sigma?: number;
}

/** A single-crystal reflection dataset. */
export interface SingleCrystalDataset {
  readonly id: string;
  readonly name: string;
  readonly radiation: Radiation;
  readonly reflections: readonly SingleCrystalReflection[];
}

/** A powder diffraction pattern. */
export interface PowderPattern {
  readonly id: string;
  readonly name: string;
  readonly xUnit: PowderXUnit;
  readonly radiation: Radiation;
  readonly points: readonly PowderPoint[];
  /**
   * Convenience wavelength in Å. Redundant with `radiation.wavelength` for
   * constant-wavelength data; retained because some file formats carry it in
   * the pattern header rather than instrument metadata.
   */
  readonly wavelength?: number;
}

/**
 * Total-scattering probe for a pair distribution function. Unlike {@link Radiation}
 * there is no single wavelength (the PDF is already reduced from S(Q)); only the
 * weighting regime differs — neutron uses the constant coherent scattering length
 * `b`, X-ray uses the electron-count `Z = f(0)` per PDFfit2 (see PDF_MPDF_ROADMAP §3).
 */
export type PdfScatteringType = "neutron" | "xray";

/** A single point of an observed reduced PDF, `G(r) = 4πr[ρ(r) − ρ₀]` (Å⁻²). */
export interface PdfPoint {
  /** Radial distance r in Å. */
  readonly r: number;
  /** Observed reduced PDF G(r) (Å⁻²). May be negative — G(r) oscillates about 0. */
  readonly gObs: number;
  /**
   * Standard uncertainty on `gObs`: the reduction's own dG column, or — for a
   * pattern transformed here from S(Q)/F(Q) with errors — σ_G(r) propagated
   * exactly through the sine transform (`totalscattering/fourier.ts`).
   * Informational: G(r) points are strongly correlated (finite-Q sine
   * transform), so the fit uses uniform weights and Rw, not `1/σ²` (see
   * PDF_MPDF_ROADMAP §8). The full covariance is available from the retained
   * {@link PdfPattern.reciprocal} data.
   */
  readonly sigma?: number;
}

/**
 * Reduced reciprocal-space data — the S(Q) or F(Q) a G(r) was transformed
 * from, retained verbatim (the whole file, not just the transform window) so
 * the error budget can be re-propagated and the transform redone with other
 * settings. Plain arrays: it is saved in project files.
 */
export interface ReciprocalSpaceData {
  /** "sq" = S(Q), dimensionless, → 1 at high Q; "fq" = F(Q) = Q·[S(Q) − 1] (Å⁻¹). */
  readonly kind: "sq" | "fq";
  /** Momentum transfer Q (Å⁻¹), strictly ascending. */
  readonly q: readonly number[];
  /** S(Q) or F(Q) at each Q, per `kind`. */
  readonly y: readonly number[];
  /**
   * Standard uncertainty of `y`, when the reduction wrote one (Mantid `E`,
   * PDFgetN `dS(Q)`). Treated as statistically INDEPENDENT between Q points —
   * the assumption under which σ_G(r) and Cov[G] are propagated.
   */
  readonly sigma?: readonly number[];
}

/** How a G(r) was produced from {@link ReciprocalSpaceData} (provenance). */
export interface SineTransformRecord {
  /** First and last Q node actually integrated (Å⁻¹). */
  readonly qmin: number;
  readonly qmax: number;
  /** Modification function applied to F(Q): none, or Lorch (1969). */
  readonly modification: "none" | "lorch";
  /** Treatment of the unmeasured 0 → Qmin region: omitted, or S(Q) linear to S(0) = 0 (StoG). */
  readonly lowQ: "none" | "linear";
}

/**
 * An observed reduced pair distribution function `G(r)` — the observable a PDF /
 * mPDF refinement fits. A fundamentally different observable from a diffraction
 * pattern (real-space abscissa, signed ordinate), so it is its own type rather
 * than a {@link PowderPattern} with an added x-unit. The total-scattering
 * metadata is read from the `.gr` header and consumed by the real-space
 * calculator (Qmax termination, Qdamp/Qbroad envelopes, composition normalization).
 */
export interface PdfPattern {
  readonly id: string;
  readonly name: string;
  readonly scatteringType: PdfScatteringType;
  readonly points: readonly PdfPoint[];
  /** Fourier-termination Qmax used in the reduction (Å⁻¹); drives the sinc ripple. */
  readonly qmax?: number;
  /** Lower Fourier limit Qmin (Å⁻¹); a nonzero value biases low-r. */
  readonly qmin?: number;
  /** Instrument Qmax over which input intensities were meaningful (Å⁻¹). */
  readonly qmaxInst?: number;
  /** Gaussian PDF resolution-dampening coefficient Qdamp (Å⁻¹), if calibrated. */
  readonly qdamp?: number;
  /** r-dependent PDF peak-broadening coefficient Qbroad (Å⁻¹), if calibrated. */
  readonly qbroad?: number;
  /** Ad-hoc-correction low-r validity limit r_poly (Å) from PDFgetX3. */
  readonly rpoly?: number;
  /** Grid step Δr in Å (redundant with the points, kept from the header). */
  readonly rstep?: number;
  /** Sample composition string as written in the header, e.g. "Ga Nb4 Se8". */
  readonly composition?: string;
  /**
   * What the loaded file actually contained. "gr" = the G(r) itself; "sq"/"fq"
   * = Q-space S(Q)/F(Q) that the app sine-transformed to G(r) at load time
   * (with `qmax` taken from the data's own Q extent); "fgr" = a PDFgui fit
   * export whose observed curve was rebuilt as Gcalc + Gdiff; "fgr-diff" = the
   * RESIDUAL of that fit (the mPDF signal — not a total G(r)). Provenance for
   * the UI and reports; absent means "gr".
   */
  readonly sourceKind?: "gr" | "sq" | "fq" | "fgr" | "fgr-diff";
  /**
   * The S(Q)/F(Q) the points were transformed from (sourceKind "sq"/"fq"),
   * with its error column when the file had one. Absent for a G(r) file.
   */
  readonly reciprocal?: ReciprocalSpaceData;
  /** How `points` were produced from `reciprocal` (present with it). */
  readonly transform?: SineTransformRecord;
}

/** Any diffraction dataset the engine can refine against. */
export type DiffractionDataset = SingleCrystalDataset | PowderPattern;

