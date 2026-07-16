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
    }
  /** Time-of-flight neutron: no single wavelength; d-spacing comes from TOF. */
  | { readonly kind: "neutron-tof" };

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
   * Standard uncertainty on `gObs`, when the reduction wrote one. Informational:
   * G(r) points are strongly correlated (finite-Q sine transform), so the fit
   * uses uniform weights and Rw, not `1/σ²` (see PDF_MPDF_ROADMAP §8).
   */
  readonly sigma?: number;
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
}

/** Any diffraction dataset the engine can refine against. */
export type DiffractionDataset = SingleCrystalDataset | PowderPattern;

/**
 * A calculated reflection: the output of structure-factor calculation, carrying
 * both nuclear and (optionally) magnetic contributions kept separately so they
 * can be reported and plotted independently.
 */
export interface CalculatedReflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  /** |Q| in Å⁻¹ (= 2π/d), cached for form-factor and profile evaluation. */
  readonly qMagnitude: number;
  /** d-spacing in Å. */
  readonly dSpacing: number;
  /** Reflection multiplicity for powder (equivalent hkl under Laue symmetry). */
  readonly multiplicity: number;
  /** Lorentz–polarization correction applied to |F|² → I. */
  readonly lorentzPolarization: number;
  /** Nuclear structure-factor modulus squared, |F_N|². */
  readonly fNuclearSq: number;
  /** Magnetic structure-factor modulus squared, |F_M⊥|². Zero when non-magnetic. */
  readonly fMagneticSq: number;
  /** Total calculated intensity (scaled), for comparison against observed. */
  readonly iCalc: number;
}
