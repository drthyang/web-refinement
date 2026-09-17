# PDF & mPDF Roadmap

This page is the plan and design record for pair distribution function (PDF)
and magnetic PDF (mPDF) fitting. The target is the capability of PDFgui /
DiffPy-CMI (PDFfit2) and `diffpy.mpdf`, built on the pure-TypeScript core. What
works and what is missing is in
[LIMITATIONS.md](./LIMITATIONS.md#real-space-pdf-and-magnetic-pdf).

Status legend: ✅ done · 🚧 in progress · ⬜ not started · 🔬 needs external validation

Equations follow the primary sources in §9. Conventions are pinned in
[`total_scattering_pdf_conventions_knowledge.md`](../knowledge/total_scattering_pdf_conventions_knowledge.md).

---

## 1. Vision

A PDF refinement is a least-squares fit of a periodic small-box model to an
observed reduced PDF, G(r). The Levenberg–Marquardt (LM) engine solves the same
problem for Bragg data, so PDF follows the project principle: one engine, many
workflows (§2). The one large new subsystem is the real-space forward model,
which turns a structure or a spin configuration into G_calc(r).

Correctness comes first. The f64 CPU calculator is the reference, and nothing
counts as validated until a golden test or an external cross-check records it.

MATERIA's magnetic symmetry engine (k-search, magnetic subgroups, allowed-moment
bases) produces exactly the spin-model inputs of `diffpy.mpdf`. A
symmetry-constrained local magnetic model is therefore a natural differentiator
(requirement 4 in §3).

---

## 2. What was reused, extended and built

**The single reuse seam.** A PDF fit is a `RefinementProblem`:

```ts
{ parameters,
  observations: Float64Array,        // G_obs(r) on the r grid
  weights:      Float64Array,        // uniform (§8)
  calculate(values): Float64Array }  // G_calc(r) on the same grid
```

`refine`, `refineParallel`, `refineStaged` and `refineMultiStart` run PDF and
mPDF fits with no PDF-specific change. The single-phase PDF problem also supplies
analytic Jacobian columns and `gradChi2`; the mPDF problem supplies neither
([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)).

| Layer | Reused | Extended | Built new |
| --- | --- | --- | --- |
| Engine | LM driver, staged controller, multi-start, covariance, sequential controller | linear kinds `pdfScale`, `mpdfOrdScale`, `mpdfParaScale`; an async sequential runner | samplers in `refinement/bayes/` |
| Parameter kinds | parameters, bindings, ties | PDF: `pdfScale`, `qdamp`, `qbroad`, `delta1`, `delta2`, `spdiameter`, `sratio`, `rcut`. mPDF: `mpdfOrdScale`, `mpdfParaScale`, `mpdfPsigma`, `corrLength` | — |
| Workflow | the problem-builder template; `buildStructureRefinement` | `applyParameters` routes the new kinds | `pdf.ts`, `mpdf.ts`, `pdfBoxcar.ts` |
| Model and tables | neutron b, X-ray f(0) = Z, ⟨j0⟩, `expandStructureAtoms`, subgroup candidates, allowed moments | `expandSpinField` | `pdf/`, `totalscattering/`, `magnetic/mpdf.ts`, `math/fft.ts` |
| Input and output | CIF and mCIF parsers, format detection, project file | a PDF branch in detection; a `pdf` workspace in schema v2 | `pdfData.ts`, `fgrData.ts` |
| Workers and tools | evaluator pools, tool registry | `pdf` and `mpdf` evaluator specs | the PDF and mPDF tools (§4) |
| UI | `ParameterPanel`, `StructureView`, the magnetic symmetry panel | a signed-y plot; a real-space fit backend | `PdfWorkbench.tsx`, Posterior and Boxcar panels |

The pair enumerator is new. `bondLengths` in `crystal/geometry.ts` dedups
near-equal bonds and tiles only ±1 cell, so it must not feed a pair sum.

---

## 3. Answers to the six requirements

### (1) X-ray and neutron sources, and the scattering tables

- **Neutron.** b does not depend on Q, as the real-space pair weight
  b_i·b_j/⟨b⟩² requires, so the neutron table serves unchanged.
- **X-ray model.** The pair sum uses the Q-independent weight Z_i·Z_j/⟨Z⟩², with
  Z = f(0), as PDFfit2 does. The full f(Q) would double-count the form-factor
  fall-off that the data carry, so X-ray modelling needs no new table.
