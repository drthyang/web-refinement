/**
 * Refinement parameter, constraint, and result models.
 *
 * The refinement engine operates purely on a flat list of RefinementParameters
 * plus a mapping back into the domain model (which cell/atom/moment field each
 * parameter drives). This keeps the least-squares core independent of
 * crystallography: it sees only numbers, bounds, and a residual function.
 */

/**
 * Semantic tag describing what a parameter physically controls. Used for
 * grouping, presets, and applying values back onto the model. Extend as new
 * refinable quantities are added.
 */
export type ParameterKind =
  | "scale"
  | "background"
  | "cellLength"
  | "cellAngle"
  | "atomX"
  | "atomY"
  | "atomZ"
  | "positionShift"
  | "occupancy"
  | "bIso"
  | "uAniso"
  | "peakWidth"
  | "profileU"
  | "profileV"
  | "profileW"
  | "profileX"
  | "profileY"
  | "asymSL"
  | "asymHL"
  | "zeroShift"
  | "sampleDisplacement"
  | "sampleTransparency"
  | "tofCalibration"
  | "tofProfile"
  | "poRatio"
  | "absorption"
  | "surfaceRoughA"
  | "surfaceRoughB"
  | "extinction"
  | "stephensStrain"
  | "anisoSizePerp"
  | "anisoSizePar"
  | "mustrainPerp"
  | "mustrainPar"
  | "mustrainIso"
  | "magneticScale"
  | "momentX"
  | "momentY"
  | "momentZ"
  | "momentMode"
  // Propagation-vector component (r.l.u.), targetKey "k1" | "k2" | "k3" on the
  // magnetic model — see core/magnetic/refinableK.ts.
  | "propagationK"
  // Pair-distribution-function (real-space) parameters — PDF_MPDF_ROADMAP §2.
  // `pdfScale` multiplies the whole G(r) (linear, like `scale`); Qdamp/Qbroad are
  // the instrument-resolution envelope/broadening (Å⁻¹, calibrated from a
  // standard and normally fixed); δ1/δ2 are the 1/r and 1/r² correlated-motion
  // peak-sharpening coefficients (mutually exclusive models in principle —
  // usually only one is freed).
  | "pdfScale"
  | "qdamp"
  | "qbroad"
  | "delta1"
  | "delta2"
  // Spherical-particle diameter (Å) for the nanoparticle PDF envelope; 0 = bulk.
  | "spdiameter"
  // Alternative correlated-motion model (PDFgui sratio/rcut): peak widths are
  // multiplied by `sratio` (≤1) below the cutoff `rcut` (Å). Mutually exclusive
  // with δ1/δ2 in principle — refine one family, never both.
  | "sratio"
  | "rcut"
  // Magnetic PDF (mPDF, roadmap P4). `mpdfOrdScale` scales the ordered
  // (spin-pair) component and `mpdfParaScale` the paramagnetic self-scattering
  // hump of the unnormalized d_mag(r) — both linear. `mpdfPsigma` is the
  // Gaussian broadening (Å) of the magnetic pair peaks (thermal motion), and
  // `corrLength` an exponential short-range-order damping length ξ (Å, 0 = ∞).
  | "mpdfOrdScale"
  | "mpdfParaScale"
  | "mpdfPsigma"
  | "corrLength";

/**
 * True for parameter kinds that drive magnetic moments — the symmetry-mode
 * amplitudes (`momentMode`). Used wherever "the magnetic moment parameters"
 * are added/removed as a set.
 */
export function isMomentParameterKind(kind: ParameterKind): boolean {
  return kind === "momentMode";
}

/**
 * True for every parameter kind that belongs to the magnetic MODEL rather than
 * the nuclear one: the moment modes plus the propagation-vector components.
 * Use it where a magnetic model's rows are added, replaced or dropped as a set
 * (so k rows never outlive the model they drive); keep
 * {@link isMomentParameterKind} where the rows are treated as moments — a
 * time-reversal sign flip must never negate k.
 */
