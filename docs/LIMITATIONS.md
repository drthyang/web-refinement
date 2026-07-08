# Limitations

## Scope statement

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. Results intended
> for publication must be validated against established tools and expert
> crystallographic judgment.

This statement appears in the app UI and the README, not only here.

## Current scope

A working static app performs **atomic/nuclear structure refinement** for both
single-crystal and powder data (269 passing tests), with the scientific
foundations for magnetic refinement in place. The Levenberg–Marquardt engine,
symmetry-adapted constrained parameters, Chebyshev / cosine / power-series
backgrounds, Caglioti profile, Le Bail extraction, multi-phase powder, and
**k = 0** magnetic refinement + space-group candidate generation are implemented
and tested. The remaining work and its ordering are in [ROADMAP.md](./ROADMAP.md).

Everything below is a **deliberate, still-standing simplification**, not an
accidental gap — each is tracked as a roadmap item.

## Known simplifications (by design)

- **Optimizer.** Local Levenberg–Marquardt with a **numerical (finite-difference)
  Jacobian** for all non-linear parameters; only linear parameters (scale,
  background, magnetic scale) have exact columns. No analytic crystallographic
  derivatives yet and no global optimization — a reasonable starting model is
  assumed, and poor starting points can converge to false minima. (Roadmap F1.)
- **Space groups.** Represented as the **explicit operation list parsed from the
  CIF** — no built-in 230-group tables, Wyckoff lookup, or automatic
  systematic-absence generation. Symmetry constraints are therefore only as
  complete as the supplied operation list. (Roadmap F2.)
- **Structure factors** use compact, replaceable scattering tables centralized in
  [`scattering/`](../src/core/scattering/) — tabulated neutron lengths
  (52 elements) and Cromer–Mann X-ray (14 elements), both intentionally partial
  (loading an element outside the table is a known gap, not a silent error), plus
  the **full ITC-C magnetic form-factor table** (⟨j0⟩ for 97 ions, ⟨j2⟩ for 95),
  so both spin-only and dipole (`g ≠ 2`) magnetic form factors are available. Not
  yet included: the 5d W–Ir ions (Kobayashi 2011), and an end-to-end GSAS-II
  |F_mag|² cross-check. See [SCATTERING_TABLES.md](./SCATTERING_TABLES.md). (Roadmap M4.)
- **Backgrounds.** Chebyshev polynomial, cosine (Fourier) series, and power
  series, selectable per pattern with an adjustable term count. Not modelled:
  fixed-point/manual background, debye/real-space, or automatic peak-stripping.
- **Powder profiles.** Constant-wavelength: Gaussian / pseudo-Voigt with Caglioti
  U/V/W width, a Thompson–Cox–Hastings Lorentzian size–strain term, and Finger–
  Cox–Jephcoat axial asymmetry. Time-of-flight: a back-to-
  back-exponential ⊗ Gaussian peak shape with d-dependent α/β/σ, placed by the
  difC/difA/difB constants (GSAS-II convention) and the d⁴ TOF Lorentz factor.
  The TOF **α/β/σ coefficients refine** in the profile stage; difC is held at the
  instrument calibration. Not yet modelled: the Ikeda–Carpenter moderator shape
  and TOF absorption/extinction.
- **Magnetic model.** Moment **refinement** is **commensurate k = 0** (single-
  crystal + powder, validated against GSAS-II magnitudes); mCIF (BNS) parsing and
  axial-vector moment transformation are implemented. Beyond k = 0, two symmetry
  tools now exist: a **commensurate single-k search** that ranks candidate
  propagation vectors from magnetic-peak *positions* (G ± k scoring — position
  only, not intensities), and enumeration of the **little group of k** with its
  **time-reversal (GF(2)) magnetic subgroups** for any commensurate k. Still
  **not** done: magnetic *refinement* at k ≠ 0, standard **BNS/OG labels**, the
  **star of k** (multi-arm domains), and **representation (irrep) analysis** — so
  a k ≠ 0 candidate is a symmetry *starting point*, not yet a refinable model.
  (Roadmap M2–M4.) Moment components in a non-orthogonal cell use the normalized
  crystal-axis convention (reproduces the GSAS-II magnitude for monoclinic Mn₃Ga).
- **Disorder.** Atoms sharing one crystallographic site (mixed/disordered
  occupancy, e.g. the six 3d cations of the high-entropy tungstate) refine with
  **tied position and ADP** and an automatic **Σ(occupancy) restraint** per site,
  so the mixing ratio refines while the total site occupancy is held. Not
  modelled: split/positional disorder, anti-site swaps across *different* sites,
  or occupancy–ADP correlation beyond the single-site tie.
- **Corrections modelled:** March–Dollase preferred orientation, Debye–Scherrer
  cylinder absorption. **Not modelled:** extinction, spherical-harmonic texture,
  flat-plate/other absorption geometries, anomalous dispersion, microabsorption.
- **Output.** Reproducible project JSON with history. **No refined CIF/mCIF
  export, atom table with esds, or report generation yet.** (Roadmap M5.)

## What "not validated" means here

A feature is **validated** only when [VALIDATION.md](./VALIDATION.md) records a
test or external comparison for it. Everything else is **approximate** and must
be treated as such, regardless of how plausible the output looks.

## Non-goals

- Matching every feature of established crystallographic refinement suites.
- Automating expert crystallographic judgment.
- Serving as the sole basis for published structural or magnetic results.
