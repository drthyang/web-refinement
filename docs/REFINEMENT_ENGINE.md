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

## Method: Levenberg–Marquardt

Gauss–Newton with adaptive damping — the standard choice for crystallographic
least squares. Each iteration solves the normal equations

```
(JᵀWJ + λ·diag(JᵀWJ)) · Δp = JᵀW·r
```

where `J_ij = ∂y_calc,i/∂p_j`, `W = diag(w_i)`, `r_i = y_obs,i − y_calc,i`.

- `λ` large → gradient descent (safe, slow); `λ` small → Gauss–Newton (fast near
  the minimum). `λ` is decreased on a successful step, increased on a rejected one.
- **Jacobian:** numerical (central finite differences) first — robust and easy to
  validate. Analytic derivatives are a later optimization for hotspots.
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
GoF  = (R_wp / R_exp)²          # χ² per degree of freedom
```

`N` = number of observations, `P` = number of free parameters. `R_wp`/`R_exp`/GoF
require weights; unweighted `R` is always available.

## Uncertainty estimation

After convergence, the parameter covariance is

```
C = (JᵀWJ)⁻¹        (optionally scaled by GoF)
esd(p_j) = sqrt(C_jj)
```

These populate `RefinementParameter.esd` and `RefinementResult.esd`. A refinement
tool that reports values without uncertainties is not doing its job, so esds are
part of the result from the start, not an afterthought.

## Refinement history

Each `run` accumulates a `RefinementIteration[]` (iteration number, χ², agreement
factors). This is the audit trail the UI shows and the basis for undo. History is
part of `RefinementResult`, which is part of the saved `ProjectFile`, so a reopened
project shows how it got where it is.

## What is intentionally *not* here yet

- Analytic derivatives (numerical first; see [ROADMAP.md](./ROADMAP.md)).
- Symbolic constraint language — Phase 8 starts with direct tying and grouping
  via `RefinementParameter.group` / `expression`, not a full expression compiler.
- Simulated annealing / global optimization — LM is local; good starting models
  are assumed. Called out in [LIMITATIONS.md](./LIMITATIONS.md).
