# Validation

Validation is mandatory. This page records the evidence: what is tested, and
what is checked against external tools. Every correctness claim must trace to a
test or a comparison recorded here. What is only approximate is listed in
[LIMITATIONS.md](./LIMITATIONS.md).

## Principles

1. Every scientific function in `src/core` has unit tests.
2. Key calculators have **golden-value** tests: a known input gives a recorded
   output, and the test fails if the number changes, so nothing drifts silently.
3. Selected end-to-end examples are compared with established tools where
   feasible: GSAS-II, FullProf, PDFfit2, diffpy.mpdf and WinGX. Agreement and
   tolerances are recorded below.
4. The docs state plainly which features are *validated* and which are
   *approximate*.

> GSAS-II is the primary external reference for the golden-value and benchmark
> tests below: Toby & Von Dreele (2013), *J. Appl. Cryst.* **46**, 544
> ([10.1107/S0021889813003531](https://doi.org/10.1107/S0021889813003531)). We
> reimplement independently and copy no code, but its outputs are our
> correctness gate and must be cited. The full bibliography is in
> [`REFERENCES.md`](./REFERENCES.md).

## Test matrix

Run `npm test` for the current counts. Tests that read the git-ignored `data/`
folder skip when it is absent (CI, fresh clones).

| Area | Test kind | Status |
| --- | --- | --- |
| ProjectFile round-trip, per-technique validation (foreign-data refusal, id integrity), v1→v2 migration, readable serializer | unit | ✅ `core/project/project.test.ts`, `core/project/serialize.test.ts`, `app/projectIo.test.ts` |
| CIF parsing (cell, symmetry, sites) | unit + golden | ✅ `parsers/cif.test.ts` |
| Powder/reflection numeric parsing (esd) | unit | ✅ `parsers/cif.test.ts` |
| Reciprocal metric tensor / volume | golden (GSAS) | ✅ `core/crystal/unitCell.test.ts` |
| d-spacing / \|Q\| consistency | unit | ✅ `core/crystal/unitCell.test.ts` |
| Symmetry-op parsing & application | unit | ✅ `core/crystal/symmetry.test.ts` |
| Site multiplicity | golden (GSAS) | ✅ `core/crystal/symmetry.test.ts` |
| Systematic absences | unit | ✅ `core/crystal/symmetry.test.ts` |
| Neutron b / X-ray f / magnetic j0 | golden (GSAS) | ✅ `core/scattering/scattering.test.ts` |
| Nuclear structure factor `F_N` | analytic golden | ✅ `core/diffraction/structureFactor.test.ts` |
| Reflection generation + multiplicity | golden | ✅ `core/diffraction/reflections.test.ts` |
| Residual & agreement factors | unit | ✅ (via engine tests) |
| Optimizer behavior (LM convergence) | unit | ✅ `core/refinement/engine.test.ts` |
| Constraint tie parsing/resolution | unit | ✅ `core/refinement/engine.test.ts` |
| Linear algebra (solve/invert) | unit | ✅ `core/math/linalg.test.ts` |
| Magnetic perpendicular-moment projection | unit | ✅ `core/magnetic/magnetic.test.ts` |
| Q / moment frame conversion | unit | ✅ `core/magnetic/magnetic.test.ts` |
| Single-crystal + powder workflow refinement | integration (GSAS structure) | ✅ `core/workflow/workflow.test.ts` |
| Magnetic CIF (mCIF) parsing + BNS ops | golden (GSAS) | ✅ `parsers/magneticCif.test.ts` |
| Magnetic moment magnitudes | golden (GSAS `.lst`) | ✅ `parsers/magneticCif.test.ts` |
| GSAS reflection-list (Fo²/Fc²) parsing | golden | ✅ `parsers/magneticCif.test.ts` |
| GSAS `.gsa` powder histogram (BANK/SLOG/FXYE) | unit + real POWGEN files | ✅ `parsers/gsasHistogram.test.ts` |
| FullProf `.int` single-crystal reflections (fixed-width) | unit | ✅ `parsers/fullprofInt.test.ts` |
| FullProf `.irf` + `INSTRM=6` (D2B/3T2/G4.2) instrument files | unit | ✅ `parsers/fullprofInstrm6.test.ts` |
| Classic GSAS `.prm` (INS/ICONS/PRCF, CW + TOF) instrument files | unit | ✅ `parsers/instrument.test.ts` |
| ILL powder / numor + format auto-detection | unit | ✅ `parsers/illPowder.test.ts`, `parsers/detectFormat.test.ts` |
| Magnetic single-crystal workflow + moment refinement | integration (GSAS structure) | ✅ `core/workflow/magneticWorkflow.test.ts` |
| Magnetic candidate generation (k=0 index-2 subgroups) | golden (P2₁/m → P2₁'/m') | ✅ `core/magnetic/magneticGroups.test.ts` |
| Allowed moment directions per site | golden (a–c plane) | ✅ `core/magnetic/magneticGroups.test.ts` |
| Candidate comparison ranks correct group best | integration (30 K) | ✅ `core/workflow/magneticCompare.test.ts` |
| k-search recovers k=(½,0,0) (AWO₄ P2/c cell) | unit | ✅ `core/magnetic/kSearch.test.ts` |
| k-search recovers k=(½,0,0) from **real** AWO₄ 6 K neutron data | integration (real POWGEN) | ✅ `core/workflow/realAwo4Magnetic.test.ts` |
| Antiferromagnetic \|F_M\|² ≠ 0 (magnetic-op orbit expansion, k≠0) | golden (Mn₃Ga 6h) | ✅ `core/magnetic/afmStructureFactor.test.ts` |
| Abelian little-group irreps + Γ_mag decomposition + mode projection | golden (P1/C2/Ci/D2/C4) | ✅ `core/magnetic/irreps.test.ts` |
| Mode amplitudes recovered from a model's moments (open-on-model, demo seeding) | round trip + the 30 K mCIF | ✅ `core/magnetic/amplitudeFit.test.ts` |
| Local AWO₄ 6 K magnetic demo — k = (½,0,0), P2/c′ is a maximal lattice candidate, session reopens at the solved wR | data-gated (git-ignored data/) | ✅ `examples/awo4Magnetic.test.ts`; provenance `examples/awo4MagneticSolve.test.ts` (AWO4_SOLVE=1) |
| Moment-size restraint → physical magnitudes | integration | ✅ `core/workflow/magneticCompare.test.ts` |
| TOF ↔ d conversion (POWGEN calibration) | golden (GSAS `.lst`) | ✅ `core/diffraction/instrument.test.ts` |
| Instrument-file parsing | unit | ✅ `core/diffraction/instrument.test.ts` |
| Anisotropic ADP (reduces to isotropic) | unit | ✅ `core/diffraction/features.test.ts` |
| March-Dollase preferred orientation | unit | ✅ `core/diffraction/features.test.ts` |
| Multi-phase powder (2-phase recovery) | integration | ✅ `core/workflow/multiPhase.test.ts` |
| Le Bail extraction (pattern reconstruction; an isolated peak gets its net area in one cycle) | integration | ✅ `core/workflow/leBail.test.ts` |
| Le Bail TOF peak widths (α, β₀, σ₂²) recovered from an engine-simulated TOF pattern | self-consistent | ✅ `core/workflow/leBailPrefit.test.ts` |
| Cell / space-group gate: a wrong centring or lattice is caught at constant wavelength and on TOF; on real Mn₃Ga POWGEN 600 K data the only leftover lines are MnO's, and the gate passes once MnO is named | synthetic + integration (committed data) | ✅ `mcp/cellSymmetry.test.ts` |
| Magnetic powder (separable components + refine) | integration | ✅ `core/workflow/magneticPowder.test.ts` |
| k≠0 Fourier structure factor (SDW/helix) + amplitude recovery | unit + self-consistent | ✅ `core/magnetic/fourierMoment.test.ts` |
| Two-arm (incommensurate-type) modulation: k-formalism ≡ brute-force real-space supercell sum — k = ¼ (both θ), ⅓ (P3₁ screw), 3/10, self-conjugate ½; ½ two-arm factor; −k conjugation; gauge invariance; symmetry-forced K-point helix | **convention-free oracle** | ✅ `core/magnetic/fourierModulation.test.ts` |
| Satellite Laue-family multiplicities (self-conjugate k listed once; off-axis star expanded) vs brute-force position count | unit | ✅ `core/magnetic/fourierModulation.test.ts` |
| Helix (cos ∥ a, sin ∥ b) recovered through the powder workflow; single-crystal satellite rows carry no nuclear term | integration | ✅ `core/workflow/fourierPowder.test.ts` |
| Grouped (equal-value) constraints | unit | ✅ `core/refinement/engine.test.ts` |
| Real 200 K/350 K CIF + reflection lists | golden (GSAS d-spacings) | ✅ `parsers/realData.test.ts` |
| Plot scaling math | unit | ✅ `visualization/scale.test.ts` |
| Parallel-Jacobian pool ≡ serial (bit-identical trajectory) | unit | ✅ `core/refinement/engineParallel.test.ts` |
| Analytic Jacobian columns (occupancy, B_iso) vs central FD | unit (F1.1) | ✅ `core/workflow/analyticJacobian.test.ts` |
| Staged controller guards (re-fix degenerate additions) | unit (F1.4) | ✅ `core/refinement/stagedGuards.test.ts` |
| Robust starting values (envelope background + zero sanity) | unit (F1.3) | ✅ `core/workflow/startingValues.test.ts` |
| Next-parameter sensitivity ranking | unit (F1.5) | ✅ `core/workflow/nextParameters.test.ts` |
| GPU \|F\|²-injection seam is bit-identical to the CPU sum | unit | ✅ `core/workflow/structureFactorInjection.test.ts` |
| GPU nuclear kernel: WGSL strides + f64 formula ≡ CPU `F_N` | unit (CI) | ✅ `workers/gpuStructureFactor.test.ts` |
| GPU magnetic kernel: WGSL strides + f64 formula ≡ CPU `F_M` | unit (CI) | ✅ `workers/gpuMagneticStructureFactor.test.ts` |
| GPU batch evaluator plumbing (grouping/order/injection) | unit | ✅ `workers/gpuPowderEvaluator.test.ts` |
| Ensemble MCMC: exact linear-Gaussian posterior, flat-posterior measure, serial ≡ pool bit-identical, resume token | unit | ✅ `core/refinement/bayes/sampler.test.ts` |
| Bounded-parameter transforms (logit/log round-trip + logJacobian vs FD) | unit | ✅ `core/refinement/bayes/transform.test.ts` |
| PDF posterior std vs LM esd (esdRatio ≈ 1), ensemble AND NUTS | golden (PDFfit2 Ni fixture) | ✅ `core/workflow/pdfPosterior.test.ts` |
| NUTS: exact linear-Gaussian posterior, flat-measure, determinism/resume, divergence reporting | unit | ✅ `core/refinement/bayes/nuts.test.ts` |
| PDF analytic ∂G/∂p columns vs central FD + `gradChi2` | unit (F1.1) | ✅ `core/workflow/pdfAnalyticJacobian.test.ts` |
| Powder validation: Rp/Rwp/Rexp and background-subtracted set vs direct sums, Durbin–Watson (white noise ≈ 2, Hill & Flack Q_D), cumulative χ², d-shells, per-phase R_Bragg/R_F, unindexed peaks | unit | ✅ `core/diagnostics/powderValidation.test.ts` |
| χ² attribution per reflection: an under-calculated peak ranks first as "under"; a shifted pattern reads as "shape" | unit | ✅ `core/workflow/obsCalc.test.ts` |
| Single-crystal validation: completeness (incl. accidental d coincidences), shells, K/GooF bins, extinction signature, R_int with redundancy | unit | ✅ `core/diagnostics/singleCrystalValidation.test.ts` |
| Validation verdict checks (powder and single crystal) | unit | ✅ `core/diagnostics/validationChecks.test.ts` |

## Golden examples

A golden test pins a recorded expected output and names its source of truth: an
analytic value, a hand calculation, or an external-tool run. Updating a golden
value requires an explicit, reviewed change — it cannot happen silently.

Golden inputs live in two places:
- **Committed fixtures** run everywhere, including CI — for example the PDFfit2
  curves in `core/pdf/pdffit2Golden.ts` and the diffpy.mpdf curves in
  `core/magnetic/mpdfGolden.ts` and `mnoGolden.ts`.
- **Real measured data** in the git-ignored `data/` folder (GSAS-II, FullProf
  and WinGX outputs), read through `src/testSupport`; these tests skip when
  the folder is absent.

## External comparisons

Each row records the quantity, our value, the reference value, the tolerance
we accept and the source. The main source is a two-phase (Mn₃Ga + MnO) TOF
neutron powder Rietveld refinement in GSAS-II. Its output sits in the
git-ignored `data/` folder (`isothermal_hex/Untitled.lst` and the CIFs).

| Quantity | Our value | GSAS-II value | Tolerance | Source |
| --- | --- | --- | --- | --- |
| Mn₃Ga cell volume | 110.759 Å³ | 110.759 Å³ | 1e-2 | `.lst` |
| MnO cell volume | 88.130 Å³ | 88.130 Å³ | 1e-2 | `.lst` |
| Mn₃Ga recip. tensor A11 | 0.0455025 | 0.045502499 | 1e-6 | `.lst` |
| Mn₃Ga recip. tensor A33 | 0.0524937 | 0.052493673 | 1e-6 | `.lst` |
| MnO recip. tensor A11 | 0.0504953 | 0.050495334 | 1e-6 | `.lst` |
| Mn₃Ga Mn1 multiplicity | 6 | 6 (Wyckoff 6h) | exact | `.lst` |
| Mn₃Ga Ga1 multiplicity | 2 | 2 (Wyckoff 2d) | exact | `.lst` |
| Neutron b (Mn / O / Ga) | −3.73 / 5.80 / 7.29 | −3.75 / 5.81 / 7.29 fm | 2e-2 | `.lst` |
| X-ray f(0) (Mn / O / Ga) | 25.0 / 8.0 / 31.0 | Z = 25 / 8 / 31 | 0.1 | Cromer-Mann |
| CIF cell (600 K Mn₃Ga) | a=5.42215, c=4.37566 | file values | 1e-5 | CIF |
| CIF cell (393 K refined) | a=5.41317, c=4.36462 | file values | 1e-5 | CIF |
| Magnetic moment \|M\| Mn1 (30 K) | 2.527 μB | 2.527 μB | 1e-2 | `30K/.lst` |
| Magnetic moment \|M\| Mn2 (30 K) | 2.829 μB | 2.829 μB | 1e-2 | `30K/.lst` |
| Magnetic moment \|M\| Mn3 (30 K) | 2.530 μB | 2.530 μB | 1e-2 | `30K/.lst` |
| BNS group / ops (30 K, 350 K) | P2₁'/m' 4 / Cm'cm' 16 | mCIF | exact | mCIF |

The moment magnitudes are a particularly strong check. The components are given
along the crystal axes of a monoclinic cell (β = 60.69°). Reproducing GSAS-II's
magnitudes therefore confirms both the mCIF parse and the normalized-axis metric
in `momentCartesian`.

The 200 K reflection list (`fitted_results_Cmcm_hkl.dat`) contains both phases.
Its cubic MnO subset satisfies d·√(h²+k²+l²) = 4.438 Å, and our `dSpacing()`
reproduces GSAS-II's listed d-spacings for those reflections to < 2×10⁻³ Å.

**Scope note.** The table above pins the *crystallographic and scattering
foundations* against this Mn₃Ga refinement. It does not compare the fit itself;
the whole-fit and whole-workflow comparisons are in the next table.

### Fits and workflows checked against external tools

"Gate" is what the test asserts; where a run measured more than that, the
measured value is given too. Tests marked *data* read the git-ignored `data/`
folder.

| Reference | Case | Compared | Result | Test |
| --- | --- | --- | --- | --- |
| GSAS-II | GaNb₄Se₈ 298.8 K synchrotron XRD (28-ID) | wR of our staged Rietveld fit vs GSAS-II's fit of the same data | 5.7% vs GSAS-II's 7.34% (gate: < 12%) | `core/workflow/realPowderXRD.test.ts` · *data* |
| GSAS-II | Mn₃Ga 350 K, POWGEN neutron | \|F_M\|² per reflection at GSAS-II's refined moments | all 82 reflections within ±5%; symmetry-forbidden ones ≈ 0 | `core/workflow/mn3ga350KGolden.test.ts` · *data* |
| PDFfit2 1.6.0 | Ni and MnO X-ray G(r) | G_calc(r); cell, scale and ADPs refined from a perturbed start | corr ≈ 0.9998 (gate > 0.999); cell within 2 mÅ | `core/pdf/pdffit2Golden.test.ts` |
| diffpy.mpdf | MnO, MAGNDATA 1.31 (32-Mn magnetic cell) | f(r) and D(r) for a fixed spin configuration | f(r) to 1e-11 of the peak away from r = 0; D(r) corr > 0.9999, κ within 0.5% | `core/magnetic/mnoGolden.test.ts` |
| diffpy.mpdf tutorials | MnO and MnTe measured neutron PDFs | refined ordered scale (MnO); nuclear + magnetic co-refinement (MnTe) | MnO ordered scale 1.6716 vs diffpy's 1.6685 | `core/workflow/mpdfTutorialData.test.ts` · *data* |
| WinGX | Eu₃In₂Te₄ rod crystal, neutron λ = 1.0 Å | per-reflection absorption transmission factor | Pearson r ≈ 0.99 with a fitted μ (gate > 0.95) | `core/absorption/eu324Absorption.test.ts` · *data* |
| FullProf files | Eu₃In₂Te₄ HB-3A `_nuc` / `_mag` → `_ALL_magcell.int` | the merged magnetic-supercell reflection list | identical on every (h, k, l, I, σ) | `core/magnetic/magneticSupercell.test.ts` · *data* |
| FullProf | DyMn₆Ge₆ 11 K, PSI DMC neutron (λ = 1.7037 Å), incommensurate conical spiral | refined k = (0, 0, γ) from starts at 0.155 and 0.175, FullProf's cell/profile/background held | γ = 0.16478(67) and 0.16486(67) vs FullProf's 0.16509(43) (gate: within 2σ of FullProf); the cone's k = 0 component is not modelled, so wR 19.9% vs FullProf's 11.3% | `core/workflow/dymn6ge6K.test.ts` · *data* |

## Bayesian posterior sampling

The samplers in `core/refinement/bayes/` are validated on three levels before
any posterior is trusted. How they work is in
[REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md#posterior-sampling).

1. **Exact-posterior recovery.** On a linear-Gaussian problem the posterior is
   known in closed form. The ensemble sampler recovers the exact mean within
   0.1σ, the std within 15% and the pairwise correlation within ±0.05. NUTS
   recovers the mean within 0.12σ, the std within 10% and the correlation within
   ±0.05 on a ρ ≈ −0.998 ridge, with no divergences. The `poisson` model recovers
   an exact Gamma posterior, and `studentT` resists outliers that bias the
   Gaussian posterior.
2. **Measure and structural invariants.** Both samplers draw a flat posterior
   uniformly inside bounds, which pins the transform's `logJacobian` measure term
   end to end. Serial and worker-pool ensemble drivers produce bit-identical
   chains, because the RNG lives only in the sans-io generator. A 400-step
   ensemble run equals 200 + 200 steps through the resume token (NUTS: 200 draws
   equal 100 + 100), and the same seed reproduces while a different seed differs.
3. **Gaussian-limit consistency with LM (Ni golden).** Sampling the PDFfit2 Ni
   fixture around the converged LM minimum gives an `esdRatio` (posterior std
   over linearized LM esd) of 0.99–1.01 per parameter with the ensemble sampler.
   With NUTS it is 0.95–0.98. The test gate is 0.7–1.4, with the posterior
   median within 0.25 esd of the LM value. The sampler and the least-squares
   esds thus validate each other where both must agree.

The exact-posterior gates use the `fixed` likelihood. The Ni golden uses the
default `marginalized` likelihood, because reduced PDF data carry correlated
point errors and are fitted with unit weights ([LIMITATIONS.md](./LIMITATIONS.md)).
Convergence is reported as McCluskey et al. (2023, *J. Appl. Cryst.* **56**, 12)
advise: split-R̂, ESS and quantile credible intervals, never a bare std.

## PDF analytic gradients

[`pdfAnalyticJacobian.test.ts`](../src/core/workflow/pdfAnalyticJacobian.test.ts)
gates the fused-pass gradient kernel (`core/pdf/gradients.ts`):

- The fused value curve is **bit-identical** to `computeGofR` on the Ni golden.
- Every analytic ∂G/∂p column matches a central finite difference within 1e-5
  of the column's maximum, with termination off. This covers envelopes, widths,
  occupancy, B_iso, U_aniso and symmetry-mode position shifts, including orbit
  images under rotated operations. A smoke check repeats U_aniso with
  termination on, at 2e-2.
- Unsupported kinds (`cell`, `sratio`/`rcut`, tie-referenced parameters) return
  null and fall back to finite differences. Restraint rows carry the term
  coefficients.
- `refineParallel` never calls `analyticColumns`.
- Finite-difference and analytic refinements land in the **same basin** on the
  Ni golden: Rw within 1e-4 and parameters within 1e-6 relative. The analytic
  run is 2.3× faster.
- The scalar `gradChi2` (analytic columns plus central-difference fill-in)
  matches central differences of χ².

**FD-oracle caveat.** The ±5σ evaluation window is quantized on the r grid. So
the finite-difference oracle, not the analytic column, shows 1/h spikes when a
pair crosses a window edge, and the Qmax band limit spreads those spikes across
the grid. The gates therefore compare only points where FD(h) and FD(h/2) agree,
a Richardson consistency filter. Excluded points must stay below 2%, and the
tight tolerances run with termination off.

## GPU acceleration precision

The WebGPU kernels compute in f32, so they are approximate accelerators and
never bit-identical to the CPU path ([LIMITATIONS.md](./LIMITATIONS.md)). The
nuclear structure-factor kernel is the one the app requests by default where an
adapter exists, so this contract is what a default fit relies on; the header's
GPU chip turns it off. Their reference is the f64 CPU path, itself validated
above against GSAS-II. Two gates
enforce the precision contract before a refinement trusts a GPU value:

1. **CI (Node, no GPU).** The WGSL struct field counts must equal the JS
   marshaling strides. The kernel's formula, reimplemented in f64, must
   reproduce the CPU structure factor to a relative `< 1e-9`. Together these
   catch marshaling and stride drift without hardware.
2. **Hardware (browser).** The real kernel runs against the CPU f64 truth. The
   rows below come from `window.__gpuValidate`, a dev-build harness. Maximum
   relative deviation, measured on an Apple GPU (metal-3):

| Kernel | Case | Max rel. deviation |
| --- | --- | --- |
| Nuclear \|F_N\|² | Mn₃Ga neutron, isotropic ADP | 3.9e-7 |
| Nuclear \|F_N\|² | Mn₃Ga X-ray, isotropic ADP | 7.9e-8 |
| Nuclear \|F_N\|² | Mn₃Ga neutron, anisotropic ADP | 5.0e-7 |
| Nuclear \|F_N\|² | 8-model perturbed batch | 4.7e-7 |
| Magnetic \|F_M\|² | Mn₃Ga AFM k=(½,0,0), 175 satellites | 4.5e-7 |

All are far below counting statistics and esd scales (≥ 1e-3 relative). End to
end, a GPU-accelerated powder refinement converges to the *same minimum* as the
CPU pool: both reach wR 5.00% on a Mn₃Ga occupancy + ADP fit. The f32 |F|²
nudges the LM path but not the answer.

## Researcher rounds

In ten researcher rounds a crystallographer
put the Agent through an analysis end to end, and what it got wrong or could
not do was fixed:

| Round | Data | What it led to |
| --- | --- | --- |
| 1 | Mn₃Ga + MnO, POWGEN neutron TOF | residual peaks judged against each point's σ; misfits on known reflections kept apart from extra peaks |
| 2 | Mn₃Ga, CW neutrons, loaded from files | a cell check that holds on a 5–130° scan |
| 3 | GaTa₄Se₈, X-ray PDF | boxcar scans for local-versus-average questions |
| 4 | Mn₃Ga with an unannounced MnO impurity (simulated lab X-ray) | phase fractions with esds: 3.7 wt % read back as 3.65(8) |
| 5 | MgAl₂O₄ with 22 % inversion, from a normal-spinel CIF (simulated) | occupancy restraints in the fit; hold composition |
| 6 | PbSO₄, D1A neutrons (GSAS-II tutorial) | `diagnose_fit`, which found the missing peak asymmetry: wR 12 → 3.7 % |
| 7 | Fluorapatite, lab Cu Kα (GSAS-II tutorial) | the Kα₂ doublet and the polarization; the cell to 1 part in 10⁵ of GSAS's |
| 8 | Cr₂WO₆, neutrons at 150 K and 4 K | `identify_peaks`, `tie_parameters`, bond valences, the Bayesian check, d with the zero shift taken out, k = 0 found on wide lines, the moments kept through a settings change; in-plane moments, 2.28(2) µB in Pn′nm |
| 9 | LaMnO₃, NPDF neutron PDF (PDFgui tutorial) | PDFgetN files read as neutron data, and only their data; the PDF page's ADP model; bond lengths box by box in the boxcar scan and in the report; the Jahn–Teller distortion holds from the first box (1.5–6.5 Å) to the last |
| 10 | NAC (Na₂Ca₃Al₂F₁₄), 11-BM synchrotron | fluorite found and added as a known phase (1.448(6) wt %); the instrument file's asymmetry read; size, strain and phase fractions in the report; the 2009 profile ~¼ too broad in its Gaussian part, the sample adding next to nothing |

## Does the Agent help?

The agent evals ([AGENT_EVALS.md](./AGENT_EVALS.md)) check that the Agent does what a
failure once taught it. They do not say whether it helps: a model can pass every
scripted check and still reach a worse answer than the app alone. This section
is the protocol for that question. It compares the Agent with the app
without it, on cases with a known answer, scored by fixed rules. The code is in
[`src/agent/validation/`](../src/agent/validation/).

### Arms

| Arm | What runs | Model |
| --- | --- | --- |
| **A** | The app without the Agent, as a newcomer drives it: free every parameter, press Refine until wR settles (three presses at most), read the Validation tab's verdict. The verdict is arm A's conclusion. | none |
| **B** | The Agent as it ships: skills, guardrails (the executor's firm rules, the correlation guard), auto mode. | each model below |
| **C** | Ablation: B without the skills. The model sees no skill index, no `read_skill` and no written method: no stage checklist in `get_state`, no method named in a refusal, a nudge or the report, and on a local model every tool of the page rather than the stage's. Changes do not wait for a method to be read. The guardrails stay (the firm rules, the correlation guard, and the symmetry review only on a converged fit), so C measures what the skills add. Both prompts are built from one list, and a test reads every request of a scripted arm-C session for a trace of the method. | each model below |
| **D** | The truth: the structure each pattern was simulated from, or a published refinement. | — |

Every arm sees the same page, built from the same seed. B and C get the same
message, which names no fault: *"Refine this pattern against the loaded
structure and report the result. Tell me if anything about the data or the
model looks wrong."* The stand-in user approves every change and approves
adding a phase the Agent proposes. It declines lifting a firm rule and setting
an instrument's constants, which are the user's decisions.

### Cases

The **test set** is held out and gives the reported numbers. Its structures
(rutile, calcite, ZnO, NiAl) appear, by name, formula or common synonym, in
no skill or knowledge note, no file under `src/agent` but the validation's own,
and no source file that ships (the MCP tools, the diagnostics, the known-phase
library, the app), and a test enforces that. The **dev set** is where tools and
skills may be improved: the eval pages the researcher rounds left, Example 3,
and a dev analog of each test fault.

All patterns are constant-wavelength neutron data simulated by the engine:
λ 1.54 Å, Example 3's instrument file, 10–130° 2θ in 0.05° steps, 20,000 counts
at the strongest peak, a 300-count background, and seeded counting noise. The
page opens on a "literature CIF" that can differ from the sample.

| Case | Split | What is wrong | The answer |
| --- | --- | --- | --- |
| `rutile-start-off` | test | nothing; the CIF is an older cell (−0.2 %), O is 0.02 Å off, B values are guessed | a, c, O x, B(Ti), B(O) |
| `calcite-start-off` | test | nothing; the cell is 0.1 % small, O x is at ¼, B values are guessed | a, c, O x, three B |
| `zno-wrong-wavelength` | test | λ given as 1.5554 Å; the data were measured at 1.54 Å | name the wavelength |
| `rutile-swapped-units` | test | the x column holds d (Å) and was read as 2θ | name the axis |
| `nial-wrong-centring` | test | ordered B2 NiAl (Pm-3m) offered a disordered bcc model (Im-3m) | name the centring or ordering |
| `zno-nacl-impurity` | test | 4.0 wt % NaCl not in the model | name NaCl or add it; ZnO a, c, B; NaCl 4.0 wt % |
| `calcite-unknown-line` | test | one line at d = 3.42 Å that no phase, known phase included, explains | report the line by its d; calcite values |
| `rutile-cell-strained` | test | the CIF cell differs anisotropically (a −1.2 %, c +0.8 %), which no wavelength error can do; a fit from it falls into a false minimum | a, c, O x, B; GoF ≤ 1.5 |
| `dev-mn3ga-misfit` | dev | the demo from a start off in ADPs, the Mn position and the width | the demo's values |
| `dev-mn3ga-fluorite` | dev | CaF₂ lines (round 10) | name fluorite |
| `dev-mn3ga-wrong-wavelength` | dev | λ 1.556 Å given | name the wavelength |
| `dev-mn3ga-swapped-units` | dev | d loaded as 2θ | name the axis |
| `dev-example3-magnetic` | dev | magnetic order at k = 0 (Example 3) | name P2₁'/m' |
| `dev-mn3ga-impurity-line` | dev | one line of an unknown phase | report the line |
| `dev-cscl-wrong-centring` | dev | CsCl offered Im-3m (the cell check's own development case) | name the centring |
| `dev-mn3ga-cell-strained` | dev | the demo opened on a strained cell | a, c; GoF ≤ 1.5 |
| `pbso4-d1a` | dev | public data with a published refinement (GSAS-II tutorial; Hill 1992); runs where `data/validation/pbso4-d1a/case.json` holds the files and the published values | the published values |

The structures come from Burdett et al. (1987, rutile), Maslen et al. (1995,
calcite) and Kisi & Elcombe (1989, ZnO). NiAl is B2 with a = 2.887 Å, and
b(Ni) = 10.3 fm against b(Al) = 3.45 fm gives strong superstructure lines. The
NaCl cell is the known-phase library's. No unpublished or user data are
committed. Public data with a published refinement join the dev set through
`data/validation/<id>/case.json`, which lists the files and the published
values. The data themselves stay out of git.

### Scoring, fixed before any run

`scoring.ts` reads every arm the same way: arm A's verdict and the Agent's
replies and reports go through the same functions. The tolerances live in
`cases.ts`, and a test pins them, so a change is a reviewed edit.

| Quantity | Tolerance | Why |
| --- | --- | --- |
| cell length | 2 × 10⁻⁴ relative | what a calibrated CW instrument gives (λ known to ~10⁻⁴); a 1 % wavelength error is 50× this |
| atom position | 0.01 Å from the truth, nearest image | bonds are quoted to 0.01 Å; 0.01 Å moves a bond valence by < 3 % (b = 0.37 Å, Brese & O'Keeffe 1991) |
| B_iso | 0.25 Å² | careful refinements of the same data scatter by a few tenths (the PbSO₄ round robin, Hill 1992) |
| minor phase | 1.0 wt % absolute | the quantitative-phase-analysis round robin (Madsen et al. 2001) |
| a good fit | GoF ≤ 1.5 | a correct model on counting noise gives GoF ≈ 1; 1.5 is the edge of `assess_refinement`'s "excellent" band (Toby 2006) |
| a reported line | d within 0.5 % | a few line widths at mid angle |

For each run:

- **Recovery:** every truth value is within its tolerance. A fault that only the
  user can fix (a wavelength, an axis, a model's space group) leaves nothing
  to recover.
- **Fault named:** a sentence names the fault and says something is wrong with
  it. A sentence that denies it, or that only plans to look, does not count.
  An impurity also counts as named when its phase is added. An unknown line
  counts when the run gives its d.
- **False alarms:** a fault asserted that the case does not have. Lines no
  reflection explains are a symptom of every injected fault, so reporting them
  is not a false alarm on a faulty case; naming the wrong cause is.
- **Conclusion right:** the values are recovered, the fault is named, there is
  no false alarm, and the fit is good where a correct model must give one.
- **Unsafe outcomes (bar 0):**
  - a final fit with a direction the data cannot determine, its values kept;
  - a negative B or an occupancy outside 0–1, kept;
  - a number in a report that the engine did not give;
  - a phase added that the sample does not hold;
  - a fit window that keeps under 75 % of the pattern.
- **Reproducibility, over 3 runs:** every run reaches the same conclusion, and
  each recovered value's spread is within its tolerance.

The fault reading is sentence-level text matching. It is deliberately simple,
the same for every arm, and each verdict quotes the sentence it rests on, so a
reviewer can overrule it from the transcript.

### What every run keeps

`saveRecord` writes each run as JSON, which can be scored again for free, and as
a self-contained Markdown transcript that a reviewer can read offline. The
transcript holds:

- the case, its injected fault and the message;
- the run policy it ran under (see below);
- each decision: the tool, its input, the Agent's words before the call, and
  what came back;
- each reference the Agent wrote (`{{wR}}`, `{{p:…}}`) with the engine value
  the app filled it with, and the reply as the model wrote it beside the
  reply as the app shows it;
- each number the Agent wrote itself, traced to the tool output it rounds from,
  or marked **untraced**;
- the reports, the score with the truth table, and the run's flags (turn cap,
  loop stop, chat error, prompt cut).

Runs are never retried or dropped. A run that fails stays in the table.

**Findings.** A reviewer, whether the supervisor model or a person, files
findings in the schema in `findings.ts`:
`{case, run, step, kind: bug | missing-tool | skill-gap | orchestration | science-error, evidence: {refs, numbers}, proposed_fix, needs_user_approval}`.
The rules are checked in code:

- A new tool or a skill change always needs the user's approval.
- A bug is fixed with a test and merged on green CI.
- A finding on a test-set run proposes nothing until the same failure is
  reproduced on a dev case (`reproduced_on`). This is what keeps the test set
  held out.

### Arm A: the bar

Arm A ran at the commit that added this section, three runs per case. It is
deterministic: the three runs agree exactly. A CI test pins these results
(`validation.test.ts`).

| Case | Recovered | Fault named | False alarm | GoF | Unsafe | Conclusion |
| --- | --- | --- | --- | --- | --- | --- |
| `rutile-start-off` | 6/6 | — | — | 1.02 | 1 | right |
| `calcite-start-off` | 8/8 | — | — | 1.02 | 1 | right |
| `zno-wrong-wavelength` | — | no | — | 3.71 | 1 | **wrong** |
| `rutile-swapped-units` | — | no | impurity | 12.73 | 1 | **wrong** |
| `nial-wrong-centring` | — | no | impurity | 4.27 | 1 | **wrong** |
| `zno-nacl-impurity` | 4/5 | no | — | 3.61 | 1 | **wrong** |
| `calcite-unknown-line` | 8/8 | yes (d 3.423 Å) | — | 1.43 | 1 | right |
| `rutile-cell-strained` | 6/6 | — | — | 3.17 | 1 | **wrong** |
| **test set** | | | | | **8 of 8 runs** | **3 of 8 right** |

On the dev set, arm A is right on `dev-mn3ga-misfit` and `dev-mn3ga-impurity-line`
and wrong on the other six available cases.

Where the default workflow fails, and so where the Agent has room to help:

- **Every run leaves values the data cannot determine.** Freeing everything
  frees the occupancies with the scale. The verdict says "the data cannot
  separate scale, O1 occ, Ti1 occ — fix or tie one", and a newcomer keeps the
  values anyway. On the faulty cases the profile terms (U, V, W) also go
  undetermined. This is why every run counts one unsafe outcome. The Agent's
  guardrails refuse a bare occupancy, so arm B starts with an advantage here
  that comes from the rules, not the model. Arm C keeps the same rules.
- **A wrong wavelength passes unnoticed.** The cell absorbs it
  (a = 3.282 Å against 3.2496 Å, 1 % long), the fit is merely "fair" (GoF 3.7),
  and nothing on screen mentions the wavelength.
- **Swapped units and a wrong centring are misdiagnosed.** The Validation
  tab's only explanation for lines no reflection explains is "a missing phase
  or an impurity?". On d-spacings read as 2θ, and on NiAl's h + k + l odd
  lines, that points at the wrong cause.
- **A known impurity is flagged but not identified.** The tab lists six
  unindexed peaks. NaCl's 200 line is at d 1.993 Å. The phase is never named
  or added, so there is no weight fraction.
- **A false minimum is kept.** From the strained cell, Refine reaches the
  right cell (a within 4 × 10⁻⁵), but the profile absorbs the early misfit:
  wR 14.3 %, GoF 3.17, against 4.6 % and 1.02 from a good start. The app's own
  Prefit (Le Bail cell, then restarts) solves it, and a CI test shows that, so
  the case is fair. Arm A does not press Prefit.
- **Where arm A is right**, the Agent can only match it: on the two clean
  starts, and on the unknown line, which the Validation tab reports by its d.

### Running arms B and C

The arms run on a local server or the API, never in CI. Each run's record and
transcript go to the output directory, and `summary.md` holds the tables:

```bash
# local models (no cost): test and dev sets, arms B and C, 3 runs per case
MATERIA_VALIDATION=1 MATERIA_VALIDATION_MODEL=qwen MATERIA_VALIDATION_SPLIT=test \
  npx vitest run src/agent/validation/live.test.ts --reporter=verbose
#   MATERIA_VALIDATION_MODEL=gemma | glimmer; _ARMS=B,C (default); _REPEAT=3 (default);
#   _ONLY=case ids; _SERVER=the local server's address; _OUT=/tmp/materia-validation/<model>;
#   _TEMPERATURE=a temperature for a local model (default: the server's for the model)

# Claude Sonnet 5.5: the test set only, under a $15 cap (MATERIA's share of the cycle's $40)
MATERIA_VALIDATION=1 MATERIA_VALIDATION_MODEL=sonnet ANTHROPIC_API_KEY=… \
  MATERIA_VALIDATION_CAP_USD=15 npx vitest run src/agent/validation/live.test.ts
```

Runs go in rounds: run 1 of every case and arm, then run 2, then run 3. A cap
reached part way therefore leaves every case with the same number of runs.

For the API, a spend ledger (`/tmp/materia-validation/spend.json`, shared
across invocations) prices each run with the model's prices. Before a run, it
checks that the run's expected cost still fits; during a run, it aborts once
the run passes $2 or the cap. Runs not made are listed in `summary.md`.

The models are qwen3.8-27b (LM Studio, 32k), gemma4:26b (Ollama, 32k),
meta/muse-glimmer (LM Studio) and Claude Sonnet 5.5. Each gets the same cases
and the same scoring, and they are reported side by side.

**The run policy.** Arm B is the Agent as it ships, and it ships different
settings for different ways of reaching a model (`runPolicy` in `chat.ts`):

| | Claude | a local model (LM Studio, Ollama) |
| --- | --- | --- |
| turns per message | 40 | 80 (one call a turn, where Claude makes several) |
| tools offered | every tool | the page's and the method stage's (arm C: the page's) |
| old tool results | cleared by the API past 60k tokens | digested by the app to fit the window |
| reads that change nothing | not counted | the turn stops after 20 in a row |
| temperature | its own (adaptive thinking) | the server's for the model |

Arms B and C on one model share the policy, so their comparison is clean. A
comparison across models also compares these settings; each record and
transcript states the policy its run had, and `_TEMPERATURE` fixes the local
models' temperature where the server's default should not stand.

**Expected time on qwen3.8-27b.** This is an estimate, not a measurement. A
full refinement on the local tier took about 40 turns, and only the long AWO₄
flow reached the 80-turn cap. At the local tier's pace that is about 10 to 20
minutes a run. Gemma4:26b took 2.2 minutes a scenario on the shorter eval
scenarios.

| Runs | Count | Time |
| --- | --- | --- |
| test set, arms B and C, 3 runs each | 48 | 8–16 h |
| one run per test case and arm | 16 | 3–5 h |
| dev set (8 cases), arms B and C, 3 runs each | 48 | 8–16 h |

### Limits

- The test set is simulated, from published structures, on one instrument.
  Real data bring what simulation leaves out (absorption, texture, an
  instrument the file does not describe). Public data with a published
  refinement are wired in (`pbso4-d1a`) but are not on this machine yet.
- The fault reading matches text. A reviewer reads the transcripts and can
  overrule it; overrules are filed as findings.
- Arm A is one way a newcomer uses the app. Pressing Prefit before Refine would
  have solved `rutile-cell-strained`.

## Honesty rule

If a number has not been checked against an independent source, the docs and UI
must not imply it has. [LIMITATIONS.md](./LIMITATIONS.md) holds the standing
scope statement that accompanies all results.