- **X-ray reduction.** Normalizing raw intensity out to a synchrotron Qmax of
  25–35 Å⁻¹ needs the Waasmaier–Kirfel f(Q), valid to Q ≈ 75 Å⁻¹. Cromer–Mann
  fits reach only Q ≈ 25 Å⁻¹. That table belongs to Track PR (§5).
- **Later, if needed:** ionic form factors, anomalous f′ and f″, Compton tables,
  and isotope-resolved b beyond deuterium.

### (2) One optimizer for every refinement

The LM engine, staged controller and multi-start are data-agnostic. `pdfScale`
is linear, so its Jacobian column is exact. Bounds, SVD truncation and the
correlation diagnostics carry over. With correlated G(r) errors, though, esds
and GoF are only relative measures (§8).

### (3) Shared UI and reused engines

`ParameterPanel` shows PDF parameters through its category map, and
`WorkbenchPlot` provides the draggable r window. Its signed-y mode keeps the
negative lobes of G(r). `PdfWorkbench.tsx` follows the powder page's layout with
its own session state.

### (4) Magnetic symmetry constrains the local spin model

- **Small-box, symmetry-constrained (this requirement).** `diffpy.mpdf` builds
  spins from k and symmetry-allowed basis vectors, then refines their amplitudes.
  MATERIA's subgroups and allowed-moment bases supply those inputs. The free
  parameters are the allowed amplitudes, a correlation length and scales (P5).
- **Big-box reverse Monte Carlo** (SPINVERT, RMCProfile). It moves thousands of
  unconstrained spins, which suits frustrated and paramagnetic diffuse
  scattering. It is out of scope (§5).

The ordered structure that the Bragg engine refines is also a valid mPDF input.
P4 fits it; P5 adds local, short-range freedom.

### (5) Browser- and agent-native

The pair sum runs in f64 in a Web Worker, with the Jacobian on the evaluator pool
(§6). Each capability is one agent tool over one pure core function, so the UI
and an agent drive the same code. PDF-aware assessment and next-step suggestions
are missing (P6).

### (6) What the feature list missed

| # | Scope | Decision | Status |
| --- | --- | --- | --- |
| 1 | Data reduction, the work of PDFgetX3 and PDFgetN | Consume reduced G(r); defer reduction to Track PR | ✅ import · ⬜ reduction |
| 2 | Correlated G(r) errors | Uniform weights; relative esds; count points on the Nyquist grid Δr = π/Qmax | ✅ weights · ⬜ Nyquist |
| 3 | Qmax termination ripples, distinct from Qdamp | Model both; extend the grid by 6·(2π/Qmax) before trimming | ✅ |
| 4 | Qdamp and Qbroad are instrument constants | Calibrate on a standard (Ni, Si, LaB₆), then fix | ✅ |
| 5 | δ1/δ2 and sratio/rcut model the same motion; δ1 and δ2 correlate strongly | Free one family, usually one δ | ✅ warns |
| 6 | Finite particle size | Sphere envelope; a Debye sum for clusters, where the periodic sum fails at large r | ✅ sphere · ⬜ Debye |
| 7 | Element-pair partial PDFs | Decompose the pair sum | ✅ |
| 8 | Multi-phase and multi-dataset co-refinement | One concatenated residual | ✅ phases · 🚧 datasets, core only |
| 9 | Incommensurate mPDF | The Fourier-coefficient route (`fourierMoment.ts`) | ⬜ |
| 10 | Uncertainty beyond esds | Posterior sampling (P6) | ✅ |

---

## 4. Module layout

Paths are under `src/`. Nothing in `src/core` imports React.