export function isMagneticModelParameterKind(kind: ParameterKind): boolean {
  return kind === "momentMode" || kind === "propagationK";
}

/** A single refinable (or fixed) parameter. */
export interface RefinementParameter {
  readonly id: string;
  /** Display label, e.g. "Fe1 x" or "scale". */
  readonly label: string;
  readonly kind: ParameterKind;
  /** Current value. */
  value: number;
  /** Value at the start of the current refinement, for reset and Δ reporting. */
  initialValue: number;
  /** Lower bound (inclusive) if constrained. */
  readonly min?: number;
  /** Upper bound (inclusive) if constrained. */
  readonly max?: number;
  /** When true, the parameter is held fixed and excluded from the fit. */
  fixed: boolean;
  /**
   * Whether the calculated pattern is a *linear* (affine) function of this
   * parameter — true for scale factors and background coefficients, which enter
   * the model as `scale·I_calc` or `Σ c_k·basis_k`. The engine computes an exact
   * Jacobian column for such parameters from a single evaluation instead of a
   * two-point finite difference (faster and free of truncation error). When
   * omitted, the engine falls back to a per-`kind` default (scale, background,
   * and magnetic scale are treated as linear); set explicitly to override.
   */
  readonly linear?: boolean;
  /**
   * Absolute cap on the per-cycle shift, for a parameter whose useful step is
   * set by the data rather than by its own size — a propagation-vector
   * component, where a step larger than a satellite's width loses the minimum
   * and the default relative cap (5×|value|) is far too loose.
   */
  readonly maxShift?: number;
  /** Optional group name for grouped/tied refinement (Phase 8). */
  readonly group?: string;
  /**
   * Optional constraint expression for tied parameters (Phase 8), e.g.
   * "= 1 - occ(Fe1)". Kept as an opaque string here; the constraint compiler
   * lives outside the type layer. Absent means the parameter is independent.
   */
  readonly expression?: string;
  /**
   * Estimated standard deviation from the covariance matrix, populated after a
   * refinement step. Undefined before the first fit or for fixed parameters.
   */
  esd?: number;
}

/** How a parameter connects to a location in the domain model. */
export interface ParameterBinding {
  readonly parameterId: string;
  readonly kind: ParameterKind;
  /** Id of the structure/dataset/magnetic model the target lives in. */
  readonly targetId: string;
  /** Site label or coefficient index the parameter drives, when applicable. */
  readonly targetKey?: string;
  /**
   * Symmetry-adapted displacement direction (fractional components) for a
   * `positionShift` binding. The parameter value is the magnitude along this
   * mode, added to the site's stored position: X = X₀ + value·axis. Coupled
   * special-position coordinates (e.g. (x,x,x) → [1,1,1]) move together.
   */
  readonly axis?: readonly [number, number, number];
  /**
   * Symmetry-adapted anisotropic ADP tensor mode, ordered as
   * [U11, U22, U33, U12, U13, U23]. A `uAniso` parameter sets the site's full
   * U tensor through the sum of all bound modes for that site.
   */
  readonly uBasis?: readonly [number, number, number, number, number, number];
  /**
   * Symmetry-allowed magnetic-moment mode (crystal-axis components) for a
   * `momentMode` binding. The moment of a site is the sum of its bound modes:
   * m = Σ value·momentBasis, so only symmetry-allowed directions can be nonzero
   * (mirrors `positionShift`/`uAniso`). Coupled components move together.
   */
  readonly momentBasis?: readonly [number, number, number];
  /**
   * Which modulation amplitude a `momentMode` binding drives when the
   * propagation vector has two distinct arms (±k): "cos" (default) adds
   * value·momentBasis to the site's cosine amplitude (`components`), "sin" to
   * its sine/quadrature amplitude (`sinComponents`). A symmetry-forced helical
   * mode binds one parameter to both parts through two bindings.
   */
  readonly momentPart?: "cos" | "sin";
}

