# Validation

Validation is mandatory, not optional. This document records **what is tested**,
**what is validated against external tools**, and **what is only approximate**.
Every claim about correctness must be traceable to a test or an external
comparison recorded here.

## Principles

1. Every scientific function in `src/core` has unit tests.
2. Key calculators have **golden-value** tests: a known input produces a recorded
   output, and the test fails if the number changes. This prevents silent drift.
3. Selected end-to-end examples are compared against established tools
   (GSAS-II, FullProf, Jana2020) where feasible; agreement and tolerances are
   recorded below.
4. Documentation states plainly which features are *validated* vs *approximate*.

> **GSAS-II is the primary external reference** for the golden-value and
> benchmark tests below — Toby & Von Dreele (2013), *J. Appl. Cryst.* **46**, 544
> ([10.1107/S0021889813003531](https://doi.org/10.1107/S0021889813003531)). We
> reimplement independently (no code copied), but its outputs are our correctness
> gate and must be cited. Full bibliography in [`REFERENCES.md`](./REFERENCES.md).

## Test matrix (1111 passing, 59 real-data/slow tests skipped without local `data/`)

| Area | Test kind | Status |
| --- | --- | --- |
| ProjectFile JSON round-trip | unit | ✅ `core/project/project.test.ts` |
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
| Moment-size restraint → physical magnitudes | integration | ✅ `core/workflow/magneticCompare.test.ts` |
| TOF ↔ d conversion (POWGEN calibration) | golden (GSAS `.lst`) | ✅ `core/diffraction/instrument.test.ts` |
| Instrument-file parsing | unit | ✅ `core/diffraction/instrument.test.ts` |
| Anisotropic ADP (reduces to isotropic) | unit | ✅ `core/diffraction/features.test.ts` |
| March-Dollase preferred orientation | unit | ✅ `core/diffraction/features.test.ts` |
| Multi-phase powder (2-phase recovery) | integration | ✅ `core/workflow/multiPhase.test.ts` |
| Le Bail extraction (pattern reconstruction) | integration | ✅ `core/workflow/leBail.test.ts` |
| Magnetic powder (separable components + refine) | integration | ✅ `core/workflow/magneticPowder.test.ts` |
| k≠0 Fourier structure factor (SDW/helix) + amplitude recovery | unit + self-consistent | ✅ `core/magnetic/fourierMoment.test.ts` |
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

Golden fixtures live under `src/examples/` with recorded expected outputs. Each
golden test names its source of truth (an analytic value, a hand calculation, or
an external-tool run). Updating a golden value requires an explicit, reviewed
change — it cannot happen silently.

Planned reference structures:
- **bcc Fe** — trivial one-site cell; exercises symmetry expansion and `F_N`.
- A simple oxide (e.g. rock-salt MgO) — two sites, neutron + X-ray form factors.
- A simple collinear antiferromagnet — magnetic projection and `F_M`.

## External comparisons

For each cross-check we record: the external tool, the input, the compared
quantity, the agreement achieved, and the tolerance we accept. The source is the
GSAS-II refinement bundled in `data/` (`isothermal_hex/Untitled.lst` and the
CIFs), a two-phase (Mn₃Ga + MnO) TOF neutron powder Rietveld.

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

The magnetic moment magnitudes are a particularly strong check: the components are
given in crystal axes for a monoclinic cell (β = 60.69°), so reproducing GSAS-II's
reported magnitude confirms both the mCIF parse and the normalized-axis metric
used for `momentCartesian`.

The 200 K reflection list (`fitted_results_Cmcm_hkl.dat`) contains both phases;
its cubic MnO subset satisfies d·√(h²+k²+l²) = 4.438 Å, and our `dSpacing()`
reproduces GSAS-II's listed d-spacings for those reflections to < 2×10⁻³ Å.

**Scope note.** These validate the *crystallographic and scattering
foundations* — the quantities our engine shares with GSAS-II. The full
end-to-end fit is **not** compared: GSAS-II ran a two-phase TOF Rietveld with
instrument profile functions, background, and profile coefficients beyond this
minimal engine's scope (see [LIMITATIONS.md](./LIMITATIONS.md)). Our
refinement is validated only as *self-consistent* (recovers known parameters
from synthetic data), not against GSAS-II's wR.

## Bayesian posterior sampling

The ensemble MCMC sampler (`core/refinement/bayes/`) is validated on three
levels before any posterior is trusted:

1. **Exact-posterior recovery (analytic truth):** on a linear-Gaussian problem
   the posterior is known in closed form; the sampler recovers the exact mean
   within 0.1σ, the exact std within 15%, and the exact pairwise correlation
   within ±0.05 — and a flat posterior inside bounds is sampled uniformly,
   pinning the logit-transform `logJacobian` measure term end-to-end.
2. **Structural invariants:** serial and worker-pool drivers produce
   bit-identical chains (RNG lives only in the sans-io generator); one 400-step
   run equals 200+200 steps through the resume token; the same seed reproduces
   and a different seed differs.
3. **Gaussian-limit consistency with LM (Ni golden):** sampling the PDFfit2 Ni
   fixture around the converged LM minimum gives posterior std / linearized LM
   esd (`esdRatio`) of **0.99–1.01** per parameter — the sampler and the
   least-squares esds validate each other in the limit where both must agree.

The default likelihood is **marginalized noise** — `logL = −(N/2)·ln χ²`, the
unknown error scale integrated out under a Jeffreys prior — because reduced-PDF
data carry correlated point errors and are fitted with deliberate unit weights
(see [LIMITATIONS.md](./LIMITATIONS.md)). Convergence is reported the way
McCluskey et al. (2023, *J. Appl. Cryst.* **56**, 12) advise for Bayesian
analysis of scattering data: split-R̂ (Gelman–Rubin), ESS (Geyer
initial-monotone truncation), and quantile credible intervals — never a bare
std. The crystallographic precedent for MCMC posterior refinement is Fancher
et al. (2016, *Sci. Rep.* **6**, 31625).

## PDF analytic gradients

The fused-pass gradient kernel (`core/pdf/gradients.ts`) is gated by
`pdfAnalyticJacobian.test.ts`:

- the fused value curve is **bit-identical** to `computeGofR` on the Ni golden;
- every analytic ∂G/∂p column (envelopes, widths, occupancy, B_iso, U_aniso,
  symmetry-mode position shifts — including orbit images under rotated
  operations) matches a central finite difference;
- unsupported kinds (`cell`, `sratio`/`rcut`, tie-referenced parameters)
  correctly return null and fall back to FD, and restraint rows carry the term
  coefficients;
- FD-driven and analytic-driven refinements land in the **same basin** on the
  Ni golden (analytic is 2.3× faster);
- the scalar `gradChi2` (analytic columns + central-FD fill-in) matches central
  differences of χ².

**FD-oracle caveat (methodology):** the ±5σ Gaussian evaluation window is
quantized on the r-grid, so the *finite-difference oracle* — not the analytic
column — shows 1/h spikes when a pair crosses a window edge, and the Qmax
band-limit delocalizes those spikes across the whole grid. The gates therefore
apply a **Richardson h-vs-h/2 consistency filter** (only h-stable FD points are
compared) and run the tight tolerances with termination off.

## GPU acceleration precision

The WebGPU kernels are **approximate f32 accelerators, opt-in and never
bit-identical** (see [LIMITATIONS.md](./LIMITATIONS.md)). Their reference is the
CPU f64 path — itself validated above against GSAS-II. Two gates enforce the
precision contract before any refinement trusts a GPU value:

1. **CI (node, no GPU):** the WGSL struct field-counts must equal the JS
   marshaling strides, and the kernel's formula reimplemented in f64 must
   reproduce the CPU structure factor (`< 1e-9`) — catches marshaling/stride
   drift without hardware.
2. **Hardware (browser, `window.__gpuValidate`):** the actual kernel vs the CPU
   f64 truth. Measured on Apple GPU (metal-3), max relative deviation:

| Kernel | Case | Max rel. deviation |
| --- | --- | --- |
| Nuclear \|F_N\|² | Mn₃Ga neutron, isotropic ADP | 3.9e-7 |
| Nuclear \|F_N\|² | Mn₃Ga X-ray, isotropic ADP | 7.9e-8 |
| Nuclear \|F_N\|² | Mn₃Ga neutron, anisotropic ADP | 5.0e-7 |
| Nuclear \|F_N\|² | 8-model perturbed batch | 4.7e-7 |
| Magnetic \|F_M\|² | Mn₃Ga AFM k=(½,0,0), 175 satellites | 4.5e-7 |
| Profile synthesis | 20k pts × 5.5k pseudo-Voigt peaks | 1.1e-5 of pattern max |

All are **far below counting statistics and esd scales (≥1e-3 relative)**.
End-to-end, a GPU-accelerated powder refinement converges to the *same minimum*
as the CPU pool (both wR 5.00% on a Mn₃Ga occupancy+ADP fit) — the f32 |F|²
nudges the LM path but not the answer.

## Honesty rule

If a number has not been checked against an independent source, the docs and UI
must not imply it has. See [LIMITATIONS.md](./LIMITATIONS.md) for the standing
scope statement that accompanies all results.
