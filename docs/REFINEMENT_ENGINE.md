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
  isotropic B_iso** (validated against FD — roadmap F1.1); the real-space PDF
  model supplies a much larger analytic set through the same hook (see
  "Analytic derivatives" below).
- **Scaling:** the normal matrix is diagonal-preconditioned before each LM solve,
  so scale factors, cell lengths, ADPs, and background coefficients can coexist
  without one unit system dominating the linear algebra.
- **SVD truncation:** the scaled Hessian is solved with a symmetric
  Moore-Penrose pseudo-inverse. Singular values below `svdTolerance *
  max(singularValue)` are dropped, preventing nearly-null parameter combinations
  from producing huge shifts.
- **Dead-column guard:** a parameter with *no leverage* at the current point
  (an exactly stationary pseudo-symmetric direction — e.g. a coordinate whose
  pair distances are quadratic at a special value) has a finite-difference
  Jacobian column that is pure cancellation noise (~`eps·|√w·y|/2h`). Such a
  column must not be normalized up to a unit diagonal — the amplified noise
  step would be rejected at every λ and stall the whole fit. Columns at the
  noise floor get the largest scale instead, so the SVD drops them cleanly and
  they are reported in `singularParameterIds`. Exact (linear/analytic) columns
  are exempt: a legitimately tiny exact column is what the preconditioner
  exists to fix.
- **Bounds:** enforced by clamping/reparameterization; parameters with `min`/`max`
  stay inside `[min, max]`.
- **Fixed parameters** are removed from `p` entirely (not just zero-weighted), so
  the normal-equations matrix stays well-conditioned.

## Analytic derivatives: the real-space (PDF) fused pass

`jacobianPlan` consults `RefinementProblem.analyticColumns` per free parameter
and falls back to the central finite difference for any column the problem
does not supply — analytic columns are purely additive, and every kind is
gated by an analytic-vs-FD agreement test. The powder template supplies
occupancy and isotropic B_iso; the PDF forward model now supplies a full
analytic layer ([`pdf/gradients.ts`](../src/core/pdf/gradients.ts)):

- **Fused single pass.** One traversal of the pair list produces G(r) *and*
  every requested ∂G/∂p column. The value path is **bit-identical** to
  `computeGofR` (pinned by test), so enabling gradients cannot change a fit.
- **Geometry-aware pairs.** Each `PdfPair` carries the bond unit vector n̂, and
  atoms are expanded with provenance (site index + generating-operation
  rotation `R` — `expandStructureAtomsWithProvenance`), so a derivative with
  respect to a symmetry-mode amplitude v transforms correctly for every orbit
  image: ∂pos/∂v = M·R·axis, and U images transform as R·U_basis·Rᵀ.
- **Supported kinds:** Qdamp, Qbroad, δ1, δ2, `spdiameter` (> 0), occupancy,
  isotropic B_iso, anisotropic U, and position-shift mode amplitudes.
  Returning `null` falls back to FD: cell, sratio/rcut, tie-referenced
  parameters, and multi-phase / multi-dataset problems.
- **`gradChi2` contract.** `buildPdfProblem` also returns a complete scalar
  gradient ∇χ²(p) — analytic columns where available, central-FD fill-in
  elsewhere — the interface a gradient-based sampler (NUTS) or a gradient-only
  minimizer consumes. Unlike the powder template, the PDF `analyticColumns`
  path supports restraints.
- **Measured effect:** 2.3× faster LM refinement on the Ni golden, same basin.
- **Gate test:**
  [`pdfAnalyticJacobian.test.ts`](../src/core/workflow/pdfAnalyticJacobian.test.ts)
  compares analytic vs FD columns with a Richardson h-vs-h/2 consistency
  filter. The ±5σ evaluation window is quantized to the r grid, which puts
  O(1/h) spikes in the *FD oracle* at window edges, and `bandLimit`
  termination delocalizes them across r — so the tight tolerances run with
  termination off, and grid points whose two FD step sizes disagree are
  excluded as oracle noise rather than analytic error.

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

## Posterior sampling: ensemble MCMC (prototype)

The covariance above is a *linearization*. `refinement/bayes/` adds a second
driver behind the same problem seam that samples the posterior directly —
prototype status, currently exercised on PDF problems.

- **Architecture.** `sampler.ts` is a **sans-io generator** mirroring
  `refineCore`: it yields batches of walker log-posterior evaluations and
  receives the results; all randomness lives inside the generator. The serial
  driver and the worker-pool driver therefore produce **bit-identical**
  chains, and the full walker state serializes to a resume token, so a
  bounded run (e.g. one MCP call) can be continued exactly.
