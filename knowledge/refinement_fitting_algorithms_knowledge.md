# Refinement Fitting Algorithms Knowledge Base

Purpose: guide implementation of fast, stable fitting algorithms for atomic and magnetic structure refinement in a browser/WebGPU-capable refinement package.

This document is inspired by established crystallographic refinement practice in
programs such as GSAS-II, FullProf, and Jana2020. Do not copy their internal
implementation. Implement the general numerical and crystallographic principles
in a clean, independent codebase.

---

## 1. Core Principle

Do **not** use a generic black-box optimizer as the main refinement engine.

Use **weighted nonlinear least squares** as the primary refinement method:

```text
minimize χ²(p) = Σ_i w_i [y_obs(i) - y_calc(i, p)]²
```

Recommended refinement loop:

```text
1. Build y_calc.
2. Build residual r = y_obs - y_calc.
3. Build Jacobian J = ∂y_calc / ∂p.
4. Solve a damped least-squares step.
5. Apply constraints, bounds, and parameter damping.
6. Accept or reject the trial step based on χ² improvement.
7. Repeat until convergence.
```

The fitting engine should be fast because it avoids unnecessary recomputation, stable because it controls parameter correlations, and scientific because it refines physically meaningful parameters.

---

## 2. Required Solver Stack

Implement the solver stack in this order:

```text
Priority 1: Levenberg-Marquardt weighted least squares
Priority 2: SVD / truncated-SVD singularity handling
Priority 3: parameter damping / relaxation factor
Priority 4: finite-difference fallback for parameters without analytic derivatives
Priority 5: automated staged refinement controller
Priority 6: optional global search only for starting models
```

Do not let poorly conditioned parameters destabilize the refinement. If singular values are too small, suppress those directions instead of directly inverting them.

---

## 3. Weighted Least-Squares Update

Use weighted residuals:

```text
r_w = sqrt(w) * (y_obs - y_calc)
J_w = sqrt(w) * J
```

Levenberg-Marquardt step:

```text
(J_wᵀ J_w + λ diag(J_wᵀ J_w)) Δp = J_wᵀ r_w
```

Trial update:

```text
p_trial = p_current + relaxation_factor * Δp
```

Recommended control logic:

```text
if χ²(p_trial) improves:
    accept step
    decrease λ
else:
    reject step
    increase λ
```

The relaxation factor should be configurable. It is useful when parameters are strongly correlated or the starting model is poor.

---

## 4. SVD and Singularity Handling

For ill-conditioned systems, use SVD:

```text
J_w = U S Vᵀ
```

Discard unstable directions when:

```text
S_k / S_max < svd_tolerance
```

Suggested default values:

```text
svd_tolerance = 1e-6       # normal powder refinement
svd_tolerance = 1e-4–1e-3  # unstable or highly correlated refinements
```

Always report:

```text
- condition number
- discarded singular directions
- parameters contributing strongly to discarded directions
```

This is essential for diagnosing parameter correlation and refinement instability.

---

## 5. Powder Diffraction Model

For powder Rietveld refinement:

```text
y_calc(i) = background(i) + Σ_phase Σ_hkl contribution(i, hkl, phase)
```

Each reflection contribution should include:

```text
- scale factor
- multiplicity
- structure factor |F_hkl|²
- Lorentz / polarization / instrument corrections, where relevant
- preferred orientation / absorption / extinction, where relevant
- profile function P(x_i - x_hkl)
```

For magnetic refinement, keep nuclear and magnetic contributions modular:

```text
y_calc = y_background + y_nuclear + y_magnetic + optional_cross_terms
```

The magnetic structure factor and magnetic form factor should be handled separately from the nuclear structure factor.

---

## 6. Main Speed Strategy: Cache Everything Possible

Do not recompute quantities that have not changed.

Cache:

```text
- hkl lists
- multiplicities
- symmetry operators
- scattering lengths / atomic form factors
- magnetic form factors
- reflection-to-profile-point windows
- background basis functions
- profile basis tables
- phase-factor components when possible
- fixed instrument resolution terms
```

Use dependency-based cache invalidation:

```text
if lattice changes:
    update d-spacings, peak positions, reflection windows

if atomic positions change:
    update structure factors

if profile parameters change:
    update peak profile values and affected Jacobian columns

if only scale changes:
    reuse almost everything
```

This is one of the most important speed improvements.

---

## 7. Reflection-Window Calculation

Never loop every reflection over every data point.

For each reflection:

```text
1. Compute peak center.
2. Compute FWHM / profile width.
3. Select nearby data points only:
   x in [x_peak - n * FWHM, x_peak + n * FWHM]
4. Add contribution only inside that local window.
```

Suggested default:

```text
n = 6 to 10
```

Make `n` configurable because Lorentzian-heavy peaks have longer tails.

This changes the computation from dense global summation to sparse local accumulation.

---

## 8. Derivatives

Use analytic derivatives where practical.

High-priority analytic derivatives:

```text
- scale factors
- background coefficients
- zero shift
- lattice parameters
- profile width parameters
- peak-shape parameters
- atomic coordinates
- occupancies
- isotropic ADPs
- magnetic moment components
- magnetic mode amplitudes
```

Use finite differences only as fallback or validation:

```text
∂y/∂p ≈ [y(p + δ) - y(p - δ)] / (2δ)
```

Rules for finite differences:

```text
- use parameter-specific δ
- avoid one global δ for all parameters
- use central difference when possible
- validate analytic derivatives against finite differences
```

Do not claim analytic derivatives exist for every possible parameter. Some complex corrections may require finite-difference fallback.

---

## 9. Constraint System

Implement constraints through a reduced parameter vector.

Bad design:

```text
refine every raw parameter independently, then patch constraints afterward
```

Good design:

```text
raw_parameters = transform(free_parameters)
```

Examples of hard constraints:

```text
- shared occupancy
- shared Uiso
- fixed total composition
- symmetry-equivalent atomic positions
- magnetic moment basis-vector amplitudes
- rigid-body translations / rotations
```

Hard constraints reduce the number of refined parameters and improve stability.

---

## 10. Restraints

Soft restraints should be treated as additional residuals:

```text
r_restraint = (target - model_value) / sigma
```

Append them to the least-squares residual vector.

Useful restraints:

```text
- bond distances
- bond angles
- magnetic moment magnitudes
- chemical occupancy priors
- ADP smoothness or positivity
```

Do not use restraints to hide an incorrect structural model.

---

## 11. Staged Refinement Controller

Do not refine everything at once.

Recommended default sequence:

```text
1. scale
2. background
3. zero shift / sample displacement
4. lattice parameters
5. profile width / asymmetry
6. phase fraction / scale per phase
7. preferred orientation / absorption, if needed
8. atomic coordinates
9. ADPs
10. occupancies
11. magnetic scale / magnetic peak profile, if separate
12. magnetic moment amplitudes or symmetry modes
13. magnetic propagation vector, only if justified
```

After each stage:

```text
- run refinement
- check χ² decrease
- check parameter shifts / estimated standard deviations
- check correlation matrix
- reject unstable parameter additions
```

Parameter staging is not optional for robust refinement.

---

## 12. Automated Parameter Selection

Implement an optional diagnostic that suggests the next parameter group.

Algorithm:

```text
for each inactive candidate parameter or parameter group:
    perturb by +δ and -δ
    evaluate residual sensitivity
    estimate expected χ² improvement
rank candidates
suggest next parameter group
```

This should guide staged refinement while keeping crystallographic judgment in
the loop.

---

## 13. Le Bail / Profile Matching Mode

Implement profile matching before full structural refinement.

Use when:

```text
- cell/profile/background are uncertain
- the structural model is incomplete
- magnetic peaks need to be isolated
- peak positions and widths must be stabilized first
```

Profile matching should refine:

```text
- background
- zero shift / displacement
- lattice parameters
- profile parameters
- individual or grouped reflection intensities
```

Then transfer stable cell/profile/background parameters into Rietveld refinement.

---

## 14. Magnetic Refinement

Do not refine arbitrary atom-by-atom moments as the default.

Preferred magnetic parameterization:

```text
1. define propagation vector k
2. generate magnetic symmetry / irrep basis
3. express moments as basis-mode amplitudes
4. refine only allowed amplitudes
```