/** A soft linear restraint appended as pseudo-observation to least squares. */
export interface LinearRestraint {
  readonly id: string;
  readonly label: string;
  /** Target value for Σ coefficient·parameter. */
  readonly target: number;
  /** Standard uncertainty of the restraint; smaller means stronger. */
  readonly sigma: number;
  readonly terms: readonly {
    readonly parameterId: string;
    readonly coefficient: number;
  }[];
}

/** Convergence/termination status of a refinement run. */
export type RefinementStatus =
  | "converged"
  | "maxIterations"
  | "stalled"
  | "diverged"
  | "failed";

/** Agreement factors for one refinement state. */
export interface AgreementFactors {
  /** Unweighted R factor (on intensities or |F|, per convention in docs). */
  readonly rFactor: number;
  /** Weighted profile/structure-factor R factor, when sigmas are present. */
  readonly rWeighted?: number;
  /** Expected weighted R (statistical floor), for goodness-of-fit. */
  readonly rExpected?: number;
  /** Goodness of fit S = Rwp / Rexp (GSAS-II's "GOF"); reduced χ² = S². */
  readonly goodnessOfFit?: number;
}

/** A single entry in the refinement history log. */
export interface RefinementIteration {
  readonly iteration: number;
  /** Sum of weighted squared residuals for this iteration. */
  readonly chiSquared: number;
  readonly agreement: AgreementFactors;
}

/** Pair of parameters whose covariance implies near-linear dependence. */
export interface RefinementCorrelation {
  readonly parameterIdA: string;
  readonly parameterIdB: string;
  readonly coefficient: number;
}

/**
 * A free parameter whose final value is sitting on one of its bounds. A refined
 * parameter pinned to a bound is **not converged in the interior**: the optimizer
 * would push it past a physical limit, so its esd is meaningless and it usually
 * signals a correlation or an upstream model error (e.g. a B_iso railing to 0
 * because the model over-damps high-angle intensity).
 */
export interface BoundActiveParameter {
  readonly parameterId: string;
  readonly bound: "min" | "max";
  /** The bound value the parameter is resting on. */
  readonly value: number;
}

/** Numerical diagnostics from the least-squares Hessian. */
export interface RefinementDiagnostics {
  /**
   * Number of near-null Hessian directions dropped by the SVD-style
   * pseudo-inverse used for covariance/ESD estimation.
   */
  readonly svdZeroCount: number;
  /** Parameters with the largest participation in dropped singular directions. */
  readonly singularParameterIds: readonly string[];
  /** Effective condition number of the retained Hessian spectrum. */
  readonly conditionNumber: number;
  /** Strong parameter correlations, sorted by absolute coefficient. */
  readonly highCorrelations: readonly RefinementCorrelation[];
  /** Largest LM damping value reached while searching for accepted steps. */
  readonly maxLambda: number;
  /**
   * Free parameters resting on a bound at the end of the fit — a not-converged
   * signal the caller (or an agent) should surface rather than trust the value.
   */
  readonly atBounds: readonly BoundActiveParameter[];
  /**
   * Largest shift/esd on the final accepted step, `max_j |Δp_j| / σ_j`, with
   * σ_j the reported esd — the crystallographic convergence measure (SHELXL's
   * max shift/su, GSAS-II's max shift/esd). Below ~0.1 every parameter has
   * settled well inside its uncertainty; a larger value alongside a
   * "converged" χ² means the fit stopped on the objective while a parameter
   * was still moving. Unlike a shift relative to |p_j|, it stays meaningful
   * for parameters that refine near zero (atom-position offsets, zero shift).
   * Parameters with esd 0 are skipped. It is 0 when no step was accepted, and
   * for an exact fit (wR < 1e-6: noise-free data, whose esds are round-off).
   */
  readonly maxShiftOverEsd: number;
  /** The free parameter that set `maxShiftOverEsd`, when one did. */
  readonly maxShiftParameterId?: string;
}

