# Limitations

## Scope statement

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. Results intended
> for publication must be validated against established tools and expert
> crystallographic judgment.

This statement also appears in the app and in the README.

## How to read this page

Each area below has up to three lists:

- **Supported** — implemented and tested.
- **Approximate** — works, but with a simplification to keep in mind when you
  interpret the result.
- **Not yet** — not implemented. The order of this work is in
  [ROADMAP.md](./ROADMAP.md).

A feature counts as **validated** only when [VALIDATION.md](./VALIDATION.md)
records a test or an external comparison for it. Everything else is
approximate, however plausible its output looks.

## At a glance

| Area | Supported | Largest gaps |
| --- | --- | --- |
| [Powder](#powder-diffraction) | X-ray and neutron; constant wavelength and TOF; multi-phase; Le Bail | Spherical-harmonic texture; Kα₂ doublets; Ikeda–Carpenter TOF peak shape |
| [Single crystal](#single-crystal) | F² refinement with merging and extinction; magnetic supercell merge | Reliable `.hkl`/`.fcf` loading; twinning; absorption-correction UI |
| [Magnetic](#magnetic-structures) | One propagation vector (k = 0, commensurate or incommensurate); subgroup candidates with BNS/OG labels | Multi-k and the star of k; harmonics and superspace; refining k |
| [PDF and mPDF](#real-space-pdf-and-magnetic-pdf) | Neutron and X-ray G(r); multi-phase; magnetic PDF; Γ symmetry modes | Zone-boundary modes; a correlated-error likelihood; data reduction |
| [Uncertainty](#uncertainty-and-posterior-sampling) | Least-squares esds and correlations; posterior sampling (prototype) | Correlated residuals; comparing models |
| [Files](#input-and-output) | CIF, mCIF, project files, report, FullProf and GSAS-II cross-check bundle | Single-crystal and multi-phase `.pcr`; geometry tables in the report |

## Refinement engine

**Supported**
- Local Levenberg–Marquardt least squares with bounds, ties, restraints, esds
  and correlations ([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)).
- Exact derivatives for linear parameters: scale, background, magnetic scale.
- Protection against false minima: automatic starting values for the background
  and zero shift; seeded multi-start searches (Prefit / Escape min), including
  for magnetic moments; and, in the agent tools, a staged sequence that fixes a
  newly freed parameter again when it makes the fit degenerate.

**Approximate**
- Fits fall back to central finite differences for every non-linear parameter
  with no validated analytic column — powder coordinates, cell, profile, zero
  shift and moments among them.
- Validated analytic derivatives are used where they exist — powder occupancy
  and isotropic B; PDF Qdamp, Qbroad, δ1, δ2, particle diameter, occupancy,
  isotropic B, anisotropic U and symmetry-mode position shifts. Every serial fit
  (the worker runners and the agent tools) and the pool-parallel PDF fits take
  them; pooled powder fits do not, because a powder analytic column costs a full
  pattern synthesis on the driver thread where the fused PDF pass costs one
  traversal for all of them.

**Not yet**
- Global optimization. The engine is local, so it needs a reasonable starting
  model.

## Uncertainty and posterior sampling

**Supported**
- Least-squares esds and parameter correlations.
- Bayesian posterior sampling, as a prototype: the Posterior view on the powder
  and PDF pages, and the `sample_posterior` agent tool for PDF fits. Two
  samplers:
  - an ensemble (stretch-move) sampler, which runs on the worker pool and
    accepts any problem;
  - a gradient-based NUTS sampler, for single-phase PDF fits only.
- Four noise models: `poisson` for raw counts, `fixed` for trustworthy σ,
  `studentT` for outliers, and `marginalized` (the default) for an unknown error
  scale.

**Approximate**
- Every noise model treats residuals as independent from point to point. For
  G(r) that is not true — the finite-Qmax Fourier transform correlates
  neighbouring points — so credible intervals are relative to the chosen noise
  model, not a rigorous likelihood.
- NUTS runs in-process, one chain after another, not on the worker pool. Where
  no analytic gradient exists (cell, sratio/rcut, tied parameters, multi-phase or
  multi-dataset problems) it uses finite differences, at their cost.
- Sampling parameters that move atoms (cell, positions) rebuilds the pair list
  at every step, so it is much slower than sampling scales or envelopes. The
  Posterior view therefore runs 400 steps at a time, with a Continue button.
- `poisson` and `studentT` work with the ensemble sampler only. Do not combine
  `poisson` with restraints: restraints are Gaussian pseudo-observations.

**Not yet**
- A correlated-residual model, and a covariance propagated from the F(Q)
  reduction ([PDF roadmap §8](./PDF_MPDF_ROADMAP.md#8-scientific-caveats--honesty-statement)).
- Model evidence (for example nested sampling). A posterior compares parameter
  values within one model, not one model with another.
- A corner plot in the workbench. The Posterior view shows each parameter's
  marginal; the sample correlation matrix is in the `sample_posterior` agent-tool
  output.
- Posterior sampling of a magnetic PDF fit through the `sample_posterior` agent
  tool. The PDF page can sample one, with the ensemble sampler.

## GPU acceleration

**Supported**
- WebGPU kernels for the nuclear structure-factor sum, the magnetic
  structure-factor sum and profile synthesis.
- The powder page uses the nuclear kernel automatically when the browser
  supports WebGPU, for single-phase fits without a magnetic model. Otherwise the
  fit runs on the CPU.

**Approximate**
- The kernels compute in f32, so they agree closely with the f64 CPU path but
  not bit for bit: within 5e-7 relative for structure factors, far below esd
  scales. A GPU-accelerated refinement converges to the same minimum as the CPU
  one. The f64 CPU path stays the reference
  ([VALIDATION.md](./VALIDATION.md#gpu-acceleration-precision)).

**Not yet**
- The magnetic kernel inside magnetic refinement.

## Symmetry

**Supported**
- All 230 space groups in their standard settings, plus the operation list read
  from a CIF. Systematic absences are generated from the operations.
- Magnetic subgroup candidates carry standard BNS/OG labels from a bundled
  ISO-MAG table (types I and III). A setting search also names candidates
  written in other settings: axis permutations, origin shifts, orthohexagonal
  C-centred cells, the tetragonal-I, hexagonal-R, monoclinic-C and triclinic
  cells of an F cubic parent, and the hexagonal cell of a rhombohedral-axes or
  primitive cubic parent ([MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md)).
- Representation analysis: irreps at k = 0 for every parent group, and at any k
  when the little group is abelian.
- The little group of k, the one-arm/two-arm classification and the k-phase of
  every lattice translation use the parent's own lattice, centring translations
  included ([MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md)).

**Not yet**
- BNS/OG labels for type-II and type-IV (anti-translation) groups, for
  monoclinic cell choices 2 and 3, for the reverse rhombohedral setting, and
  for sub-cells of I- or C-centred parents.
- Projective small representations, needed for non-abelian little groups at
  k ≠ 0.
- Wyckoff letters beyond a curated set of groups. Multiplicities and site
  symmetries are available for all 230.

## Scattering tables

**Supported**
- Neutron coherent scattering lengths: 92 entries (Sears, *International Tables*
  Vol. C), with GSAS-II's values pinned for the elements used in validation.
- X-ray form factors: Cromer–Mann coefficients for 97 neutral atoms (Vol. C),
  each checked to give f(0) = Z.
- Magnetic form factors: ⟨j0⟩ for 97 ions and ⟨j2⟩ for 95 (Vol. C). The
  tables support the dipole form for g ≠ 2, but calculations use ⟨j0⟩ only
  (see [Magnetic structures](#magnetic-structures)).
- Every table is generated from its cited source by a script in `scripts/`
  ([SCATTERING_TABLES.md](./SCATTERING_TABLES.md)).

**Not yet**
- Ionic X-ray form factors (neutral atoms only).
- Magnetic form factors for the 5d ions W–Ir (Kobayashi 2011).
- Anomalous dispersion (f′, f″).

## Powder diffraction

**Supported**
- Constant-wavelength peaks: Gaussian or pseudo-Voigt, with Caglioti U/V/W
  widths, a Thompson–Cox–Hastings Lorentzian size/strain term, and
  Finger–Cox–Jephcoat axial asymmetry.
- Time-of-flight peaks: back-to-back exponential ⊗ Gaussian with d-dependent
  α/β/σ, placed by difC/difA/difB (GSAS-II convention). α/β/σ refine in the
  profile stage; difC/difA/difB start fixed at the instrument calibration,
  because they correlate strongly with the cell.
- Lorentz–polarization: neutron CW 1/(sin²θ cosθ); X-ray CW multiplied by the
  polarization factor (1−P)cos²2θ + P, with P from the instrument (0.5
  unpolarized, about 0.9–0.95 for a monochromated synchrotron beam); TOF ∝ d⁴.
  Constant per-bank prefactors are absorbed into the scale.
- Backgrounds: Chebyshev, cosine (Fourier) or power series, or linear or
  logarithmic interpolation between evenly spaced points, with an adjustable
  number of terms.
- Corrections: March–Dollase preferred orientation; sample displacement and
  transparency, Debye–Scherrer absorption, and Suortti surface roughness
  (opt-in); crystallite size (isotropic, with uniaxial in the core only) and
  microstrain (isotropic,
  uniaxial, or generalized Stephens) — see [MICROSTRUCTURE.md](./MICROSTRUCTURE.md).
- Multi-phase refinement and Le Bail extraction.
- Fit-quality plots beyond R, wR and GoF: F_obs vs F_calc, and a normal
  probability plot (Abrahams & Keve 1971). A straight line of slope 1 through
  the origin means both the model and the uncertainties are right. Overlapping
  intensity is shared across all phases, so an impurity peak on top of a
  main-phase reflection is not credited to the main phase.

**Approximate**
- Axial asymmetry is modelled on the low-angle side (2θ < 90°) only.

**Not yet**
- Spherical-harmonic texture; powder extinction; microabsorption (Brindley);
  flat-plate absorption; Kα₂ doublets.
- High-angle axial asymmetry; the Ikeda–Carpenter moderator peak shape; TOF
  absorption and extinction.
- Manually placed background points, real-space (Debye) backgrounds, and
  automatic peak stripping.

## Disorder

**Supported**
- Atoms that share one site (mixed occupancy — for example the six 3d cations
  of the high-entropy tungstate) refine with a tied position and ADP and an
  automatic Σ(occupancy) restraint, optionally constrained to exactly 1. In a
  magnetic refinement their moments can be tied too. Each tie is a toggle that
  appears when the structure has a shared site.

**Not yet**
- Split (positional) disorder; anti-site exchange between different sites;
  occupancy–ADP correlation beyond the single-site tie.

## Magnetic structures

**Supported**
- One propagation vector: k = 0, or a commensurate or incommensurate k ≠ 0,
  for constant-wavelength and TOF powder data and for single-crystal data.
- Moments refine as the symmetry-allowed modes of the chosen magnetic subgroup;
  a refinement cannot leave that space. Satellites sit at G ± k.
- The magnetic intensity shares the nuclear scale (GSAS-II convention), with
  the magnetic scattering length p = γ_n·r_e/2 = 2.695 fm/μ_B, so moment sizes
  are on a physical footing.
- When +k and −k are distinct (¼- and ⅓-type k, or incommensurate), each mode
  has a cosine and a sine amplitude, which describes sinusoidal, helical,
  cycloidal and elliptical modulations. One sine amplitude is held fixed,
  because the overall phase of the modulation cannot be observed. The moment in
  cell n is m(n) = M^cos·cos(2πk·n) + M^sin·sin(2πk·n), and the satellite
  structure factor uses ½(M^cos + i·M^sin).
- Symmetry tools: a search for k from magnetic-peak positions; the little group
  of k and its magnetic subgroups; independent sublattices where the little
  group splits an orbit; tied moments for ions sharing a site.
- Centred parent cells (A, B, C, I, F, hexagonal R) with k ≠ 0. A centring
  translation carries its phase e^{2πi k·t}: with phase −1 it is an
  anti-translation of the parent cell (MnO's type-II order from Fm-3m with
  k = ½½½), and with a complex phase k has two arms with cosine and sine
  amplitudes (k = (½,0,0) in a C cell). Single-arm satellites H ± k need H in
  the centred cell's reciprocal lattice.
- mCIF (BNS) import and export. Moment components are given along the
  normalized crystal axes.
- Checks: the cosine/sine formalism reproduces a brute-force sum over the
  magnetic supercell, for primitive and for C-, I- and F-centred parents; a
  simple antiferromagnet at k = (0, 0, ½) is recovered end to end; MnO
  (Fm-3m, k = ½½½) gives the -3m little group, m(r) = m₀·(−1)^{x+y+z} and
  F-centred satellites; at k = 0 the moment sizes match GSAS-II; and |F_M|²
  matches GSAS-II reflection by reflection on the Mn₃Ga 350 K data.

**Approximate**
- The magnetic form factor is spin-only ⟨j0⟩ everywhere: structure factors,
  the GPU kernel and magnetic PDF. The dipole correction with ⟨j2⟩, needed when
  the orbital moment matters (g ≠ 2), is not applied yet.
- Satellite multiplicities count the members of a Laue family that are ±k
  satellites in the parent's reciprocal lattice. Summed over the family, the
  single-arm |F_M|² is the powder intensity for any population of the domains
  of the star of k; the other members belong to other arms and are listed with
  no weight. Each family's |F_M|² is evaluated at one of its arm members, not
  averaged over the family.
- The k-search ranks candidates by peak positions, not intensities, and it
  proposes commensurate k only (denominators 2, 3, 4 and 6). Type an
  incommensurate k in by hand.
- An incommensurate model exports as an mCIF of the parent cell, with the cosine
  amplitudes in the moment loop and the sine amplitudes as comments — not as a
  superspace mCIF. (A commensurate k ≠ 0 exports as the magnetic supercell in its
  own magnetic space group.)

**Not yet**
- Multi-k structures, and the star of k with its domains.
- Harmonics (3k, 5k — squared-up modulations) and (3+1)D superspace symmetry.
- Refining k itself.
- Cosine/sine modes taken directly from an irrep; today they come from the
  magnetic subgroup.
- A size tie across different mode geometries when +k and −k are distinct. The
  optional equal-|M| tie then links only sublattices with the same mode
  geometry.

## Single crystal

**Supported**
- F² refinement from FullProf `.int` files and plain `h k l I σ` lists, with
  Laue-class merging (R_int, R_sigma), SHELX weights, secondary extinction
  (EXTI), R1/wR2/GooF and per-reflection outlier diagnostics
  ([SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md)).
- Commensurate magnetic structures: `_nuc` and `_mag` reflection files merged
  into the magnetic supercell and refined with one shared scale.
- The cell is fixed input, not a refined parameter — as in SHELXL.

**Approximate**
- SHELX WGHT weights are implemented, but nothing sets their a and b terms
  yet, so both the fit and the reported wR2 and GooF weight by σ only.
- The FullProf `.int` k-vector header variant has not been checked in FullProf.
  Real files use the supercell merge instead.

**Known issues**
- The page reads `.hkl` and `.fcf` files as whitespace-separated
  `h k l I σ` rows. In a SHELX HKLF 4 file, an intensity of 10000.00 or more
  fills its field and merges with the l index. In a `.fcf` file, F²(calc) is
  read as the intensity. Readers for both formats exist but are not wired into
  the page, so check the loaded reflections, or use `.int`.

**Not yet**
- Twinning (BASF); anomalous dispersion and absolute structure; iterative WGHT
  reweighting; completeness against the theoretical unique set.
- An absorption-correction UI. The correction core (neutron μ, crystal shape,
  transmission, face indexing) is validated against WinGX but has no UI.
- The supercell merge for an incommensurate or non-axis-diagonal k.

## Real-space PDF and magnetic PDF

**Supported**
- Neutron and X-ray G(r) fitting, single- or multi-phase, with element-pair
  partials, Qmax termination ripples and a spherical-particle envelope.
- Multi-dataset co-refinement (a temperature series, or joint X-ray + neutron)
  in the core only.
- Magnetic PDF, co-refined with the nuclear PDF, for single-phase neutron data
  and a commensurate k.
- Symmetry-mode (distortion) refinement with Γ modes, taken from the
  structure's own space group or from a parent structure.
- Reduced data: `.gr`, `.sq` and `.fq` (transformed to G(r) on load), and PDFgui
  `.fgr` fit files.

**Approximate**
- Fits use uniform weights, because G(r) point errors are strongly correlated
  (Toby & Billinge 2004). Rw is therefore a relative measure — a PDF Rw runs
  much higher than a Bragg wR for an equally good fit — and esds are optimistic.
- The X-ray pair weight is f(0) = Z, independent of Q, as in PDFfit2.
- δ1/δ2 and sratio/rcut are alternative correlated-motion models: free one
  family, not both (the UI warns).
- Qdamp and Qbroad are instrument constants: calibrate them on a standard, then
  hold them fixed.

Conventions are pinned in
[`knowledge/total_scattering_pdf_conventions_knowledge.md`](../knowledge/total_scattering_pdf_conventions_knowledge.md).

**Not yet**
- Zone-boundary (cell-multiplying) modes and klassengleiche subgroups: the
  distortion workflow is translationengleiche only (planned in
  [PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md),
  Track A). ADP and strain symmetry modes.
- Multi-dataset co-refinement from the UI or the agent tools.
- Magnetic PDF in the `refine_pdf_boxcar` and `sample_posterior` agent tools.
  The PDF page's Boxcar and Posterior views handle it.
- Data reduction from raw intensities: the workbench fits G(r) that another
  program has reduced.

**Known issues**
- A magnetic PDF with an incommensurate k, or a commensurate k whose
  denominator is above 12, is not rejected. The spin field is then built in the
  parent cell alone, so the magnetic G(r) is wrong.

## Input and output

**Supported: input**
- Structures: CIF and mCIF.
- Powder patterns: two- or three-column text (x y [σ]), the GSAS-II CSV export,
  ILL powder files, and GSAS standard histograms (`.gsa`, `.gss`, `.fxye`).
- Instrument files: GSAS-II `.instprm`, classic GSAS `.prm`, and FullProf `.irf`
  (including the `INSTRM=6` variant).
- Single-crystal and PDF files: see their sections above.

**Supported: output**
- The whole session as a `.materia.json` project
  ([PROJECT_FORMAT.md](./PROJECT_FORMAT.md)).
- Refined CIF with esds, and mCIF. For a commensurate k ≠ 0 the mCIF is the
  magnetic supercell in its own magnetic space group.
- An HTML refinement report (Export ▾ → Report).
- A FullProf + GSAS-II cross-check bundle: a CW or TOF `.pcr`, plus your
  original data and instrument files, unchanged.

**Approximate**
- GSAS histograms: banks in FXYE/FXY format with SLOG/RALF (TOF) or CONST (CW)
  binning are checked against real POWGEN files. STD/ESD fixed-column packing
  follows GSAS-II's reader and is covered by synthetic tests only.
- A `CONST` bank is read as constant wavelength. A rare constant-step TOF
  `CONST` bank needs its unit set by hand.

**Not yet**
- `.pcr` export for single-crystal and multi-phase refinements.
- Bond-length and angle tables in the report.
- Saving and opening projects through the agent tools.
- Saving posterior samples or the magnetic page's k-search exploration in a
  project. The applied magnetic model is saved; the exploration is re-run.

## Non-goals

- Matching every feature of established crystallographic refinement suites.
- Automating expert crystallographic judgment.
- Serving as the sole basis for published structural or magnetic results.
