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
  | "peakWidth"
  | "profileU"
  | "profileV"
  | "profileW"
  | "zeroShift"
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
  /** Human-readable notes, warnings, or failure reason. */
  readonly message?: string;
}

/** Tuning knobs for the least-squares driver. */
export interface RefinementOptions {
  readonly maxIterations: number;
  /** Relative change in χ² below which the fit is considered converged. */
  readonly convergenceTolerance: number;
  /** Initial Levenberg–Marquardt damping factor. */
  readonly lambda?: number;
}