| Module | Role |
| --- | --- |
| `core/pdf/pairEnumerator.ts` | Atom pairs within rmax over periodic images, with bond vector and projected ADP |
| `core/pdf/forwardModel.ts` | G_calc(r): pair sum, peak widths, −4πρ₀r baseline, Qdamp and sphere envelopes |
| `core/pdf/termination.ts` | Qmax band limit by direct convolution with the sampled sinc kernel |
| `core/pdf/partials.ts`, `core/pdf/gradients.ts` | Element-pair partials; G(r) with analytic ∂G/∂p in one pass |
| `core/totalscattering/weights.ts`, `grErrors.ts` | ⟨b⟩, ⟨b²⟩ and ρ₀, with b = Z for X-rays; σ_G(r) from S(Q) errors, with no production caller |
| `core/totalscattering/fourier.ts` | S(Q) or F(Q) → G(r) when a file loads |
| `core/magnetic/mpdf.ts` | Frandsen spin-pair kernel and ⟨j0⟩ envelope |
| `core/crystal/cellExpansion.ts` | `expandSpinField`, the magnetic box |
| `core/math/fft.ts` | Deterministic FFT convolution |
| `core/workflow/pdf.ts` | PDF specs and problems (single, multi-phase, multi-dataset), stage order, warnings |
| `core/workflow/mpdf.ts` | Nuclear G(r) plus d_mag(r) in one residual |
| `core/workflow/pdfBoxcar.ts` | The boxcar window plan |
| `core/diffraction/types.ts` | `PdfPattern`, outside the `DiffractionDataset` union |
| `core/pdf/pdffit2Golden.ts`, `core/magnetic/mpdfGolden.ts`, `core/magnetic/mnoGolden.ts` | Committed reference curves |
| `parsers/pdfData.ts`, `parsers/fgrData.ts` | `.gr`, `.sq` and `.fq`; PDFgui `.fgr` fits |
| `workers/protocol.ts`, `workers/runPowder.ts` | The `pdf` and `mpdf` evaluator specs |
| `app/PdfWorkbench.tsx`, `app/ui/PosteriorPanel.tsx`, `app/ui/BoxcarPanel.tsx` | The PDF page and its views |

**Planned but not built:** `core/pdf/peakWidth.ts`, folded into the enumerator
and forward model; `core/totalscattering/reduction.ts` and
`core/scattering/waasmaierKirfelData.ts` (Track PR); a WebGPU pair-sum kernel
(§6).

**Agent tools** live in `mcp/registry.ts` and `mcp/tools.ts`;
[AGENT_TOOLS.md](./AGENT_TOOLS.md) describes each one.

| Planned | As built |
| --- | --- |
| `load_gr_data` | `parse_pdf_data`, which also reads `.fgr` |
| `set_pdf_range` | Not built; `fitRange` is an argument of the refine, sample and calibrate tools |
| `propose_local_spin_model_from_symmetry` | ⬜ Not built (P5). Agents chain `list_magnetic_subgroups`, `allowed_moments`, `build_magnetic_model` and `build_mpdf_model`. |
| `build_pdf_model`, `refine_pdf`, `calibrate_qdamp`, `compute_partial_pdf`, `build_mpdf_model`, `refine_mpdf` | ✅ as planned |
| — | Added: `compute_mpdf_components`, `refine_pdf_boxcar`, `sample_posterior`, `build_symmetry_modes`, `build_distortion_modes` |

---

## 5. Phased roadmap

Each phase ends with passing tests, updated docs, a working local app and a
validation gate.

| Phase | Status | Scope | Gate (test) |
| --- | --- | --- | --- |
| P0 | ✅ | Data model, reduced-PDF import | Parse and save round trip (`parsers/pdfData.test.ts`, `app/projectIo.test.ts`) |
| P1 | ✅ | Neutron forward model, refinement | PDFgui and PDFfit2 (`core/pdf/pdf.test.ts`, `core/pdf/pdffit2Golden.test.ts`) |
| P2 | ✅ | X-ray PDF | PDFfit2 (`core/pdf/pdffit2Golden.test.ts`) |
| P3 | 🚧 | Termination, nanoparticles, partials, multi-phase, multi-dataset | PDFfit2 (`core/pdf/pdffit2Golden.test.ts`); low-Qmax ripple ⬜ 🔬 |
| P4 | ✅ | mPDF co-refined with the nuclear PDF | diffpy.mpdf (`core/magnetic/mnoGolden.test.ts`, `core/workflow/mpdfTutorialData.test.ts`) |
| P5 | 🚧 | Symmetry-constrained local spin model | Parameter count = irrep dimension ⬜ |
| P6 | 🚧 | Agent tools, UI, uncertainty | Agent loops (`mcp/pdfAgentLoop.test.ts`, `mcp/mpdfAgentLoop.test.ts`) |

### P0 — Data model and reduced-PDF import ✅

**Done**
- `PdfPattern`, and `.gr`, `.sq` and `.fq` files in the PDFgetX3 and Mantid
  dialects, checked on real NSLS-II 28-ID and POWGEN files. S(Q) and F(Q) become
  G(r) on load.
