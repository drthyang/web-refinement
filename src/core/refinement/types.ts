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
  | "tofCalibration"
  | "tofProfile"
  | "poRatio"
  | "absorption"
  | "magneticScale"
  | "momentX"
  | "momentY"
  | "momentZ";

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
  /** Goodness of fit, χ² = (Rwp / Rexp)². */
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
   * Largest *relative* parameter shift on the final accepted step,
   * `max_j |Δp_j| / (|p_j| + tiny)` — scale-invariant, so a ~1e-11 scale factor
   * and a ~10 cell length compare on equal footing. Near zero means the
   * parameters stopped moving; a large value alongside a "converged" χ² means the
   * fit stopped on the objective while a parameter was still drifting.
   */
  readonly maxParameterShift: number;
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
export interface RefinementOptions {
  readonly maxIterations: number;
  /** Relative change in χ² below which the fit is considered converged. */
  readonly convergenceTolerance: number;
  /**
   * Relative-shift convergence threshold: when the largest relative parameter
   * shift on an accepted step falls below this, the fit is considered converged
   * on the *parameters* (complementing the χ² test). Defaults to 0 (disabled),
   * leaving the χ² test as the sole stopping rule; set > 0 to opt in.
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
}
