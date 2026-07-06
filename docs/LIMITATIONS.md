# Limitations

## Standing scope statement

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. It is not yet a
> replacement for GSAS-II, FullProf, Jana2020, ShelX, or other established
> crystallographic refinement suites. Results intended for publication must be
> validated against established tools and expert crystallographic judgment.

This statement appears in the app UI and the README, not only here.

## Current scope (Phase 0)

Only the architecture, data-type drafts, and project scaffold exist. **No
calculation or refinement engine is implemented yet.** Nothing here produces
scientific results at this phase.

## Known simplifications (planned, by design)

These are deliberate scope choices for early phases, to be lifted later:

- **Structure factors** use a simplified equation and a small, replaceable
  scattering-length / form-factor table before complete tables are added.
- **Displacement parameters**: isotropic (B_iso) first; anisotropic ADPs are
  typed but not yet used in calculation.
- **Space groups**: represented as an explicit list of symmetry operations
  (as parsed from CIF). No built-in 230-group table initially; no automatic
  systematic-absence generation beyond what the operation list implies.
- **Powder profiles**: Gaussian and pseudo-Voigt with a single width; polynomial
  background; March-Dollase preferred orientation. No Thompson-Cox-Hastings,
  Chebyshev background, spherical-harmonic texture, or full TOF profile yet
  (TOF↔d conversion exists, but TOF peak-shape refinement does not). This is
  *not* full Rietveld refinement. Multi-phase powder and Le Bail extraction are
  implemented.
- **Optimizer**: local Levenberg–Marquardt with a numerical Jacobian. No global
  optimization (simulated annealing, etc.); a reasonable starting model is
  assumed. Poor starting points may converge to false minima.
- **Magnetic model**: single propagation vector (k = 0 commensurate), simplified
  ⟨j0⟩ magnetic form factor and dipole structure factor. mCIF (BNS) parsing,
  axial-vector moment transformation, and **single-crystal** moment refinement
  are implemented and validated against GSAS-II moment magnitudes. Magnetic
  **powder** refinement (combined nuclear+magnetic profile) is also implemented.
  In-app candidate generation covers **k = 0 commensurate** structures only
  (parent + index-2 subgroups); it does not attach standard BNS labels or handle
  non-zero / incommensurate propagation vectors, and there is no
  representation-analysis route. Moment components in a non-orthogonal cell use
  the normalized crystal-axis convention (reproduces the GSAS-II magnitude for
  the monoclinic Mn₃Ga structure).
- **Corrections not yet modelled**: absorption, extinction, preferred
  orientation, anomalous dispersion, TOF profile complexities.

## What "not validated" means here

A feature is **validated** only when [VALIDATION.md](./VALIDATION.md) records a
test or external comparison for it. Everything else is **approximate** and must
be treated as such, regardless of how plausible the output looks.

## Non-goals

- Cloning the full feature set of GSAS-II, FullProf, Jana2020, or ShelX.
- Replacing expert crystallographic judgment.
- Serving as the sole basis for published structural or magnetic results.