- PDFgui `.fgr` fits. `parse_pdf_data` can also take a fit's difference curve,
  the experimental mPDF of a nuclear fit.
- Format detection, the signed-y plot, the PDF page, and a `pdf` workspace in
  project files ([PROJECT_FORMAT.md](./PROJECT_FORMAT.md)).

**Validation gate** ✅
- Metadata and negative lobes survive parsing; page state survives save and
  reopen.

### P1 — Neutron PDF forward model and refinement ✅

**Done**
- `buildPdfProblem`: uniform weights, a fit window, and a pair-list cache keyed
  on cell, positions and ADPs. A cached evaluation is bit-identical to a fresh
  one.
- `buildPdfSpec` reuses the powder page's symmetry-reduced parameters.
- Staged order: scale → cell → ADPs → correlated motion → positions → occupancy.
  Qdamp and Qbroad stay at their calibrated values.

**Validation gate** ✅
- G_calc(r) matches PDFgui on measured POWGEN data for Fe₀.₁Co₀.₉Sn at 1.7 K
  (data-gated).
- A perturbed model refines back to PDFfit2-generated data: cell within 2 mÅ,
  plus scale and per-element ADPs. δ1 is not gated.

### P2 — X-ray PDF ✅

**Done**
- The X-ray weight Z = f(0), with ⟨Z⟩ normalization and Qbroad.

