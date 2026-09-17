# Roadmap

This is the plan for MATERIA Workbench as a whole: what comes next, and in what
order. Two tracks keep their own plans. [PDF_MPDF_ROADMAP.md](./PDF_MPDF_ROADMAP.md)
covers PDF and magnetic PDF.
[PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md)
covers PDF supercells as Track A and incommensurate magnetic studies as Track B.
The superseded `POWDER_ROADMAP` and `MATURITY_PLAN` stay in [archive/](./archive/).

Status legend: ✅ done · 🚧 in progress · ⬜ not started

## 1. Vision

MATERIA Workbench is a traditional refinement package that runs entirely in the
browser on a framework-free TypeScript core. It fits weighted least squares to
Rietveld and single-crystal data, atomic structures first, then magnetic. Every
capability is also an agent tool, so a person and an agent use the same
validated functions.

- **Correctness first, in TypeScript.** No WebAssembly, no global-search
  shortcuts, and no feature called validated until a test or external
  comparison records it. GPU kernels are allowed only as accelerators, each
  validated against the f64 CPU path, which stays the reference (§6).
  `src/core/**` stays pure, so it is both testable and callable as a tool.
- **One engine, many workflows.** Powder, single-crystal, atomic and magnetic
  refinement share one constrained least-squares engine. Everything else is a
  parameterization or a correction term.

The engine follows
[`refinement_fitting_algorithms_knowledge.md`](../knowledge/refinement_fitting_algorithms_knowledge.md):
never refine everything at once, never ignore correlations, refine only
symmetry-allowed parameters, and use global search only for starting models.

## 2. Current state

[LIMITATIONS.md](./LIMITATIONS.md) lists what works, what is approximate and
what is missing. [VALIDATION.md](./VALIDATION.md) records the evidence.

