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
| Le Bail extraction (pattern reconstruction) | integration | ✅ `core/workflow/leBail.test.ts` |
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
   structure-factor rows below come from `window.__gpuValidate`, a dev-build
   harness; the profile-synthesis row comes from the synthesizer's own
   `gpuValidation`. Maximum relative deviation, measured on an Apple GPU
   (metal-3):

| Kernel | Case | Max rel. deviation |
| --- | --- | --- |
| Nuclear \|F_N\|² | Mn₃Ga neutron, isotropic ADP | 3.9e-7 |
| Nuclear \|F_N\|² | Mn₃Ga X-ray, isotropic ADP | 7.9e-8 |
| Nuclear \|F_N\|² | Mn₃Ga neutron, anisotropic ADP | 5.0e-7 |
| Nuclear \|F_N\|² | 8-model perturbed batch | 4.7e-7 |
| Magnetic \|F_M\|² | Mn₃Ga AFM k=(½,0,0), 175 satellites | 4.5e-7 |
| Profile synthesis | 20k pts × 5.5k pseudo-Voigt peaks | 1.1e-5 of pattern max |

All are far below counting statistics and esd scales (≥ 1e-3 relative). End to
end, a GPU-accelerated powder refinement converges to the *same minimum* as the
CPU pool: both reach wR 5.00% on a Mn₃Ga occupancy + ADP fit. The f32 |F|²
nudges the LM path but not the answer.

## Honesty rule

If a number has not been checked against an independent source, the docs and UI
must not imply it has. [LIMITATIONS.md](./LIMITATIONS.md) holds the standing
scope statement that accompanies all results.