**Validation gate**
- ✅ PDFfit2 1.6.0 curves for Ni, MnO and rutile with anisotropic ADPs, from a
  committed fixture
  ([VALIDATION.md](./VALIDATION.md#fits-and-workflows-checked-against-external-tools)).
- 🔬 The error of f = Z against a Q-dependent normalization is not measured.

### P3 — Advanced PDF 🚧

**Done**
- Qmax termination with grid extension and odd reflection near r = 0, applied
  whenever the pattern carries Qmax.
- The `spdiameter` sphere envelope, element-pair partials, and `sratio`/`rcut`
  with a conflict warning.
- Multi-phase G(r): per-phase scale, cell, atoms, δ and particle size, shared
  Qdamp and Qbroad, and per-phase overlay curves.
- Multi-dataset co-refinement in the core: one structure, with per-dataset
  scale, Qdamp, Qbroad and fit window.
- `calibrate_qdamp`, which frees only the scale, Qdamp and Qbroad on a standard.

**Next**
1. `stepcut`, PDFfit2's step-function cutoff for nanoparticles.
2. A multi-dataset surface (P6).

**Validation gate**
- ✅ PDFfit2 nanoparticle and two-phase curves; partials sum exactly to the
  total.
- ⬜ 🔬 Ripples against a low-Qmax reference, such as PDFgetN's spurious Ni peak
  near r ≈ 3 Å. All PDFfit2 fixtures use Qmax = 25 Å⁻¹.

### P4 — Magnetic PDF ✅

**Done**
- `magnetic/mpdf.ts`: the Frandsen kernel with diffpy.mpdf's normalization, the
  ⟨j0⟩ envelope, the paramagnetic term, the net-moment line of a ferromagnet,
  and an exp(−r/ξ) envelope.
- `buildMpdfProblem`: nuclear G(r) plus d_mag(r) in one residual. Moments stage
  just before positions.
- A moment multi-start shared with magnetic powder: freeze the nuclear model,
  kick the moments, fit jointly, canonicalize ±m.
- Tools `build_mpdf_model`, `refine_mpdf` and `compute_mpdf_components`. The last
  reports whether the magnetic signal is worth fitting.
- A Magnetic step on the PDF page for single-phase neutron data. Overlays, mCIF
  export and the Posterior view follow the spin model.

**Next**
1. A separate Qdamp for the magnetic term. Both terms share one, and a free ξ
   absorbs part of the mismatch.

**Validation gate** ✅
- MnO from MAGNDATA 1.31, the Frandsen & Billinge 2015 case: f(r) and D(r) for
  its fixed spins match diffpy.mpdf. Synthetic AFM, FM, 120° and canted boxes
  match too, all from committed fixtures.
- diffpy.mpdf tutorial data (data-gated): the MnO ordered scale matches diffpy's,
  MnTe co-refines through `refine_mpdf`, and MnSb checks the net-moment line and ξ.
- Pooled evaluation equals serial bit for bit, even when a moment crosses zero.

### P5 — Symmetry-constrained local spin model 🚧

The goal is requirement (4): a local magnetic model whose freedom is exactly the
symmetry-allowed modes.

**Done**
- The PDF page's Magnetic step mounts the magnetic symmetry panel with a
  real-space backend. It fits and ranks subgroup candidates against G(r).
- The free moment parameters are the allowed modes of the chosen subgroup,
  picked directly or as the isotropy subgroup of chosen irreps.
- An isotropic correlation length ξ.

**Next**
1. `propose_local_spin_model_from_symmetry`: one tool that enumerates maximal
   subgroups, reads the allowed bases and seeds amplitudes.
2. Moment modes projected onto one irrep, so the parameter count equals its
   dimension.
3. An anisotropic correlation length.

**Validation gate**
- ⬜ On a known case, the free-parameter count equals the irrep dimension.
- ✅ Finite-ξ curves match diffpy.mpdf. A refined ξ matches an external
  diffpy.mpdf fit of one measured dataset (data-gated).
- ✅ Forbidden moment directions stay zero, by construction.

### P6 — Agent tools, UI and uncertainty 🚧

**Done**
- Agent tools for nuclear and magnetic studies, with warnings for inputs that make
  a fit meaningless, such as a missing ADP or X-ray data given a spin model.
- Pooled refinement in the browser and the node agent server, bit-identical to
  serial.
- Posterior sampling: the ensemble sampler in the Posterior view and
  `sample_posterior`, which also offers NUTS for single-phase PDF
  ([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)).
- Boxcar refinement through `refine_pdf_boxcar` and the Boxcar view. Each box
  seeds from the last, with optional restarts. The view can scan both ways to
  expose path dependence, and it fits mPDF boxes when a spin model is applied.
- The PDF page is one of the bundled demos: GaTa₄Se₈ X-ray G(r) at 299 K.

**Next**
1. Magnetic models in `sample_posterior` and `refine_pdf_boxcar`. The page samples
   mPDF with the ensemble sampler only; the mPDF problem has no gradient for NUTS.
2. PDF-aware `assess_refinement` bands and PDF next-step suggestions. The
   assessment knows only powder and single-crystal modes.
3. A multi-dataset surface: evaluator spec, agent tool and UI. The core builder
   has no caller outside tests.
4. Esds and GoF from independent points on the Nyquist grid (§8).
5. r-range presets.

**Validation gate**
- ✅ Through the tools alone, an agent completes a nuclear study and an mPDF
  study.
- ⬜ The planned gate ends with a report on the Ni and MnO fixtures. No agent tool
  writes a report.

### Symmetry-mode / subgroup track (documented elsewhere)

The PDF page's AMPLIMODES/ISODISTORT-style mode-amplitude refinement, its Γ
isotropy-subgroup activation and the translationengleiche subgroup lattice
shipped outside this roadmap's P0–P6 arc; they are summarised in
[ROADMAP.md](./ROADMAP.md) §2. The next phase — klassengleiche subgroups,
supercell realisation, zone-boundary modes, and the amplitude-vs-r payoff
through the boxcar sweep — is planned in
[PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md)
(Track A).

### Deferred tracks

- **Track PR — data reduction** ⬜. `totalscattering/reduction.ts` would take raw
  I → S(Q) → F(Q) → G(r) as PDFgetX3 and PDFgetN do, with the Waasmaier–Kirfel
  table and Compton and Placzek corrections. It is large; build it only if users
  need in-app reduction.
- **Anomalous and resonant PDF** ⬜. It needs f′ and f″ tables and a complex f.
  `ScatteringTable` returns one real number, so its interface must grow.
- **Incommensurate mPDF** ⬜. Helices and spin-density waves need the
  `fourierMoment.ts` route.

### Out of scope

- **Big-box magnetic reverse Monte Carlo** (SPINVERT, RMCProfile): Metropolis
  moves on unconstrained spins, with no symmetry and no LM. The local model here
  is P5's symmetry-constrained small box.

---

## 6. Performance plan

The pair sum costs O(N_cell · N_images) per phase and grows as rmax³.

| Rung | Status | Notes |
| --- | --- | --- |
| 1. f64 CPU in a Web Worker | ✅ caching · ⬜ binning | The reference path. The pair list is cached on cell, positions and ADPs, so other steps skip enumeration. Neighbour binning of the images is not built. |
| 2. Evaluator pool for the Jacobian | ✅ | `pdf` and `mpdf` specs. Multi-start, staged and boxcar runs each reuse one pool. |
| 3. Opt-in WebGPU pair-sum kernel | ⬜ | f32, gated like the structure-factor kernels: WGSL field count equals the JS stride, and an f64 twin matches CPU G(r) to 1e-6. Many small Gaussians may be more f32-sensitive than a reflection sum. |
| 4. Analytic gradients | ✅ PDF · ⬜ mPDF | Cell, sratio/rcut, ties and multi-phase or multi-dataset problems fall back to finite differences ([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)). Every mPDF column is a finite difference. |

For mPDF, a moment-only step recomputes only d_mag(r); the spin pairs, the
form-factor envelope and the nuclear curve are cached. Each convolution picks
the direct sum or an FFT, whichever is cheaper. An mPDF evaluation still costs
far more than a powder profile, so the Magnetic step's exploratory fit runs 3
restarts.

---

## 7. Validation strategy

The PDF track uses golden values plus external cross-checks. Committed fixtures
run on CI; tests that read the git-ignored `data/` folder skip without it.
Results are in
[VALIDATION.md](./VALIDATION.md#fits-and-workflows-checked-against-external-tools).

| Check | Reference | Status |
| --- | --- | --- |
| Qdamp and Qbroad calibration on a standard (Ni, Si, LaB₆) | measured Ni X-ray standard | ✅ |
| Nuclear golden: Ni and MnO, neutron and X-ray | PDFfit2 1.6.0; PDFgui on measured data | ✅ |
| mPDF golden: MnO (Frandsen & Billinge 2015), plus a fixed-spin numeric cross-check of d_mag(r) against diffpy.mpdf | diffpy.mpdf and its tutorial data | ✅ |
| Partials sum to the total (Faber–Ziman) | exact identity | ✅ |
| ⟨b⟩ sign for negative-b elements (Mn, H, Ti) | Mn only | 🚧 |
| Termination ripple at low Qmax | PDFgetN Ni near r ≈ 3 Å | ⬜ 🔬 |

PDFfit2's neutron b for Mn is −3.75018 fm, against the Sears value of −3.73 fm
used here. Because ⟨b⟩ nearly cancels in MnO, that is about a 2 % amplitude
offset, which the scale absorbs and the test allows.

### Lessons from the gates

Each rule came from a failed or missing gate, and each still guides new work.

- **Moment presence is a symmetry fact.** Whether an atom carries a moment
  depends on the magnetic group, never on its current size. Otherwise
  geometry-keyed caches index a spin list that changes as a moment crosses zero.
- **A magCIF group is operations × centerings.** Compose both loops and dedupe
  with θ in the key. Reading only the operation loop silently drops most of a
  centred magnetic cell.
- **Split-orbit anchors follow the refined position.** Store an orbit index and
  re-derive the position from the site. A position frozen at build time loses
  sublattices once the site moves past the match tolerance.
- **A kernel reports its own centre.** `formFactorEnvelope` returns the index of
  r = 0. Re-deriving it is off by one bin when the step does not divide the
  range, which goldens at 0.01 Å cannot see.
- **A missing ADP is a defect, not a default.** A CIF without an ADP column gives
  B = 0, delta-sharp peaks and a meaningless fit. The model builders and the PDF
  page warn rather than invent a value.
- **Keep the ordered mPDF scale out of the moment group.** `mpdfOrdScale` is
  exactly degenerate with the moment size, so one "free all" click would fit a
  flat valley.
- **Kick moments seeded at zero.** The magnetic signal is quadratic in the
  moments, so m = 0 is a stationary point that plain LM cannot leave.
- **Keep termination a direct sum.** FFT convolution error scales with the whole
  array, which the sinc's alternating tail makes large and finite differences
  amplify. An FFT is safe on a small added term or a smooth single-signed kernel.
- **Finite-difference oracles need a Richardson filter.** The ±5σ Gaussian
  window is quantized on the r grid, so FD spikes where a pair crosses a window
  edge, and termination spreads the spikes. Compare only points where FD(h) and
  FD(h/2) agree, with termination off for tight tolerances. When a gate fails,
  suspect the oracle first.
- **Re-initialize evaluator replicas when the fit window changes.** The window is
  part of the replica's problem, so a reused pool would evaluate the wrong
  boxcar window.
- **Seed each box's restarts separately.** A shared seed repeats one perturbation
  pattern in every box, which can imprint its own r-dependence.

---

## 8. Scientific caveats / honesty statement

- **Correlated G(r) errors.** A finite-Q sine transform correlates G(r) point
  errors, so 1/σ² is not a true weight (Toby & Billinge 2004; PDFgui warns the
  same). The fit uses uniform weights and reports Rw over G(r), not the Bragg
  Rwp. Esds are optimistic, and the normal-probability plot bends even for a
  perfect fit. Only the meaning of the covariance suffers, not the minimization.
- **Independent points.** Esds count every r-grid point, and reduced grids are
  usually finer than the Nyquist spacing Δr = π/Qmax, so esds shrink further.
  Counting points on the Nyquist grid is not implemented; treat esd and GoF as
  relative.
- **Bayesian likelihood.** Every noise model treats G(r) points as independent,
  so a posterior is an approximation. The rigorous ladder, in order:
  1. independent Gaussian residuals ✅
  2. a fitted or marginalized noise scale, the default ✅
  3. a simple correlated-residual model ⬜
  4. a covariance propagated from the F(Q) reduction, the full fix ⬜
- **No √yObs weights.** The shared observation path defaults to σ = √yObs and
  skips yObs ≤ 0, and neither suits G(r). The PDF problem uses uniform weights
  and keeps negative points.
- **X-ray weight.** The weight f(0) = Z is independent of Q, as in PDFfit2. It
  approximates a Q-dependent normalization, by an amount not measured.
- **Reduced data only.** MATERIA fits reduced G(r), as PDFgui and DiffPy do.
  Background, absorption, Compton and Placzek corrections and the Qmax choice
  belong to the upstream tool until Track PR.
- **Absolute mPDF moment size.** `mpdfOrdScale` is exactly degenerate with the
  moment size, so free one, never both. The kernel follows diffpy.mpdf's
  convention: m = g·S, with g-factors of 1.
- **Commensurate, single-k, single-phase mPDF.** The spin field is an explicit
  magnetic box, so k must be 0 or commensurate. Incommensurate fields need the
  `fourierMoment.ts` route (§5). An incommensurate k, or a denominator above
  12, is not rejected yet: the box silently stays one parent cell, so the
  magnetic G(r) is wrong.
- **Local optimizer.** LM needs a reasonable starting model. Multi-start
  mitigates moment-sign and shape-versus-scale minima, but it is not a global
  search.
- **GPU.** A pair-sum kernel, if built, would be an f32 accelerator. The f64 CPU
  path stays the reference.

---

## 9. References

DOI-linked entries are in [REFERENCES.md](./REFERENCES.md), section "Real-space
total scattering — PDF & mPDF".

- Farrow et al., *J. Phys.: Condens. Matter* 19 (2007) 335219 — PDFfit2 and PDFgui
- Proffen & Billinge, *J. Appl. Cryst.* 32 (1999) 572 — PDFFIT
- Juhás et al., *J. Appl. Cryst.* 46 (2013) 560 — PDFgetX3
- Juhás et al., *Acta Cryst.* A71 (2015) 562 — DiffPy-CMI and SrFit
- Frandsen, Yang & Billinge, *Acta Cryst.* A70 (2014) 3 — mPDF theory
- Frandsen & Billinge, *Acta Cryst.* A71 (2015) 325 — mPDF fitting, MnO
- Paddison, Stewart & Goodwin, *J. Phys.: Condens. Matter* 25 (2013) 454220 — SPINVERT
- Waasmaier & Kirfel, *Acta Cryst.* A51 (1995) 416 — 5-Gaussian f(Q)
- Toby & Billinge, *Acta Cryst.* A60 (2004) 315 — PDF uncertainties
- Egami & Billinge, *Underneath the Bragg Peaks*, 2nd ed. (2012)
- Goodman & Weare, *Commun. Appl. Math. Comput. Sci.* 5 (2010) 65 — affine-invariant ensemble MCMC
- Fancher et al., *Sci. Rep.* 6 (2016) 31625 — Bayesian MCMC full-profile refinement
- McCluskey et al., *J. Appl. Cryst.* 56 (2023) 12 — reporting Bayesian analysis of scattering data