Bad default:

```text
Mx, My, Mz for every magnetic atom independently
```

Good default:

```text
moment_structure = Σ_j A_j * magnetic_basis_vector_j
refine A_j
```

This reduces dimensionality and improves physical interpretability.

---

## 15. Global Search

Use Monte Carlo or simulated annealing only for starting models, not routine final refinement.

Appropriate cases:

```text
- unknown magnetic arrangement
- poor initial atomic model
- multiple local minima
- basis-vector phase/sign ambiguity
```

Workflow:

```text
1. generate candidate models with global search
2. rank by χ² / R-factor
3. refine best candidates with least squares
4. compare final residuals and physical plausibility
```

Never use global search as a substitute for a stable least-squares engine.

---

## 16. Diagnostics to Implement

Always report:

```text
- Rwp
- χ² / reduced χ²
- parameter shifts / estimated standard deviations
- correlation matrix
- largest parameter correlations
- SVD discarded directions
- condition number
- active parameter count
- restraint contribution to χ²
- peak-position residuals
- profile-width residuals
- intensity residuals
```

Flag dangerous correlations:

```text
- scale ↔ occupancy
- occupancy ↔ Uiso
- lattice ↔ zero shift
- size ↔ strain
- background ↔ weak broad peaks
- magnetic scale ↔ moment size
- preferred orientation ↔ site occupancy
```

A lower Rwp does not automatically mean the structure is correct.

---

## 17. Browser / WebGPU Implementation Notes

Build CPU correctness first. Then accelerate expensive vector operations.

Good WebGPU targets:

```text
- profile evaluation
- reflection-window accumulation
- structure-factor sums
- Jacobian column evaluation
- batched finite-difference calculations
- multi-pattern residual evaluation
```

Keep numerical linear algebra stable:

```text
- prefer Float64 on CPU for least-squares solving when possible
- use Float32/WebGPU mainly for y_calc and J construction if validated
- compare GPU and CPU residuals regularly
- add deterministic regression tests
```

Browser refinement should prioritize correctness and reproducibility over raw speed.

---

## 18. Acceptance Tests

Required tests before trusting the engine:

```text
1. Synthetic single Gaussian peak:
   recover position, width, scale, and background.

2. Synthetic powder pattern with known cell:
   recover lattice parameters and zero shift.

3. Fixed-structure test:
   refine only scale/background/profile.

4. Atomic-coordinate test:
   recover a known displaced atom.

5. Occupancy/Uiso correlation test:
   verify warning is triggered.

6. Magnetic basis test:
   recover known magnetic mode amplitude.

7. SVD singularity test:
   duplicate parameters should be detected and suppressed.

8. CPU vs GPU y_calc agreement test.

9. Finite-difference vs analytic-Jacobian agreement test.

10. Staged-refinement regression test:
    known CIF + simulated pattern should converge reproducibly.
```

---

## 19. Implementation Priority

Build in this order:

```text
1. weighted residual engine
2. cached y_calc engine
3. local reflection-window profile calculation
4. Levenberg-Marquardt least-squares solver
5. SVD singularity handling
6. constraint transform layer
7. finite-difference Jacobian fallback
8. analytic derivatives for common parameters
9. staged refinement controller
10. Le Bail / profile matching
11. magnetic symmetry-mode parameterization
12. optional Monte Carlo / simulated annealing starting-model search
```

---

## 20. Non-Negotiable Design Rules

```text
Never refine all parameters by default.
Never ignore parameter correlations.
Never hide divergence by over-damping forever.
Never treat lower Rwp as proof of a correct structure.
Never refine occupancies and ADPs freely without chemical justification.
Never refine magnetic moments without checking allowed magnetic symmetry.
Never use global search as a substitute for least-squares refinement.
```

---

## 21. Practical Target

A good refinement engine should be:

```text
fast because it caches physics
stable because it uses staged least squares
robust because it handles singularities
scientific because it refines symmetry-allowed parameters
transparent because it reports correlations and failure modes
```

Main architectural decision:

```text
Build a constrained weighted nonlinear least-squares engine first.
Everything else should plug into that engine.
```
