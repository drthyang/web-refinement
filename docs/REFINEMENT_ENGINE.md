# Refinement Engine

The engine is a data-agnostic non-linear least-squares driver. It knows nothing
about crystallography: it optimizes a vector of numbers against a residual
function. Everything crystallographic is injected. This is what lets single
crystal and powder share one optimizer, and what keeps the whole thing testable.

## The optimization problem

Minimize the weighted sum of squared residuals

```
χ² = Σ_i w_i · [ y_obs,i − y_calc,i(p) ]²
```

over the free parameters `p`, where `w_i = 1/σ_i²`.

- **Single crystal:** `i` ranges over reflections; `y = I(hkl)` (or `|F|`).
- **Powder:** `i` ranges over profile points; `y = y(x_i)`.

Weights:
- If `σ_i` is present, `w_i = 1/σ_i²`.
- Single-crystal missing σ → unit weights.
- Raw powder counts missing σ → `σ_i = √y_obs,i` (Poisson).

## Method: Levenberg-Marquardt with SVD-stabilized Hessian solves

Gauss-Newton with adaptive damping: the standard local optimizer for
crystallographic least squares. The implementation follows the same robustness
principles used in GSAS-II's Hessian least-squares driver without copying that
code: scale the Hessian, solve with a truncated pseudo-inverse when directions
are near-singular, and report the unstable directions instead of hiding them.

Each iteration solves the damped normal equations

```
(JᵀWJ + damping) · Δp = -Jᵀr
```

where `J_ij = ∂r_i/∂p_j`, `r_i = sqrt(w_i) * (y_obs,i - y_calc,i)`.

- `λ` large → gradient descent (safe, slow); `λ` small → Gauss–Newton (fast near
  the minimum). `λ` is decreased on a successful step, increased on a rejected one.
- **Jacobian:** exact one-evaluation columns for affine parameters (scale,
  magnetic scale, background); central finite differences for non-linear
  parameters by default, with opt-in **analytic derivatives for occupancy and
  isotropic B_iso** (validated against FD — roadmap F1.1).
- **Scaling:** the normal matrix is diagonal-preconditioned before each LM solve,
  so scale factors, cell lengths, ADPs, and background coefficients can coexist
  without one unit system dominating the linear algebra.
- **SVD truncation:** the scaled Hessian is solved with a symmetric
  Moore-Penrose pseudo-inverse. Singular values below `svdTolerance *
  max(singularValue)` are dropped, preventing nearly-null parameter combinations
  from producing huge shifts.
- **Bounds:** enforced by clamping/reparameterization; parameters with `min`/`max`
  stay inside `[min, max]`.
- **Fixed parameters** are removed from `p` entirely (not just zero-weighted), so
  the normal-equations matrix stays well-conditioned.

## Interfaces (target shape)

The domain workflow supplies a small object; the driver consumes it:

```ts
interface ResidualModel {
  // Free parameter values the optimizer controls.
  getFreeParameters(): number[];
  setFreeParameters(p: number[]): void;
  // Calculated observations for the current parameters.
  calculate(): Float64Array;      // y_calc, aligned with observations
  observations(): Float64Array;   // y_obs
  weights(): Float64Array;        // w_i
}

interface Optimizer {
  step(model: ResidualModel): RefinementIteration;
  run(model: ResidualModel, opts: RefinementOptions): RefinementResult;
}
```

`RefinementParameter` + `ParameterBinding` are how a `ResidualModel` maps the flat
`p` vector back onto `UnitCell` / `AtomSite` / `MagneticMoment` fields. The driver
never sees those types.

## Agreement factors

Reported after every iteration (`AgreementFactors`):

```
R    = Σ|y_obs − y_calc| / Σ|y_obs|
R_wp = sqrt( Σ w (y_obs − y_calc)² / Σ w·y_obs² )
R_exp = sqrt( (N − P) / Σ w·y_obs² )
GoF  = R_wp / R_exp            # goodness of fit S (GSAS-II "GOF"); χ² per dof = S²
```

`N` = number of *contributing* observations (points with positive weight;
masked/excluded points do not count), `P` = number of free parameters.
`R_wp`/`R_exp`/GoF require weights; unweighted `R` is always available.
Reference: Toby (2006), *Powder Diffr.* 21, 67.

## Uncertainty estimation

After convergence, the parameter covariance is computed from the final Jacobian
using the same normalized Hessian pseudo-inverse:

```
C = pinv(JᵀJ) * reduced_χ²
esd(p_j) = sqrt(C_jj)
```

These populate `RefinementParameter.esd` and `RefinementResult.esd`. The result
also carries diagnostics:

- `svdZeroCount`: number of dropped near-null Hessian directions.
- `singularParameterIds`: parameters participating strongly in dropped
  directions.
- `highCorrelations`: parameter pairs whose covariance correlation exceeds the
  reporting threshold.
- `conditionNumber` and `maxLambda`: numerical health indicators for the final
  Hessian and LM search.

## Refinement history

Each `run` accumulates a `RefinementIteration[]` (iteration number, χ², agreement
factors). This is the audit trail the UI shows and the basis for undo. History is
part of `RefinementResult`, which is part of the saved `ProjectFile`, so a reopened
project shows how it got where it is.

## What is intentionally *not* here yet

- Analytic derivatives for the *full* crystallographic model — affine parameters
  have exact columns, and occupancy/isotropic-B_iso have opt-in validated analytic
  columns (F1.1); coordinates, cell, profile, zero-shift and moments are still
  finite-difference (see [ROADMAP.md](./ROADMAP.md)).
- Symbolic constraint language — Phase 8 starts with direct tying and grouping
  via `RefinementParameter.group` / `expression`, not a full expression compiler.
- Simulated annealing / global optimization — LM is local; good starting models
  are assumed. Called out in [LIMITATIONS.md](./LIMITATIONS.md).
