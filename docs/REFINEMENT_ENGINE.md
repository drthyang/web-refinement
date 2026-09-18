# Refinement Engine

The engine is a data-agnostic non-linear least-squares driver. It optimizes a
vector of numbers against a residual function and knows nothing about
crystallography. The workflow injects everything crystallographic. This is what
lets single crystal, powder and PDF share one optimizer, and what keeps the
engine testable.

## The optimization problem

The engine minimizes the weighted sum of squared residuals over the free
parameters `p`:

```
χ² = Σ_i w_i · [ y_obs,i − y_calc,i(p) ]²
```

- **Single crystal:** `i` runs over reflections, and `y = I(hkl) ∝ F²`.
- **Powder:** `i` runs over profile points, and `y = y(x_i)`.
- **PDF:** `i` runs over r points, and `y = G(r_i)`.

Weights:
- With `σ_i` present, `w_i = 1/σ_i²`.
- Single crystal without σ: unit weights.
- Powder without σ: `σ_i = √y_obs,i` (Poisson), and unit weight where
  `y_obs,i ≤ 0`.
- PDF: unit weights, even when σ is given, because G(r) point errors are
  correlated ([LIMITATIONS.md](./LIMITATIONS.md#real-space-pdf-and-magnetic-pdf)).
- Masked points get weight 0: points outside the fit range, and a repeated
  non-positive sentinel value in powder data.
- Restraints enter as extra pseudo-observation rows with `w = 1/σ²`.

## The problem interface

The domain workflow builds a `RefinementProblem` and hands it to the driver
([`refinement/engine.ts`](../src/core/refinement/engine.ts); simplified here):

```ts
interface RefinementProblem {
  parameters: RefinementParameter[];      // values, bounds, fixed/free, ties
  observations: Float64Array;             // y_obs
  weights: Float64Array;                  // w_i
  calculate(values: Record<string, number>): Float64Array;  // y_calc, aligned with observations
  analyticColumns?(freeParams, freeValues): (Float64Array | null)[];  // optional ∂y_calc/∂p
}
```

The workflow's `calculate` closure applies the values to the model through
`ParameterBinding`s. Each binding maps a parameter id onto a field of a
`UnitCell`, `AtomSite` or `MagneticMoment`, so the driver never sees
crystallographic types. `refine` evaluates serially; `refineParallel` spreads
the Jacobian columns over a worker pool and follows the identical trajectory.

## Method: Levenberg–Marquardt with SVD-stabilized Hessian solves

Gauss–Newton with adaptive damping is the standard local optimizer for
crystallographic least squares. The engine follows the robustness principles of
GSAS-II's Hessian least-squares driver, without copying its code. It scales the
Hessian, solves with a truncated pseudo-inverse, and reports near-singular
directions instead of hiding them.

Each iteration solves the damped normal equations

```
(JᵀJ + λ·diag(JᵀJ)) · Δp = −Jᵀr
```

where `r_i = √w_i · (y_obs,i − y_calc,i)` and `J_ij = ∂r_i/∂p_j`.

- **Damping.** A large λ moves toward gradient descent, which is safe but slow.
  A small λ moves toward Gauss–Newton, which is fast near the minimum. λ is
  divided by 3 after an accepted step and multiplied by 3 after a rejected one.
- **Jacobian.** Linear parameters get an exact column from one extra
  evaluation: scale, magnetic scale, background, and the PDF and mPDF scales.
  Other parameters use central finite differences (FD) unless the problem
  supplies an [analytic column](#analytic-derivatives).
- **Scaling.** Before each solve, column j is divided by `s_j = √(JᵀJ)_jj`, so
  the scaled normal matrix has a unit diagonal. Scale factors, cell lengths,
  ADPs and background coefficients then coexist without one unit system
  dominating the linear algebra.
- **SVD truncation.** The scaled system is solved with a symmetric
  Moore–Penrose pseudo-inverse. Singular values below
  `svdTolerance × max(singular value)` are dropped (`svdTolerance` defaults to
  1e-6), so nearly null parameter combinations cannot produce huge shifts.
- **Dead-column guard.** A parameter with no leverage at the current point, such
  as an exactly stationary pseudo-symmetric direction, has an FD column of pure
  cancellation noise, about `eps·|√w·y|/2h`. Scaling that column to a unit
  diagonal would amplify the noise into a step rejected at every λ, stalling the
  fit. Columns at this noise floor are instead zeroed out of the scaled system:
  their step is exactly 0, and they are reported in `singularParameterIds`.
  Exact columns (linear or analytic) are exempt, because a legitimately tiny
  exact column is what the preconditioner exists to fix.
- **Bounds.** A trial step is clamped into `[min, max]`, and a parameter that
  ends on a bound is reported in `atBounds`. Each shift is also capped at 5× the
  parameter's current magnitude, so one ill-conditioned step cannot throw the
  model out of its basin.
- **Fixed parameters** are removed from `p` entirely, not just given zero
  weight, so the normal matrix stays well-conditioned.
- **Convergence.** A fit converges when the relative change in χ² falls below
  `convergenceTolerance` (default 1e-4). An optional `shiftTolerance`, off by
  default, also stops it once the largest relative shift falls below that value.
  If no downhill step exists, the fit counts as converged when the gradient is
  near zero, and as stalled otherwise.

## Analytic derivatives

For each free parameter, `jacobianPlan` asks `RefinementProblem.analyticColumns`
for a closed-form column. Any column the problem does not supply falls back to
the central finite difference, so analytic columns are purely additive. An
analytic column is computed inline on the thread driving the generator, so who
takes them is a question about *where that thread runs*. The serial `refine`
driver always may (it runs in a worker in the browser, in-process under the MCP
server); `refineParallel` may only when the caller declares its driver thread can
afford the work (`analyticOnDriver`), since in the browser that thread is the UI
thread — cheap for the fused PDF pass, ruinous for the powder template. Both
remain gated behind `analyticDerivatives`, which the worker runners and the MCP
server now set. An analytic-vs-FD
agreement test gates every kind.

The powder builder supplies occupancy and isotropic B columns when the problem
has no restraints
([`analyticJacobian.test.ts`](../src/core/workflow/analyticJacobian.test.ts)).
The real-space PDF model supplies a much larger set through a fused pass
([`pdf/gradients.ts`](../src/core/pdf/gradients.ts)):

- **Fused single pass.** One traversal of the pair list produces G(r) and every
  requested ∂G/∂p column. The value path is bit-identical to `computeGofR`,
  pinned by test, so enabling gradients cannot change a fit.
- **Geometry-aware pairs.** Each `PdfPair` carries the bond unit vector n̂.
  Atoms are expanded with provenance: the site index and the generating
  rotation `R` (`expandStructureAtomsWithProvenance`). A symmetry-mode
  derivative therefore transforms correctly for every orbit image:
  ∂pos/∂v = M·R·axis, and U images transform as R·U_basis·Rᵀ.
- **Analytic kinds:** Qdamp, Qbroad, δ1, δ2, `spdiameter` (> 0), occupancy,
  isotropic B, anisotropic U, and position-shift mode amplitudes. Unlike the
  powder columns, these work with restraints.
- **Finite-difference kinds:** cell, sratio/rcut, tie-referenced parameters,
  and every multi-phase, multi-dataset or mPDF problem.
- **`gradChi2` contract.** `buildPdfProblem` also returns the complete scalar
  gradient ∇χ²(p): analytic columns where available, central differences
  elsewhere. The NUTS sampler consumes it.
- **Measured effect:** LM refinement on the Ni golden runs 2.3× faster with
  analytic columns and lands in the same basin.
- **Gate test:**
  [`pdfAnalyticJacobian.test.ts`](../src/core/workflow/pdfAnalyticJacobian.test.ts)
  compares analytic and FD columns through a Richardson h-vs-h/2 consistency
  filter. The filter removes noise in the FD oracle, not analytic error. The
  ±5σ evaluation window is quantized to the r grid, which puts O(1/h) spikes
  into FD columns at window edges, and `bandLimit` termination spreads them
  across r. So the tight tolerances run with termination off, and grid points
  where the two FD step sizes disagree are excluded.

## Agreement factors

Reported after every iteration (`AgreementFactors`):

```
R    = Σ|y_obs − y_calc| / Σ|y_obs|
R_wp = sqrt( Σ w (y_obs − y_calc)² / Σ w·y_obs² )
R_exp = sqrt( (N − P) / Σ w·y_obs² )
GoF  = R_wp / R_exp            # goodness of fit S (GSAS-II "GOF"); χ² per dof = S²
```

`N` is the number of contributing observations, those with positive weight, and
`P` is the number of free parameters. Masked or excluded points drop out of
every sum and of `N`. `R_wp`, `R_exp` and GoF use the weight values; `R` uses
the weights only to skip masked points. Reference: Toby (2006), *Powder Diffr.*
21, 67.

## Uncertainty estimation

After convergence, the engine computes the parameter covariance from the final
Jacobian, with the same scaled pseudo-inverse:

```
C = pinv(JᵀJ) * reduced_χ²        # reduced_χ² = χ² / (N − P)
esd(p_j) = sqrt(C_jj)
```

The esds fill `RefinementResult.esd`, and callers copy them onto
`RefinementParameter.esd`. A dead column gets esd 0. The result also carries
diagnostics:

- `svdZeroCount`: the number of dropped near-null Hessian directions.
- `singularParameterIds`: parameters that take part strongly in dropped
  directions.
- `highCorrelations`: parameter pairs whose correlation exceeds the reporting
  threshold (default 0.95).
- `conditionNumber` and `maxLambda`: numerical health indicators for the final
  Hessian and the LM search.
- `atBounds` and `maxParameterShift`: parameters resting on a bound, and the
  largest relative shift of the last accepted step.

## Posterior sampling

The covariance above is a linearization. The samplers in `refinement/bayes/`
sample the posterior directly, behind the same `RefinementProblem` seam. What
they support, and their caveats, are in
[LIMITATIONS.md](./LIMITATIONS.md#uncertainty-and-posterior-sampling). Their
validation is in [VALIDATION.md](./VALIDATION.md#bayesian-posterior-sampling).

- **Ensemble sampler** (`sampler.ts`). It uses the affine-invariant stretch move
  (Goodman & Weare 2010, with emcee's conventions). There is no proposal
  covariance to tune, and the move is invariant under the parameter-scaling
  pathologies the LM preconditioner exists to fight.
- **Sans-io design.** Like `refineCore`, the sampler is a generator: it yields
  batches of walker log-posterior evaluations and receives the results. All
  randomness lives inside the generator, so the serial and worker-pool drivers
  produce bit-identical chains. The walker state serializes to a resume token,
  so a bounded run, such as one MCP call, can continue exactly.
- **NUTS** (`nuts.ts`). A No-U-Turn sampler (Hoffman & Gelman 2014, the slice
  variant with dual-averaging step-size adaptation) consumes the PDF `gradChi2`
  contract. It runs leapfrog steps in the unbounded space with a diagonal mass
  matrix seeded from the linearized LM esds, so warmup only tunes the step size.
  Trajectories double until they U-turn, and divergences are counted: a nonzero
  count means the tails cannot be trusted. Chains run in-process, one after
  another; on the Ni golden NUTS reaches R̂ ≈ 1.001 with under a quarter of the
  ensemble's evaluations.
- **Bounds** (`transform.ts`). A two-sided bound maps through a logit and a
  one-sided bound through a log, so every walker moves in an unbounded space.
  The log-Jacobian of the transform is added to the log posterior. The default
  prior is therefore uniform over the original bounded parameter, not the
  transformed one; `sample_posterior` also accepts normal priors.
- **Noise model** (`logPosterior.ts`). Choose it to match the data's
  provenance, because no likelihood is automatically right.

  | model | when | log L |
  | --- | --- | --- |
  | `poisson` | raw independent counts (never rebinned / corrected / subtracted); ensemble sampler only | Σ [yᵢ·ln μᵢ − μᵢ] |
  | `fixed` | processed intensities with honest σ (w = 1/σ²) | −χ²/2 |
  | `studentT` | outliers or a knowingly imperfect model (ν = `nu`, default 5); ensemble only | −((ν+1)/2)·Σ ln(1 + wᵢrᵢ²/ν) |
  | `marginalized` | unknown / unreliable error scale — the default | −(N/2)·ln χ² |

  `marginalized` integrates the unknown error scale out under a Jeffreys prior.
  It is the default because PDF G(r) is fitted with unit weights: its point
  errors are correlated, so an absolute Gaussian likelihood would overstate the
  information content.

  Processed powder data stop being Poisson once corrected or rebinned. Restraint
  rows are Gaussian pseudo-observations, so `poisson` must not run over a
  residual vector that contains them. NUTS uses the scalar χ² gradient, so it
  supports only `marginalized` and `fixed`.

  **Approximation notice:** every model treats residuals as independent from
  point to point. For G(r) that is an approximation: the finite-Qmax Fourier
  transform correlates neighbouring r points, and the marginalized scale absorbs
  only the overall misweighting. The rigorous path, a correlated-residual model
  and then a covariance propagated from the F(Q) reduction, is recorded in
  [PDF_MPDF_ROADMAP.md §8](./PDF_MPDF_ROADMAP.md#8-scientific-caveats--honesty-statement).
- **Diagnostics** (`diagnostics.ts`). The samplers report split-R̂
  (Gelman–Rubin), ESS with Geyer's initial-monotone-sequence truncation,
  quantile credible intervals, the sample correlation matrix, and `esdRatio`:
  the posterior standard deviation over the linearized LM esd, per parameter.
  In the Gaussian limit `esdRatio` → 1. Reporting follows McCluskey et al.
  (2023), *J. Appl. Cryst.* **56**, 12: priors and bounds, chain and step
  counts, autocorrelation-aware ESS and credible intervals are all output fields.
  Fancher et al. (2016), *Sci. Rep.* **6**, 31625 is the crystallographic
  precedent for comparing posterior widths with esds.
- **MCP tool.** `sample_posterior` samples a PDF fit in bounded chunks
  (`nSteps` per call) that continue through the resume token. `sampler: "nuts"`
  selects NUTS for a single-phase fit. Agents run a converged refinement first
  and seed from its values.
- **Posterior view.** The powder and PDF workbenches run the ensemble sampler
  over the worker pool, 400 steps at a time. A Continue button extends the chain
  through the same resume token. The view shows per-parameter marginals,
  credible intervals, `esdRatio`, R̂ and ESS.

Planned sampler work is ordered in [ROADMAP.md](./ROADMAP.md), F1 item 8.

## Sequential (series) refinement

`refinement/sequential.ts` refines an ordered series of datasets, such as a
temperature, pressure or composition series: the GSAS-II "sequential
refinement" workflow. Each dataset gets its own copy of the parameters, seeded
from the previous dataset's refined values. This is the third residual topology,
next to single-dataset fitting and multi-dataset co-refinement.

- The controller is engine-level and domain-blind: a dataset supplies only a
  `RefinementProblem` factory. Rietveld and PDF share it through thin adapters
  in `workflow/sequential.ts` (`powderSequentialDatasets`,
  `pdfSequentialDatasets`).
- A diverged or failed step is not carried into the next seed. The series
  reseeds from the last good step instead.
- The result includes a per-parameter value and esd evolution table: the a(T)
  or moment(T) curves that are the point of a sequential study.
- `seedFromPrevious: false` turns the series into independent refinements. A
  test pins this mode bit-identical to running `refine` on each dataset.

## Refinement history

Each refinement records a `RefinementIteration[]`: the iteration number, χ² and
the agreement factors. The parameter panel shows it as a per-cycle table. History
is part of `RefinementResult`, which the project file saves as
`workspace.refinement.lastResult` ([PROJECT_FORMAT.md](./PROJECT_FORMAT.md)), so
a reopened project shows how the fit got where it is. History holds no parameter
values, so it is not an undo stack; Reset returns parameters to their initial
values.

## What is intentionally not here yet

- **Analytic derivatives for the whole crystallographic model.** Linear kinds
  have exact columns, and powder occupancy and isotropic B and the PDF kinds
  above have analytic ones. Everything else is finite-difference, including
  powder coordinates, cell, profile, zero shift and moments.
- **A general constraint language.** A tie `expression` is one of `= id`,
  `= factor*id + c`, or the magnitude tie `= ±hypot(a, b, …)`
  ([`refinement/constraints.ts`](../src/core/refinement/constraints.ts)), plus
  equal-value grouping via `RefinementParameter.group`. Anything else is
  rejected rather than guessed.
- **Global optimization,** such as simulated annealing. LM is local and assumes
  a good starting model ([LIMITATIONS.md](./LIMITATIONS.md)). Seeded multi-start
  restarts ([`refinement/multiStart.ts`](../src/core/refinement/multiStart.ts))
  re-refine from perturbed starts and keep the lowest χ².
- **Alternative local minimizers** behind the same `RefinementProblem` seam,
  planned as F1 item 7 in [ROADMAP.md](./ROADMAP.md). The candidates are
  L-BFGS/L-BFGS-B and other gradient-only quasi-Newton methods for
  large-parameter or expensive-Jacobian fits, plus structure-preserving LM
  upgrades: geodesic acceleration, trust-region step control and iterative
  LSMR/CG inner solves. LM stays primary because it yields the covariance and
  esds for free; a gradient-only driver would need a final Hessian pass for
  uncertainties anyway.
