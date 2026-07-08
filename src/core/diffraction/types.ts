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