| Area | Status | Summary | Detail |
| --- | --- | --- | --- |
| [F1 Robust engine](#f1--robust-refinement-algorithm-) | 🚧 | LM with esds, staged guards and multi-start; analytic derivatives are partial | [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md) |
| [F2 Symmetry constraints](#f2--symmetry-constrained-parameterization-) | 🚧 | All 230 space groups; Wyckoff letters for a curated set only | [LIMITATIONS.md](./LIMITATIONS.md#symmetry) |
| [M1 Atomic refinement](#m1--atomic-structure-refinement-) | 🚧 | Staged CW and TOF Rietveld; GaNb₄Se₈ wR below GSAS-II's | [LIMITATIONS.md](./LIMITATIONS.md#powder-diffraction) |
| [M2 k-vector search](#m2--magnetic-k-vector-search-) | 🚧 | Commensurate single-k search by peak position | [LIMITATIONS.md](./LIMITATIONS.md#magnetic-structures) |
| [M3 Magnetic symmetry](#m3--magnetic-space-group-and-symmetry-analysis-) | 🚧 | Subgroup lattice, BNS/OG labels, irreps; no projective small representations | [MAGNETIC_SYMMETRY.md](./MAGNETIC_SYMMETRY.md) |
| [M4 Magnetic refinement](#m4--magnetic-structure-refinement-) | 🚧 | One k, commensurate or incommensurate; candidates ranked on the data | [Track B plan](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md) |
| [M5 Ship the results](#m5--ship-the-results-) | 🚧 | Project files, CIF and mCIF, HTML report, FullProf and GSAS-II bundle | [PROJECT_FORMAT.md](./PROJECT_FORMAT.md) |
| [M6 Microstructure](#m6--powder-microstructure-and-texture-) | 🚧 | Size and strain models; texture is March–Dollase only | [MICROSTRUCTURE.md](./MICROSTRUCTURE.md) |
| [M7 Single crystal](#m7--single-crystal-refinement-) | 🚧 | F² refinement and the magnetic supercell merge; no twinning | [SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md) |
| PDF and mPDF | 🚧 | Nuclear and magnetic PDF, boxcar fits, posteriors; local spin model open | [PDF_MPDF_ROADMAP.md](./PDF_MPDF_ROADMAP.md) |
| PDF symmetry modes | ✅ | Γ distortion modes and the translationengleiche subgroup tree | [Track A plan](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md) |
| Track A: PDF supercells | ⬜ | Klassengleiche subgroups, zone-boundary modes, child-cell PDF model | [Track A plan](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md) |
| Track B: incommensurate | ⬜ | Refine k, Fourier-loop mCIF, star of k, harmonics | [Track B plan](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md) |
| [Agent layer](#5-agent-tools-skills-and-llm-guided-refinement) | 🚧 | MCP tools per milestone; a powder Rietveld skill | [AGENT_TOOLS.md](./AGENT_TOOLS.md) |

## 3. Foundations

F1 and F2 gate every milestone, and they are coupled. F2 hands F1 only the
symmetry-allowed modes, so an atom on a special position never refines raw x, y
and z.

### F1 — Robust refinement algorithm 🚧

F1 makes the engine converge reliably on hard real data. Open items close in
numbered order.

**Done**
- 🚧 **F1.1 Analytic derivatives:** powder occupancy and B_iso, and most PDF
  parameters in one fused pass ([`gradients.ts`](../src/core/pdf/gradients.ts)),
  on by default for every serial fit and the pooled PDF fits. Powder
  coordinates, cell, profile and zero shift remain finite-difference.
- ✅ **F1.2 Windows and caching:** peaks sum over ±20 FWHM, and structure
  factors are reused while the geometry holds ([`powder.ts`](../src/core/workflow/powder.ts)).
- ✅ **F1.3 Starting values:** automatic scale, an envelope background and a
  zero-shift check ([`startingValues.ts`](../src/core/workflow/startingValues.ts)).
- ✅ **F1.4 Convergence and staged guards:** the controller rejects a stage that
  raises wR or inflates earlier esds, and re-fixes a new parameter that turns
  singular or near-perfectly correlated. A shift-based stop is opt-in
  ([`staged.ts`](../src/core/refinement/staged.ts)).
- ✅ **F1.5 Next-parameter diagnostic:** ranks fixed parameter groups by
  expected χ² drop ([`nextParameters.ts`](../src/core/workflow/nextParameters.ts)).
- 🚧 **F1.6 Global search:** Prefit and Escape min restart a fit from seeded
  perturbations ([`multiStart.ts`](../src/core/refinement/multiStart.ts)).

**Next**
1. 🚧 **F1.1** Analytic derivatives for powder coordinates, cell, profile, zero
   shift and moments; for PDF, the cell and sratio/rcut.
2. 🚧 **F1.6** Monte Carlo or simulated annealing to propose starting models for
   a poor initial model or ambiguous moment signs and phases. It feeds M2 and M4
   and never replaces LM.
3. ⬜ **F1.7** Pluggable local minimizers (below).
4. 🚧 **F1.8** Faster posterior sampling and a corner plot (below).

**Validation gate**
- ✅ Staged GaNb₄Se₈ fit: wR ≈ 5.7%, below GSAS-II's 7.34% on the same data
  ([`realPowderXRD.test.ts`](../src/core/workflow/realPowderXRD.test.ts)).
- ✅ Analytic columns match finite differences for powder
  ([`analyticJacobian.test.ts`](../src/core/workflow/analyticJacobian.test.ts))
  and PDF ([`pdfAnalyticJacobian.test.ts`](../src/core/workflow/pdfAnalyticJacobian.test.ts)).
- ✅ The SVD solve suppresses duplicated parameters
  ([`engine.test.ts`](../src/core/refinement/engine.test.ts)).

**Tools:** `rank_next_parameters` and `sample_posterior`.

#### F1.7 — Alternative local minimizers ⬜

Levenberg–Marquardt stays primary, because its Jacobian yields the covariance,
esds and correlations that are deliverables here. The engine is a sans-io
generator behind `RefinementProblem`, so another minimizer plugs in without a
rewrite ([`engine.ts`](../src/core/refinement/engine.ts)). Candidates, by
expected value:

1. **LM upgrades that keep the covariance.** Geodesic acceleration (Transtrum &
   Sethna 2012) helps in narrow, sloppy valleys. Dogleg trust-region steps
   (Moré 1978) control damping more carefully. An iterative LSMR or CG inner
   solve scales to many parameters (Fong & Saunders 2011).
2. **L-BFGS-B** (Byrd et al. 1995) needs only the gradient, so it suits large
   problems such as texture ODFs. On typical fits, LM needs fewer evaluations.
3. **Nonlinear CG or Barzilai–Borwein descent:** a low-memory floor that L-BFGS
   usually beats.

L-BFGS gives no valid covariance, so a gradient-only driver still needs a final
LM pass for the esds.

**Validation gate**
- ⬜ Each alternative reaches LM's minimum on GaNb₄Se₈ and the PDF golden.
- ⬜ A benchmark across problem sizes shows where each one beats LM.
- ⬜ Gradient-only methods match the LM esds after the final pass.

#### F1.8 — Bayesian posterior sampling 🚧

A second driver behind the same seam samples the posterior for uncertainty,
which also proves F1.7's drop-in claim. Details are in
[REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md).

**Done**
- An ensemble sampler with bit-identical, resumable serial and pooled runs
  ([`sampler.ts`](../src/core/refinement/bayes/sampler.ts)).
- A NUTS sampler for single-phase PDF fits ([`nuts.ts`](../src/core/refinement/bayes/nuts.ts)).
- Both match the LM esds on the Ni PDFfit2 golden
  ([`pdfPosterior.test.ts`](../src/core/workflow/pdfPosterior.test.ts)).
- The `sample_posterior` tool, and a Posterior view on the PDF page.

**Next**
1. Analytic cell gradients, so cell posteriors sample at full speed.
2. NUTS on the worker pool.
3. A corner plot.

### F2 — Symmetry-constrained parameterization 🚧

Constraints are only as good as the operation list behind them, and F2 makes
that list complete.

**Done**
- ✅ **F2.1 Space-group tables:** all 230 groups, generated from gemmi, with
  computed point groups and site symmetries ([`spaceGroupData.ts`](../src/core/crystal/spaceGroupData.ts)).
- ✅ **F2.2 Systematic absences:** from the operations, with centring added to
  primitive-only CIFs ([`spaceGroups.ts`](../src/core/crystal/spaceGroups.ts)).
- ✅ **F2.3 One constraint method:** positions, ADPs, moments and the cell share
  one stabilizer null space ([`siteConstraints.ts`](../src/core/crystal/siteConstraints.ts)).
- ✅ **F2.4 Setting transforms:** basis and origin changes, plus rhombohedral ⇄
  hexagonal ([`settings.ts`](../src/core/crystal/settings.ts)).

**Next**
1. 🚧 **F2.1** Wyckoff letters beyond the curated set; multiplicities and site
   symmetries cover all 230 ([`wyckoff.ts`](../src/core/crystal/wyckoff.ts)).

**Validation gate**
- ✅ Wyckoff letters and special-position constraints match International
  Tables for the curated groups ([`wyckoff.test.ts`](../src/core/crystal/wyckoff.test.ts)).
- ✅ All 230 groups classify as point groups; closure holds on a sample of all
  seven crystal systems ([`spaceGroups.test.ts`](../src/core/crystal/spaceGroups.test.ts)).

**Tools:** `analyze_site_symmetry`.

## 4. Milestones

Each milestone gives its goal, what is done, what is next in order, its
validation gate and its agent tools.

### M1 — Atomic structure refinement 🚧

**Goal:** reliable, well-diagnosed convergence from a good starting model, on
powder or single-crystal data.

**Done**
- Staged Rietveld: scale, background, cell, profile, ADPs, positions
  ([`structureRefinement.ts`](../src/core/workflow/structureRefinement.ts)).
- Thompson–Cox–Hastings peaks with Finger–Cox–Jephcoat asymmetry for CW data,
  and back-to-back exponentials for TOF ([`profile.ts`](../src/core/diffraction/profile.ts)).
- The two-phase Mn₃Ga + MnO POWGEN demo opens converged at wR ≈ 3.9%
  ([`mn3gaPowgen.ts`](../src/examples/mn3gaPowgen.ts)).
- |F|² matches GSAS-II's relative Fc² on GaNb₄Se₈
  ([`sfDiagnostic.test.ts`](../src/core/diffraction/sfDiagnostic.test.ts)).

**Next**
1. Analytic derivatives for coordinates, cell and profile (F1.1).
2. A global search for starting models (F1.6).
3. Wyckoff letters for the remaining groups (F2).
4. Bond-length and angle tables in the report (M5).

**Validation gate**
- ⬜ With atoms fixed, as in GSAS-II's fit, wR closes toward 7.34%
  ([`gsasBenchmark.test.ts`](../src/core/workflow/gsasBenchmark.test.ts)). The
  staged fit is already below it.
- ✅ A displaced atom on a special position is recovered
  ([`structureRefinement.test.ts`](../src/core/workflow/structureRefinement.test.ts)).
- ⬜ One model refines jointly against X-ray and neutron histograms.

**Tools:** `build_refinement` and `refine_powder`; `refine_single_crystal` is
planned.

### M2 — Magnetic k-vector search 🚧

**Goal:** find k from the magnetic peaks that the nuclear cell does not index.

**Done**
- A commensurate single-k search that ranks candidates by matched satellite
  positions ([`kSearch.ts`](../src/core/magnetic/kSearch.ts)).
- On real AWO₄ 6 K neutron data, the difference from the paramagnetic pattern
  yields k = (½,0,0) ([`realAwo4Magnetic.test.ts`](../src/core/workflow/realAwo4Magnetic.test.ts)).
- Each k is classed as zero, self-conjugate or two-arm; an irrational k runs
  through the whole M4 path ([`propagation.ts`](../src/core/magnetic/propagation.ts)).

**Next**
1. Refine k, scheduled with M4 as Track B1.
2. Score candidates by magnetic intensity (Le Bail), not only by position.
3. Multi-k structures.

**Validation gate**
- ✅ The search recovers a zone-boundary k on synthetic and real AWO₄ data and
  does not prefer Γ for magnetic peaks ([`kSearch.test.ts`](../src/core/magnetic/kSearch.test.ts)).
- ⬜ An intensity-scored search passes the same checks.

**Tools:** `find_unexplained_peaks` and `search_propagation_vector`.

### M3 — Magnetic space-group and symmetry analysis 🚧

**Goal:** for a parent group and k, enumerate the magnetic symmetry and the
moment basis that M4 refines.

**Done**
- The little group of a commensurate k and its magnetic subgroups, reducing to
  the k = 0 set at Γ ([`magneticGroups.ts`](../src/core/magnetic/magneticGroups.ts)).
- The full subgroup lattice, with conjugacy classes and domain counts
  ([`subgroupLattice.ts`](../src/core/magnetic/subgroupLattice.ts)).
- BNS/OG labels for type-I and type-III groups, including non-standard settings
  ([`bnsOg.ts`](../src/core/magnetic/bnsOg.ts)).
- Irreps at k = 0 for every parent, and at any k for an abelian little group
  ([`irreps.ts`](../src/core/magnetic/irreps.ts)).
- A combination of irreps names its isotropy subgroup
  ([`isotropy.ts`](../src/core/magnetic/isotropy.ts)).

**Next**
1. Projective small representations for non-abelian little groups at k ≠ 0.
2. The star of k and type-IV (anti-translation) groups, as Track B3.

**Validation gate**
- ✅ At Γ, the general-k enumeration reproduces the k = 0 candidates
  ([`littleGroup.test.ts`](../src/core/magnetic/littleGroup.test.ts)).
- ✅ Enumerated groups match the ISO-MAG table for three parent groups
  ([`bnsOg.test.ts`](../src/core/magnetic/bnsOg.test.ts)).
- ⬜ Little groups and allowed moments match Bilbao or ISODISTORT.

**Tools:** `list_magnetic_subgroups` and `allowed_moments`.

### M4 — Magnetic structure refinement 🚧

**Goal:** refine moment basis-mode amplitudes, never raw moment components, for
each M3 candidate, then rank candidates by fit and physical plausibility.

**Done**
- k = 0 moment refinement on powder and single-crystal data, with candidate
  comparison ([`magneticCompare.ts`](../src/core/workflow/magneticCompare.ts)).
- A single-k Fourier structure factor that covers spin-density waves, helices
  and cycloids ([`fourierMoment.ts`](../src/core/magnetic/fourierMoment.ts)).
- For a two-arm or incommensurate k, each mode refines a cosine and a sine
  amplitude. One sine amplitude stays fixed, because the overall phase is
  unobservable ([`allowedMoments.ts`](../src/core/magnetic/allowedMoments.ts)).
- The magnetic page refines every candidate that allows moments and ranks them
  by wR. Ties within 0.01% go to the maximal subgroup with the fewest parameters
  ([`KSearchPanel.tsx`](../src/components/KSearchPanel.tsx)).
- The page draws the chosen candidate on the pattern, opens on an applied model
  and explains a residual on nuclear positions as k = 0.
- **AWO₄ 6 K demo (LOCAL ONLY):** opens on the solved k = (½,0,0), P2/c′
  structure. Its data are unpublished, stay in the git-ignored `data/` folder
  and never enter the public build ([`awo4Magnetic.ts`](../src/examples/awo4Magnetic.ts)).

**Next** (items 1–4 are Track B phases in
[PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md))
1. Refine k (B1).
2. A Fourier-loop mCIF and a labelled approximant in the viewer (B2).
3. The star of k: arms, domain populations, type-IV candidates (B3).
4. Harmonics at 3k and 5k (B4); (3+1)D superspace is a later milestone.
5. Cosine and sine modes taken from M3's irreps.
6. Correlation diagnostics in the candidate ranking.
7. A global search for moment signs and phases (F1.6).

**Validation gate**
- ✅ A known k ≠ 0 mode amplitude is recovered
  ([`fourierMoment.test.ts`](../src/core/magnetic/fourierMoment.test.ts)).
- ✅ The k formalism matches a brute-force supercell sum at every satellite
  ([`fourierModulation.test.ts`](../src/core/magnetic/fourierModulation.test.ts)).
- ✅ A helix is recovered through the powder workflow
  ([`fourierPowder.test.ts`](../src/core/workflow/fourierPowder.test.ts)).
- ✅ On data simulated from the 30 K Mn₃Ga structure, the true group ranks first
  ([`magneticCompare.test.ts`](../src/core/workflow/magneticCompare.test.ts)).
- ⬜ The true structure ranks first on a measured golden dataset.

**Tools:** `build_magnetic_model` and `refine_magnetic_powder`; a magnetic
structure determination skill (M2 → M3 → M4) is planned.

### M5 — Ship the results 🚧

**Goal:** reproducible, publishable, machine-readable output.

**Done**
- Save and reopen a whole session as a project file
  ([PROJECT_FORMAT.md](./PROJECT_FORMAT.md)).
- Refined CIF with esds, and mCIF. For a commensurate k ≠ 0, the mCIF gives the
  magnetic supercell in that cell's own space group ([`cif.ts`](../src/core/export/cif.ts)).
- An HTML refinement report for every technique ([`report.ts`](../src/core/export/report.ts)).
- A FullProf and GSAS-II cross-check bundle with a CW or TOF `.pcr`
  ([`bundle.ts`](../src/core/export/bundle.ts)).

**Next**
1. `.pcr` export for single-crystal and multi-phase refinements.
2. Bond-length and angle tables in the report.
3. Agent tools for export, the report and project files.
4. Optional project fields for posterior samples and k-search exploration, if
   they prove worth saving.

**Validation gate**
- ✅ CIF and mCIF round-trip through the app's parsers ([`cif.test.ts`](../src/core/export/cif.test.ts)).
- ⬜ An external program, such as VESTA or GSAS-II, reads the exports.

**Tools:** none yet. `export_cif`, `generate_report`, `save_project` and
`load_project` are planned over the headless project codec
([`io.ts`](../src/core/project/io.ts)).

### M6 — Powder microstructure and texture 🚧

**Goal:** turn peak profiles into reportable crystallite size, microstrain and
texture.

**Done**
- Size and microstrain from the Lorentzian terms, with instrument deconvolution,
  esds and a Williamson–Hall fit ([`microstructure.ts`](../src/core/diffraction/microstructure.ts)).
- Generalized Stephens microstrain, with terms computed from the Laue group
  ([`anisoStrain.ts`](../src/core/diffraction/anisoStrain.ts)).
- Uniaxial microstrain on the powder page and uniaxial size in the core, a
  microstructure stage, and a size and strain readout on the powder page ([`anisoSize.ts`](../src/core/diffraction/anisoSize.ts)).
- March–Dollase texture, Debye–Scherrer absorption and surface roughness
  ([`intensity.ts`](../src/core/diffraction/intensity.ts)).

**Next**
1. Spherical-harmonic crystallite size.
2. A spherical-harmonic texture ODF beyond single-axis March–Dollase.
3. Microabsorption (Brindley) and flat-plate absorption.
4. A Williamson–Hall plot and anisotropic size and strain surfaces in the UI.
5. A powder-page control for uniaxial size, which exists in the core only.

**Validation gate**
- ✅ Scherrer and microstrain constants match GSAS-II
  ([`microstructure.test.ts`](../src/core/diffraction/microstructure.test.ts)).
- ⬜ A known size and strain are recovered from NIST LaB₆ 660.
- ⬜ March–Dollase and Stephens coefficients match GSAS-II on one pattern.

**Tools:** `build_refinement` picks the microstrain model and
`interpret_structure` reports size and microstrain; `extract_size_strain` and
`refine_texture` are planned.

### M7 — Single-crystal refinement 🚧

**Goal:** refine integrated single-crystal intensities with the same engine,
constraints and moment machinery as powder.

**Done**
- F² refinement from FullProf `.int` files and plain h k l I σ lists, with
  merging, extinction and outlier diagnostics
  ([`singleCrystalRefinement.ts`](../src/core/workflow/singleCrystalRefinement.ts)).
- A single-crystal page: load, merge report, refine, F_obs against F_calc.
- For a commensurate k, nuclear and magnetic files merge into the magnetic
  supercell and share one scale ([`magneticSupercell.ts`](../src/core/magnetic/magneticSupercell.ts)).
- An absorption core: neutron μ, crystal shape, transmission and face indexing
  ([`absorption/`](../src/core/absorption/)).

**Next**
1. Wire the SHELX HKLF 4 and `.fcf` readers into the page and the agent tool;
   today both formats go through the plain reader, which misreads them
   ([LIMITATIONS.md](./LIMITATIONS.md#single-crystal)).
2. Completeness against a generated unique reflection set.
3. Twinning (BASF), and anomalous dispersion for absolute structure.
4. SHELX WGHT a and b in the reported agreement, then iterative reweighting
   inside the solve.
5. An absorption UI and agent tool, then a multi-scan correction
   ([SINGLE_CRYSTAL.md](./SINGLE_CRYSTAL.md) §3).

**Validation gate**
- ✅ Scale and displaced-atom recovery drive wR2 and R1 to about zero
  ([`singleCrystalRefinement.test.ts`](../src/core/workflow/singleCrystalRefinement.test.ts)).
- ✅ The merged Eu₃In₂Te₄ supercell reflections equal FullProf's
  ([`magneticSupercell.test.ts`](../src/core/magnetic/magneticSupercell.test.ts)).
- ✅ Transmission factors track WinGX's once μ is fitted
  ([`eu324Absorption.test.ts`](../src/core/absorption/eu324Absorption.test.ts)).
- ⬜ A published F² refinement is reproduced within tolerance.
- ⬜ Results agree with SHELXL or GSAS-II on the same `.hkl` file.

**Tools:** `parse_single_crystal_data`, `write_single_crystal_data`,
`merge_magnetic_supercell`, `expand_structure_supercell` and
`build_modulated_moment_model`; `refine_single_crystal` and `correct_absorption`
are planned.

## 5. Agent tools, skills and LLM-guided refinement

The core is pure and JSON-serializable, so each workflow function can become an
agent tool as its milestone stabilizes. [AGENT_TOOLS.md](./AGENT_TOOLS.md) holds
the design and the generated tool list.

- **Tools:** an MCP server delivers them, and its registry doubles as the
  headless API. Agent SDK definitions and an in-app chat panel are options.
- **Skills:** a powder Rietveld skill ships
  ([SKILL.md](../.claude/skills/my-rietveld-workflow/SKILL.md)); a magnetic
  structure determination skill (M2 → M3 → M4) is planned.
- **Agent in the loop:** the LLM plans and sequences, and the LM engine does
  every numeric solve. `rank_next_parameters` (F1.5) is the first hook.
- **Tool rules:** tools are pure and deterministic, with JSON in and out. Each
  returns diagnostics, so an agent can reason about failure.

## 6. Sequencing and guardrails

**Order**
- F1 and F2 first, together; M1 proves them on real atomic data.
- M2, M3 and M4 in turn, each gating the next; M5 last, but threaded throughout.
- M6, M7 and the PDF/mPDF track in parallel, in the order real datasets need
  them.
- Tracks A and B independently, in the order set in
  [PLAN_SUBGROUPS_AND_INCOMMENSURATE.md](./PLAN_SUBGROUPS_AND_INCOMMENSURATE.md).
- Beyond this arc: structure solution by charge flipping, and (3+d)D superspace.

**GPU acceleration.** GPU kernels are approximate f32 accelerators, never
bit-identical to the f64 CPU path. Each is checked against that path on real
hardware ([VALIDATION.md](./VALIDATION.md#gpu-acceleration-precision)).

| Kernel | Status |
| --- | --- |
| Profile synthesis ([`gpuSynthesizer.ts`](../src/workers/gpuSynthesizer.ts)) | ✅ Validated; no refinement uses it |
| Nuclear structure factor ([`gpuStructureFactor.ts`](../src/workers/gpuStructureFactor.ts)) | ✅ In the refinement pool for flat single-phase powder fits, with CPU fallback |
| Magnetic structure factor ([`gpuMagneticStructureFactor.ts`](../src/workers/gpuMagneticStructureFactor.ts)) | 🚧 Validated; next, wire it into magnetic co-refinement |

WebAssembly is out of scope (§1); a GPU normal-equations solve is deferred.
Speed-ups are in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Every milestone ships with** passing tests (golden values where an external
reference exists), updated docs and a working app, with no broken intermediate
state. A capability counts as validated only when
[VALIDATION.md](./VALIDATION.md) records it, and
[LIMITATIONS.md](./LIMITATIONS.md) states the scope.

**Design rules**
- **Analytic derivatives are additive.** Kinds without a validated analytic
  column use finite differences; a new kind must match them in a gate test.
- **Randomness lives in the driver.** Samplers and restarts draw random numbers
  only in their driver, so serial and pooled runs match bit for bit.
- **Check k ≠ 0 against the supercell.** Gate k ≠ 0 conventions with a
  brute-force supercell sum; round-trip tests missed three errors it caught.
- **Compare intensities before profiles.** When a fit trails a reference
  program, compare per-reflection |F|² first. The GaNb₄Se₈ gap came from |F|²
  and Lorentz-factor errors, not the profile.
- **Match Wyckoff positions by orbit.** A site belongs to a position when a
  symmetry image lies on its locus. Stabilizer conjugacy fails, because
  inversion fixes both (0,0,0) and (0,0,½) modulo the lattice.
