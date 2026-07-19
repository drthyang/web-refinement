# Limitations

## Scope statement

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. Results intended
> for publication must be validated against established tools and expert
> crystallographic judgment.

This statement appears in the app UI and the README, not only here.

## Current scope

A working static app performs **atomic/nuclear structure refinement** for
single-crystal and powder data, **commensurate single-k magnetic refinement**
(k = 0 and k ≠ 0), and **real-space PDF fitting** (1072 passing tests). The
Levenberg–Marquardt engine, symmetry-adapted constrained parameters,
Chebyshev / cosine / power-series backgrounds, CW + TOF profiles, Le Bail
extraction, multi-phase powder, magnetic space-group candidate generation, the
single-crystal F² workbench, and the PDF track (with its symmetry-mode
distortion workflow) are implemented and tested. The remaining work and its
ordering are in [ROADMAP.md](./ROADMAP.md).

Everything below is a **deliberate, still-standing simplification**, not an
accidental gap — each is tracked as a roadmap item.

## Known simplifications (by design)

- **Optimizer.** Local Levenberg–Marquardt. Linear parameters (scale, background,
  magnetic scale) get exact columns; non-linear parameters use a **central
  finite-difference Jacobian by default**, with **opt-in analytic derivatives for
  occupancy and isotropic B_iso** (validated against FD; other kinds are still FD
  — roadmap F1.1). No global optimization, so a reasonable starting model is
  assumed — but auto-background + zero-shift starting values (F1.3) and a staged
  controller that re-fixes degenerate/harmful parameter additions (F1.4) reduce
  the false-minimum risk. (Roadmap F1.)