/** Full result of a refinement run. */
export interface RefinementResult {
  readonly status: RefinementStatus;
  /** Parameter values (by id) at the end of the run. */
  readonly parameters: Readonly<Record<string, number>>;
  /** Estimated standard deviations (by id) from the final covariance matrix. */
  readonly esd: Readonly<Record<string, number>>;
  readonly agreement: AgreementFactors;
  /** Per-iteration history, oldest first. */
  readonly history: readonly RefinementIteration[];
  /** SVD/correlation diagnostics for judging whether the fit is well-posed. */
  readonly diagnostics?: RefinementDiagnostics;
  /** Human-readable notes, warnings, or failure reason. */
  readonly message?: string;
}

/** Tuning knobs for the least-squares driver. */
/**
 * Optional per-call hints to a problem's `calculate`. A forward model may reuse
 * a precomputed intermediate instead of recomputing it. Generic data (no
 * diffraction imports here): each problem type interprets what it understands
 * and ignores the rest, so passing options never changes a result.
 */
export interface CalculateOptions {
  /**
   * Precomputed |F|² per reflection, in the problem's own reflection order, for
   * the given d-window — the seam the GPU structure-factor evaluator uses to
   * inject its batched |F|² while reusing the CPU intensity/profile assembly.
   * Applied only when the d-window and reflection count match; otherwise ignored.
   */
  readonly structureFactors?: {
    readonly f2: Float64Array;
    readonly dMin: number;
    readonly dMax: number;
  };
}

export interface RefinementOptions {
  readonly maxIterations: number;
  /** Relative change in χ² below which the fit is considered converged. */
  readonly convergenceTolerance: number;
  /**
   * Shift/esd convergence threshold: when every parameter's shift on an
   * accepted step is below this fraction of its esd (`max_j |Δp_j|/σ_j`, the
   * measure reported as `maxShiftOverEsd`), the fit is considered converged on
   * the *parameters* (complementing the χ² test). Conventional values are
   * 0.01–0.1. The esds scale with the residual, so a noise-free fit (χ² → 0)
   * never meets it and stops on χ² instead. Defaults to 0 (disabled), leaving
   * the χ² test as the sole stopping rule; set > 0 to opt in.
   */
  readonly shiftTolerance?: number;
  /** Initial Levenberg–Marquardt damping factor. */
  readonly lambda?: number;
  /** Relative singular-value cutoff for the Hessian pseudo-inverse. */
  readonly svdTolerance?: number;
  /** Absolute correlation coefficient above which pairs are reported. */
  readonly correlationThreshold?: number;
  /** Maximum number of high-correlation pairs kept in diagnostics. */
  readonly maxReportedCorrelations?: number;
  /**
   * Opt into the problem's closed-form Jacobian columns (roadmap F1.1), when it
   * provides any. Default false, so an unaware caller gets the plain
   * finite-difference Jacobian and the two drivers stay bit-identical. Analytic
   * columns are exact (no truncation error) and cost no evaluation batch, so
   * where a problem supplies them the fit is both steadier and faster.
   *
   * Because a column is computed inline on the thread driving the generator,
   * `refineParallel` honours this only when the caller also declares its driver
   * thread can afford the work (`ParallelDriverCapabilities.analyticOnDriver`);
   * the serial `refine` always runs off the UI thread and needs no such
   * declaration.
   */
  readonly analyticDerivatives?: boolean;
  /**
   * Runtime-only per-cycle callback for live progress (never serialized through
   * the worker protocol — set locally by the worker/runner, not by requests).
   * Called after each accepted iteration with the current calculated vector and
   * its agreement factors.
   */
  readonly onIteration?: (yCalc: Float64Array, agreement: AgreementFactors) => void;
}
