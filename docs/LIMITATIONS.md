# Limitations

## Scope statement

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. Results intended
> for publication must be validated against established tools and expert
> crystallographic judgment.

This statement appears in the app UI and the README, not only here.

## Current scope

A working static app performs **atomic/nuclear structure refinement** for both
single-crystal and powder data (293 passing tests), with the scientific
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
- **Magnetic model.** Commensurate **single-k moment refinement**, k = 0 *and*
  k ≠ 0: moments refine as the symmetry-allowed modes of the chosen magnetic
  subgroup, magnetic satellites are placed at G ± k, and the magnetic intensity
  shares the nuclear histogram scale (GSAS-II convention). Works for CW and TOF
  data, validated **self-consistently** (a known simple AFM at k = (0,0,½) is
  recovered end-to-end) and, at k = 0, against GSAS-II moment magnitudes. Symmetry
  tools: a low-Q **single-k search** (ranks candidate k from magnetic-peak
  *positions*, G ± k — positions, not intensities) and enumeration of the **little
  group of k** with its **time-reversal (GF(2)) magnetic subgroups**. Co-located
  (disordered) magnetic ions can be **tied to the same moment**. mCIF (BNS)
  parsing + axial-vector transformation are implemented; moment components use the
  normalized crystal-axis convention. **Not yet validated:** the absolute moment
  magnitude in the k-formalism (a convention factor pending a GSAS-II cross-check
  — directions and relative sizes are correct). **Not done:** standard **BNS/OG
  labels**, the **star of k** (multi-arm domains / multi-k), and **representation
  (irrep) analysis**; satellite multiplicity is approximated by the parent nuclear
  multiplicity. (Roadmap M2–M4.)
- **Disorder.** Atoms sharing one crystallographic site (mixed/disordered
  occupancy, e.g. the six 3d cations of the high-entropy tungstate) refine with
  **tied position and ADP**, an automatic **Σ(occupancy) restraint** per site
  (optionally constrained to exactly **1**), and — in magnetic refinement — the
  option to **tie the moment** across the co-located ions. Each is a UI toggle
  shown when a shared site is present. Not modelled: split/positional disorder,
  anti-site swaps across *different* sites, or occupancy–ADP correlation beyond
  the single-site tie.
- **Refinement diagnostics.** Beyond R/wR/GoF, the Quality tab shows an
  **F_obs vs F_calc** plot (Rietveld-decomposed per reflection) and a **normal
  probability plot** (Abrahams & Keve 1971): a straight, slope-1, intercept-0 line
  indicates a correct model *and* correctly-estimated uncertainties.
- **Corrections modelled:** March–Dollase preferred orientation, Debye–Scherrer
  cylinder absorption. **Not modelled:** extinction, spherical-harmonic texture,
  flat-plate/other absorption geometries, anomalous dispersion, microabsorption.
- **Input formats.** Powder patterns load from two-/three-column `x y [σ]` text,
  the GSAS-II CSV export, and the **GSAS standard powder histogram** (`.gsa` /
  `.gss` / `.fxye`: title + `BANK` record). For the histogram, `FXYE`/`FXY`
  (explicit abscissa) with `SLOG`/`RALF` (TOF µs) and `CONST` (CW 2θ, centidegrees
  ÷ 100) binning are validated against real POWGEN files; `STD`/`ESD` fixed-column
  packing follows GSAS-II's reader and is covered by synthetic tests only. A
  `CONST` bank is assumed constant-wavelength (the common case) — a rare
  constant-µs-step TOF `CONST` bank would need an explicit unit override.
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