- **GPU acceleration (optional, approximate).** WebGPU kernels can accelerate the
  structure-factor sum (nuclear and magnetic) and profile synthesis. They compute
  in **f32 and are APPROXIMATE — not bit-identical** to the CPU f64 path: validated
  on hardware to ≤5e-7 relative for structure factors (far below esd scales), and
  a GPU-accelerated refinement converges to the *same minimum* as the CPU pool.
  They are **opt-in**; the exact f64 CPU path is the default and the reference.
  See [VALIDATION.md](./VALIDATION.md#gpu-acceleration-precision).
- **Space groups.** All **230 built-in space-group tables** (standard ITA
  settings) plus the explicit operation list parsed from the CIF; systematic
  absences are generated from the operations. Magnetic groups carry standard
  **BNS/OG labels** from a bundled ISO-MAG table (types I/III, standard
  settings) — type-IV (anti-translation) label lookup and non-standard settings
  are incomplete. Klassengleiche (cell-multiplying) subgroups are not
  enumerated in the distortion workflow — translationengleiche only.
- **Structure factors** use replaceable scattering tables centralized in
  [`scattering/`](../src/core/scattering/), all now spanning the periodic table:
  neutron bound coherent lengths (**92 entries**, Sears/ITC-C, GSAS-II values
  pinned for the validation elements), Cromer–Mann X-ray form factors (**97
  neutral atoms**, ITC-C Vol. C, each verified `f(0)=Z`), and the **full ITC-C
  magnetic form-factor table** (⟨j0⟩ for 97 ions, ⟨j2⟩ for 95), so both
  spin-only and dipole (`g ≠ 2`) magnetic form factors are available. All three
  are generated from cited sources (`scripts/gen_*.py`). The end-to-end
  GSAS-II |F_mag|² cross-check passes per-reflection on the Mn₃Ga 350 K data
  (`mn3ga350KGolden.test.ts`). Not yet included: ionic X-ray form factors (only
  neutral atoms) and the 5d W–Ir magnetic ions (Kobayashi 2011). See
  [SCATTERING_TABLES.md](./SCATTERING_TABLES.md).
- **Backgrounds.** Chebyshev polynomial, cosine (Fourier) series, and power
  series, selectable per pattern with an adjustable term count. Not modelled:
  fixed-point/manual background, debye/real-space, or automatic peak-stripping.
- **Powder profiles.** Constant-wavelength: Gaussian / pseudo-Voigt with Caglioti
  U/V/W width, a Thompson–Cox–Hastings Lorentzian size–strain term, and Finger–
  Cox–Jephcoat axial asymmetry (modelled for the low-angle tail, 2θ < 90°; the
  high-angle asymmetry is not modelled). Time-of-flight: a back-to-
  back-exponential ⊗ Gaussian peak shape with d-dependent α/β/σ, placed by the
  difC/difA/difB constants (GSAS-II convention) and the d⁴ TOF Lorentz factor.
  The TOF **α/β/σ coefficients refine** in the profile stage; difC is held at the
  instrument calibration. Not yet modelled: the Ikeda–Carpenter moderator shape
  and TOF absorption/extinction.
- **Lorentz–polarization.** Neutron CW 1/(sin²θ cosθ); X-ray CW multiplies the
  polarization factor (1−P)cos²2θ + P with the instrument's polarization fraction
  P (P = 0.5 unpolarized, ~0.9–0.95 monochromated synchrotron); TOF ∝ d⁴. The
  per-detector-bank constant prefactors are absorbed into the refined scale.
- **Magnetic model.** Commensurate **single-k moment refinement**, k = 0 *and*
  k ≠ 0: moments refine as the symmetry-allowed modes of the chosen magnetic
  subgroup, magnetic satellites are placed at G ± k, and the magnetic intensity
  shares the nuclear histogram scale (GSAS-II convention). Works for CW and TOF
  data, validated **self-consistently** (a known simple AFM at k = (0,0,½) is
  recovered end-to-end) and, at k = 0, against GSAS-II moment magnitudes. Symmetry
  tools: a low-Q **single-k search** (ranks candidate k from magnetic-peak
  *positions*, G ± k — positions, not intensities) and enumeration of the **little
  group of k** with its **time-reversal (GF(2)) magnetic subgroups**; when the
  little group **splits a site's crystallographic orbit**, each split orbit
  refines as an independent sublattice (own allowed-moment basis and
  amplitudes). Co-located
  (disordered) magnetic ions can be **tied to the same moment**. mCIF (BNS)
  parsing **and export** + axial-vector transformation are implemented; moment
  components use the normalized crystal-axis convention. The magnetic scattering length is
  p = γ_n·r_e/2 = **2.695 fm/μ_B** (fm to match the nuclear b scale), so moment
  magnitudes are on a physical footing; |F_M|² is cross-checked per-reflection
  against GSAS-II on the Mn₃Ga 350 K data. Candidates carry standard
  **BNS/OG labels** (bundled ISO-MAG table; types I/III, standard settings).
  **Not done:** the **star of k** (multi-arm domains / multi-k) and full
  **representation (irrep) analysis**; satellite multiplicity is approximated by the parent nuclear
  multiplicity. (Roadmap M2–M4.)
- **Real-space PDF.** `G(r)` fitting uses **uniform weights** — reduced-PDF
  point errors are strongly correlated (Toby & Billinge 2004), so Rw is a
  relative indicator, not an absolute one; PDF Rw runs much higher than Bragg
  wR for equally good fits. δ1/δ2 and sratio/rcut are **mutually exclusive**
  correlated-motion families (the UI warns when both are freed). Qdamp/Qbroad
  are instrument constants — calibrate on a standard and hold. The distortion
  workflow enumerates **Γ (cell-preserving) modes only**; zone-boundary
  (cell-multiplying) modes and ADP/strain symmetry modes are future work.
  Conventions are pinned in
  [`knowledge/total_scattering_pdf_conventions_knowledge.md`](../knowledge/total_scattering_pdf_conventions_knowledge.md).
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
  indicates a correct model *and* correctly-estimated uncertainties. The F_obs/F_calc
  decomposition is multi-phase aware — every phase's peaks share the apportionment,
  so an impurity peak overlapping a main-phase reflection is not miscredited to it,
  and each phase's reflections are colored to match its Bragg-tick row.
- **Corrections modelled (powder):** March–Dollase preferred orientation;
  sample displacement / transparency, Debye–Scherrer absorption, and Suortti
  surface roughness via an opt-in correction registry; isotropic **and**
  anisotropic microstructure — Scherrer size, uniaxial size, and
  isotropic / uniaxial / generalized **Stephens** microstrain (see
  [MICROSTRUCTURE.md](./MICROSTRUCTURE.md)). **Not modelled:**
  spherical-harmonic texture, powder extinction, anomalous dispersion,
  microabsorption (Brindley), Kα₂ doublets.
- **Single crystal.** The F² workbench is live: `.hkl`/`.fcf`/`.int` loaders,
  Laue-class merging (R_int/R_sigma), SHELX-convention weights and
  secondary-extinction (EXTI) correction, R1/wR2/GooF, and outlier diagnostics
  (see [SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md)). The absorption-correction
  core is validated against WinGX but has no UI yet. **Not modelled:** twinning
  (BASF), anomalous dispersion / absolute structure, iterative WGHT
  reweighting. (Roadmap M7 remainder.)
- **Input formats.** Powder patterns load from two-/three-column `x y [σ]` text,
  the GSAS-II CSV export, and the **GSAS standard powder histogram** (`.gsa` /
  `.gss` / `.fxye`: title + `BANK` record). For the histogram, `FXYE`/`FXY`
  (explicit abscissa) with `SLOG`/`RALF` (TOF µs) and `CONST` (CW 2θ, centidegrees
  ÷ 100) binning are validated against real POWGEN files; `STD`/`ESD` fixed-column
  packing follows GSAS-II's reader and is covered by synthetic tests only. A
  `CONST` bank is assumed constant-wavelength (the common case) — a rare
  constant-µs-step TOF `CONST` bank would need an explicit unit override.
- **Output.** Reproducible project JSON with history; refined **CIF export with
  esds** and **mCIF export** (k ≠ 0 writes the magnetic supercell); markdown
  reports; a one-click **FullProf + GSAS-II cross-check bundle** (CW + TOF
  `.pcr` with the original data/instrument files verbatim). **Not yet:**
  single-crystal and multi-phase `.pcr` export; geometry tables in the report.
  (Roadmap M5 remainder.)

## What "not validated" means here

A feature is **validated** only when [VALIDATION.md](./VALIDATION.md) records a
test or external comparison for it. Everything else is **approximate** and must
be treated as such, regardless of how plausible the output looks.

## Non-goals

- Matching every feature of established crystallographic refinement suites.
- Automating expert crystallographic judgment.
- Serving as the sole basis for published structural or magnetic results.