- **Move.** Affine-invariant ensemble stretch move (Goodman & Weare 2010;
  emcee's conventions) — no proposal covariance to tune, and invariant under
  exactly the parameter-scaling pathologies the LM preconditioner exists to
  fight.
- **Noise model** (`logPosterior.ts`). Default `marginalized`: treat the
  global error scale as unknown with a Jeffreys prior and integrate it out,
  giving

  ```
  log L = −(N/2) · ln χ²(p)   (+ const)
  ```

  This is deliberate for PDF G(r), which is fit with **unit weights** because
  its point errors are correlated — an absolute Gaussian likelihood would
  overstate the information content. A plain `fixed` model
  (log L = −χ²/2) is available when the weights are honest.
- **Bounds** (`transform.ts`). Each `[min, max]` parameter samples in an
  unbounded logit-transformed space, with the log-Jacobian of the transform
  added to the log posterior — so the prior is uniform over the *original*
  bounded parameter, not the transformed one.
- **Diagnostics** (`diagnostics.ts`): split-R̂ (Gelman–Rubin, split chains),
  ESS via Geyer's initial-monotone-sequence truncation of the autocorrelation
  sum, quantiles / credible intervals, the sample correlation matrix, and
  **esdRatio** — posterior standard deviation over the linearized LM esd, per
  parameter. In the Gaussian limit esdRatio → 1; the Ni PDFfit2 golden gives
  0.99–1.01, validating the sampler and the LM covariance against each other.
  Reporting follows McCluskey et al. (2023), *J. Appl. Cryst.* **56**, 12:
  priors (bounds), chain/step counts, autocorrelation-aware ESS, and credible
  intervals are all first-class output fields. Fancher et al. (2016), *Sci.
  Rep.* **6**, 31625 is the crystallographic precedent for the
  posterior-width-vs-esd comparison.
- **NUTS (gradient-based v2, `nuts.ts`).** A No-U-Turn sampler (Hoffman &
  Gelman 2014, the slice variant with dual-averaging step-size adaptation)
  consuming the PDF `gradChi2` contract: leapfrog in the unbounded space with
  a **diagonal mass matrix seeded from the linearized LM esds** (the kinetic
  metric matches the posterior scales out of the box, so warmup only tunes the
  step size), tree doubling with U-turn termination, and divergence counting
  (a nonzero divergence count means the tails cannot be trusted). Sequential
  gradient evaluations — in-process, chains run one after another; on the Ni
  golden it reaches R̂ ≈ 1.001 in ~5× fewer evaluations than the ensemble.
  Selected via `sample_posterior`'s `sampler: "nuts"` (single-phase PDF only —
  the kinds still on FD fill in through `gradChi2` transparently).
- **Surfaces.** The `sample_posterior` MCP tool (bounded `nSteps` per call,
  resume-token continuation; agents run a converged refine first and seed from
  its values), and the PDF workbench's **Posterior** view (ensemble sampling
  over the worker pool: per-parameter marginals, credible intervals, esdRatio,
  R̂/ESS, and a Continue button driving the same resume token).
- **Next:** analytic cell gradients (cell posteriors at full speed); NUTS
  behind the worker pool; a corner plot for pairwise correlations.

## Sequential (series) refinement

`refinement/sequential.ts` adds the third residual topology next to
single-dataset fitting and multi-dataset co-refinement: an ordered SERIES of
datasets (temperature / pressure / composition), each refined with its own copy
of the parameters and seeded from the previous dataset's refined values — the
GSAS-II "sequential refinement" workflow. The controller is engine-level and
domain-blind (datasets supply only a `RefinementProblem` factory), so Rietveld
and PDF share it verbatim through the thin adapters in `workflow/sequential.ts`
(`powderSequentialDatasets` / `pdfSequentialDatasets`). Diverged/failed steps
are not carried into the next seed (the series reseeds from the last good
step), and the result includes a per-parameter value/esd **evolution table** —
the a(T)/moment(T) curves that are the point of a sequential study.
`seedFromPrevious: false` degrades to independent per-dataset refinements
(bit-identical to running `refine` on each, tested).

## Refinement history

Each `run` accumulates a `RefinementIteration[]` (iteration number, χ², agreement
factors). This is the audit trail the UI shows and the basis for undo. History is
part of `RefinementResult`, which is part of the saved `ProjectFile`, so a reopened
project shows how it got where it is.

## What is intentionally *not* here yet

- Analytic derivatives for the *full* crystallographic model — affine parameters
  have exact columns; occupancy/isotropic-B_iso have opt-in validated analytic
  columns, and the real-space PDF model has the fused analytic pass above
  (F1.1); powder coordinates, cell, profile, zero-shift and moments are still
  finite-difference (see [ROADMAP.md](./ROADMAP.md)).
- Symbolic constraint language — Phase 8 starts with direct tying and grouping
  via `RefinementParameter.group` / `expression`, not a full expression compiler.
- Simulated annealing / global optimization — LM is local; good starting models
  are assumed. Called out in [LIMITATIONS.md](./LIMITATIONS.md).
- Alternative *local* minimizers behind the same `RefinementProblem` seam —
  L-BFGS/L-BFGS-B and other gradient-only quasi-Newton methods for large-parameter
  or expensive-Jacobian regimes, plus structure-preserving LM upgrades (geodesic
  acceleration, trust-region step control, iterative LSMR/CG inner solves). LM
  stays primary because it yields the covariance/ESDs for free; a gradient-only
  driver would still need a final Hessian pass for uncertainties. Planned as
  ROADMAP.md F1 item 7.
