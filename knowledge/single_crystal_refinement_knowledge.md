# Single-Crystal Structural Refinement Knowledge Base

Purpose: provide implementation guidance for a coding agent building single-crystal structural refinement and, more importantly, for judging whether a single-crystal refinement is **reliable** and **physically reasonable**. This document focuses on what changes relative to powder work, on symmetry-driven correctness, and on the hard limits imposed by the instrument, the crystal, and the methodology. It complements `powder_structural_refinement_knowledge.md` and `refinement_fitting_algorithms_knowledge.md`; solver mechanics live there and are not repeated here.

## 1. Scope

Support single-crystal structural refinement for:

```text
- laboratory X-ray single-crystal diffraction (sealed tube, microfocus)
- synchrotron single-crystal diffraction (high resolution, small crystals, high pressure)
- constant-wavelength single-crystal neutron diffraction (four-circle)
- time-of-flight single-crystal neutron diffraction (Laue, e.g. TOPAZ, SXD, MaNDi)
- twinned crystals, disorder, and non-centrosymmetric / chiral structures
- variable-temperature, -pressure, and -field series
```

The fundamental difference from powder: single-crystal data are **individually resolved reflections** `I(hkl)` with their own σ. There is no peak overlap to deconvolute, no profile-vs-structure entanglement, no preferred orientation in the powder (March–Dollase) sense, and no reflection multiplicity to model. What replaces those concerns are **data-reduction quality, symmetry determination, extinction, absorption, twinning, and absolute structure**. Do not port the powder mental model wholesale.

## 2. What single-crystal data actually are

The refinement input is a reflection list, typically after integration and reduction by the diffractometer software (e.g. SAINT/APEX, CrysAlis, DIALS, Mantid for TOF):

```text
h k l   I(hkl)   σ(I)      [batch/run number, direction cosines]
```

Reduced to squared structure-factor magnitudes:

```text
Fo²(hkl) with σ(Fo²)
```

Corrections normally already applied during reduction (know which, and do not double-apply):

```text
- Lorentz correction (geometry of data collection)
- polarization correction (X-ray)
- scaling / multi-scan absorption + scale (SADABS, SCALE3 ABSPACK, DIALS scaling)
- background subtraction and profile integration
```

Corrections that may be applied at reduction OR refined in the model (decide once, never both):

```text
- numerical/analytical absorption (if crystal shape known)
- extinction
- twin component scaling
```

Refine modern structures against **Fo²**, not Fo. Refining against F² uses all data including weak and negative-net reflections, gives correct statistics, and avoids the bias of rejecting weak data. Report both R1 (on F, conventional, `I > 2σ`) and wR2 (on F², all data).

## 3. Structure-factor model

For each reflection:

```text
F_hkl = Σ_j  occ_j · f_j(Q) · T_j(hkl) · exp[2πi(h x_j + k y_j + l z_j)]
```

where:

```text
f_j(Q)   = X-ray form factor f0(Q) + f'(λ) + i f''(λ)   (anomalous dispersion)
         = neutron scattering length b_j            (Q-independent, can be negative)
T_j(hkl) = Debye-Waller factor, isotropic exp(-8π² U_iso sin²θ/λ²)
           or anisotropic exp[-2π²(U11 h²a*² + ... + 2 U12 h k a* b*)]
Q        = 4π sinθ/λ = 2π/d
```

Intensity model, with the corrections that belong to single crystal:

```text
I_calc(hkl) = scale · L · P · A · E · |F_hkl|²
```

`L` Lorentz, `P` polarization, `A` absorption transmission, `E` extinction. See `src/core/diffraction/singleCrystalFactors.ts`: `singleCrystalLorentz`, `polarizationFactor`, `extinctionFactor`, and the F²-based agreement/weighting in `shelxWeights` / `singleCrystalAgreement`. Anomalous dispersion (`f'`, `f''`) must be included for X-ray and is what makes absolute-structure determination possible (§10).

## 4. Symmetry is the backbone of reliability

Getting the symmetry right is more consequential than any refinement setting. A structure refined in the wrong space group can still give a low R factor while being physically wrong.

### 4.1 Determination pipeline

```text
1. unit cell + Bravais lattice from indexing
2. Laue class from the symmetry of measured intensities (merging R by candidate class)
3. systematic absences → possible screw axes / glide planes → space-group candidates
4. |E²-1| statistic and mean |E| → centrosymmetric vs non-centrosymmetric
5. structure solution to confirm the choice
```

### 4.2 Merging equivalents and the pre-refinement quality gates

Symmetry-equivalent reflections are averaged; their agreement measures data quality and confirms the Laue class:

```text
Rint   = Σ|Fo² - <Fo²>| / Σ Fo²        (agreement of equivalents; wrong Laue class inflates it)
Rsigma = Σ σ(Fo²) / Σ Fo²              (counting statistics / measurement precision)
redundancy = observations / unique reflections
completeness = measured unique / theoretically possible to d_min
resolution d_min (or 2θ_max, or (sinθ/λ)_max)
```

These gate whether a refinement can succeed at all. Enforce before trusting any structural result:

```text
- completeness ≥ ~98–99% to the stated resolution (report if lower and why)
- d_min ≤ ~0.83 Å (sinθ/λ ≥ 0.6) for anisotropic ADPs; publication X-ray often to 0.77 Å
- redundancy high enough that multi-scan absorption is meaningful (≥ ~4 for Laue-class dependent scaling)
- Rint consistent with the assigned Laue class; a Laue class that is too high inflates Rint
```

### 4.3 Symmetry constraints on the model (must be applied, not optional)

Site symmetry constrains what is refinable. Violating these is a silent source of unphysical results:

```text
- special-position coordinates are fixed or coupled (an atom on a mirror cannot move off it)
- occupancy of a special position is scaled by the site multiplicity ratio
- anisotropic Uij components are constrained by site symmetry (e.g. on a 3-fold axis)
- for centrosymmetric groups, do not refine absolute structure or off-center polar shifts
```

See `src/core/crystal/`: `siteConstraints.ts`, `cellConstraints.ts`, `adpConstraints.ts`, `symmetry.ts`, `spaceGroups.ts`. Cell parameters must obey the crystal system (e.g. cubic a=b=c, α=β=γ=90). The refinement DOF must always be symmetry-reduced, never the full P1 expansion.

## 5. Corrections specific to single crystal

### 5.1 Lorentz–polarization

Geometric and beam-polarization factors depend on collection geometry and radiation. Wrong Lp gives a smooth angular intensity bias that partly absorbs into the scale and ADPs — reliability killer that hides in "acceptable" R factors. For neutron TOF Laue the Lorentz factor is wavelength-dependent (`∝ λ⁴/sin²θ`), fundamentally different from CW.

### 5.2 Absorption

```text
μ from composition and wavelength; μR (R = effective radius) sets severity
- μR < ~0.1  : negligible
- μR ~ 0.1–1 : correct (multi-scan usually adequate)
- μR > ~1    : shape-based (analytical/Gaussian) correction required; crystal faces indexed
```

Absorption left uncorrected biases ADPs (often making them too small or non-positive-definite) and produces residual density near heavy atoms. This project has a dedicated transmission/shape engine (`src/core/absorption/`) validated against WinGX; prefer analytical correction when the crystal habit is known, multi-scan otherwise. Never apply both a reduction-stage and a model-stage absorption correction.

### 5.3 Extinction

Often forgotten, and a leading cause of a handful of strong low-angle reflections fitting badly.

```text
- primary extinction: coherent re-diffraction within a perfect mosaic block
- secondary extinction: shadowing of deeper blocks by strong reflections
- symptom: strongest, low-angle reflections have Fo² << Fc²
- SHELXL-style single-parameter model, or Becker–Coppens (type I/II, mosaicity)
```

`extinctionFactor(x, fSquared, radiation, d)` implements the single-parameter form. Extinction is more severe for good crystals, for neutrons (large crystals), and at long wavelength. Refine one extinction parameter only when the low-angle residual pattern demands it; do not refine it simultaneously with absorption and occupancy on correlated reflections.

### 5.4 Thermal diffuse scattering (TDS)

TDS adds intensity under Bragg peaks that increases with Q and temperature. Uncorrected, it biases ADPs downward (apparent U too small). Low-temperature data reduce TDS, disorder, and ADP magnitudes simultaneously — collect cold when moment/ADP fidelity matters.

## 6. Refinable parameters and their physical bounds

```text
scale                : one per data batch/twin component
fractional coords    : symmetry-reduced; watch shifts > a few σ per cycle (instability)
U_iso / U_aniso      : displacement parameters — the richest physical-sanity signal (§7)
site occupancy       : 0–1; refine only with constraints or complementary evidence
extinction           : single parameter, only if warranted
twin batch fractions : BASF, sum to 1 (§9)
Flack / absolute-structure parameter : only for non-centrosymmetric (§10)
```

Data-to-parameter ratio target:

```text
≥ 10:1 comfortable, ≥ 8:1 acceptable for anisotropic refinement
below that, restrain or drop to isotropic; do not report anisotropic ADPs you cannot support
```

## 7. Physically reasonable results — the checks that matter

A low R factor is necessary, not sufficient. Judge the model on physics:

### 7.1 Displacement parameters (ADPs)

```text
- anisotropic Uij MUST be positive-definite; non-positive-definite (NPD, "went to a saddle")
  means wrong symmetry, bad absorption, disorder, or misassigned element — a hard red flag
- U_eq should track expected thermal motion: heavy framework atoms small, terminal/solvent large
- cigar-shaped (prolate) or pancake (oblate) ellipsoids suggest unresolved disorder,
  wrong site, or a symmetry that is too low/high
- Hirshfeld rigid-bond test: the mean-square displacement AMPLITUDE difference of two bonded
  atoms along the bond should be near zero (|Δ| ≲ 0.001–0.003 Å²); large values flag error
```

### 7.2 Geometry

```text
- bond lengths and angles must match known coordination chemistry within reason
- flag chemically impossible distances (too short = merged/duplicate atoms; too long = missing bond)
- coordination number and polyhedral geometry should be sensible for the element/oxidation state
```

### 7.3 Residual electron density

```text
- report max and min Δρ (e/Å³) and their locations
- large positive/negative peaks AT heavy atoms  → absorption or extinction error
- positive peaks near an atom (~1 Å)             → missed disorder / wrong element / missing H
- diffuse residual                              → unmodelled disorder or solvent
- for a good small-molecule X-ray structure, |Δρ| is typically ≲ 1 e/Å³ away from heavy atoms
```

### 7.4 Occupancy and composition

```text
- refined occupancies should reconcile with charge balance and expected stoichiometry
- occupancy strongly correlates with U_iso (both scale peak height) — do not free both blindly;
  fix one from complementary data (EDX, known composition) or constrain
```

## 8. Quality metrics and weighting

```text
R1   = Σ||Fo| - |Fc|| / Σ|Fo|         over I > 2σ(I)   (conventional agreement)
wR2  = sqrt[ Σ w(Fo² - Fc²)² / Σ w(Fo²)² ]   over all data
GooF = sqrt[ Σ w(Fo² - Fc²)² / (Nobs - Nparams) ]   → should be ≈ 1.0
```

Weighting (SHELXL scheme, `shelxWeights`):

```text
w = 1 / [ σ²(Fo²) + (a·P)² + b·P ],   P = [ max(Fo²,0) + 2·Fc² ] / 3
```

`GooF` far from 1 signals a wrong weighting scheme, wrong error model, or wrong structure. A `GooF` forced to 1 by tuning `a`, `b` on a wrong structure is cosmetic — fix the model first. Do not chase R1 by rejecting weak data; wR2/GooF on all F² data are the honest metrics.

## 9. Twinning

Twinning is a top cause of failed or unphysically-restrained single-crystal refinements. Recognize it before over-fitting disorder to compensate.

```text
- merohedral: twin domains share the exact reciprocal lattice; spots overlap perfectly.
  Rint can look deceptively good; symptom is a stubborn high R with otherwise clean data,
  |E²-1| statistics off, and specific reflection classes fitting badly.
  Model with a twin law (matrix) + refine batch scale factor(s) (BASF).
- pseudo-merohedral: a metric coincidence (e.g. monoclinic β≈90°) mimics higher symmetry.
- non-merohedral: lattices overlap only partially; spots split. Requires multi-domain
  integration (HKLF 5 style) with per-reflection domain contributions.
```

Rule: try the correct twin law before piling on restraints/disorder to explain residual density that is really overlap.

## 10. Absolute structure and chirality

For non-centrosymmetric structures with anomalous scatterers:

```text
- Flack parameter x: 0 = correct absolute structure, 1 = inverted, 0.5 = racemic/inversion twin
- estimate via Parsons' quotients (Bijvoet pairs) or Hooft y; report standard uncertainty
- reliable only with sufficient anomalous signal (need atoms with meaningful f'' at λ)
- light-atom-only structures (C,H,N,O with Mo Kα): anomalous signal too weak — DO NOT claim
  absolute configuration from X-ray; use Cu Kα, or neutron, or independent chemistry
- keep Friedel pairs UNMERGED when absolute structure matters (merging destroys the signal)
```

## 11. Disorder modelling with restraints

When disorder is real, model it with symmetry- and chemistry-aware restraints rather than free parameters:

```text
- split sites with complementary occupancies summing to 1 (or to the site multiplicity)
- geometric similarity restraints (equal 1,2 and 1,3 distances) for disordered fragments
- rigid-bond / similar-ADP restraints (RIGU/DELU/SIMU analogs) to stabilize ADPs
- restrain, do not constrain, unless symmetry demands an exact relation
- every restraint is an assumption — report them; they change the effective DOF
```

## 12. Limits of refinement — what the data cannot tell you

State these explicitly; do not let the optimizer report precision it does not have.

```text
- hydrogen atoms from X-ray: seen as displaced electron density; X-ray "bond" to H is short
  (~0.95 Å riding) and NOT the true internuclear distance (~1.09 Å). For real H positions/ADPs
  use neutron data. Place riding H from geometry unless the data genuinely locate them.
- light atoms next to heavy atoms: a few light-atom electrons are swamped by a heavy scatterer;
  their positions/occupancies are poorly determined by X-ray (neutron contrast often solves this).
- oxidation state / bonding electrons: routine refinement gives promolecule (spherical-atom)
  density; charges and lone pairs need charge-density (multipole) refinement and ultra-high-res data.
- resolution ceiling: you cannot refine anisotropic ADPs, or resolve close atoms, beyond what
  d_min supports. Report the resolution and honor it.
- pseudo-symmetry: strongly correlated parameters and near-singular normal matrix; the "true"
  lower symmetry may be underdetermined — check the correlation matrix, not just the R factor.
- incomplete/low-redundancy data: absorption and Rint statistics become unreliable; absolute
  structure and weak superstructure reflections may be unrecoverable.
```

## 13. "Sample texture" for single crystal — the correct analogs

Powder preferred orientation (March–Dollase, spherical harmonics) does **not** apply to a single crystal — there is one orientation. Do not offer a texture model in single-crystal mode. The analogous crystal-quality effects to consider instead are:

```text
- mosaicity / crystal quality: broad or split reflections, poor integration
- extinction (§5.3): the single-crystal analog of "too-perfect" scattering
- twinning (§9): multiple orientation domains
- absorption/shape (§5.2): the single-crystal analog of a sample-geometry intensity bias
```

If the workbench shares UI with the powder engine, gate texture controls behind the engine type so the agent never applies a powder correction to single-crystal data.

## 14. Instrument and methodology dependence

```text
X-ray lab (Mo/Cu Kα):
  - Mo: lower absorption, higher d_min reach; Cu: stronger anomalous signal (better Flack),
    but higher absorption. Choose per problem.
X-ray synchrotron:
  - tiny crystals, high pressure (DAC → low completeness, restricted access), tunable λ for
    resonant/anomalous experiments; radiation damage is a real limit.
Neutron single crystal:
  - scattering length b independent of Q → no form-factor falloff, excellent high-angle data;
    light atoms and H/D located directly; needs large crystals; extinction/absorption (esp. H
    incoherent) prominent. Use D-substitution to cut incoherent background.
  - CW four-circle vs TOF Laue: TOF measures many λ at fixed geometry (wavelength-dependent
    Lorentz), enabling large reciprocal-space coverage from few settings.
Temperature:
  - low T reduces ADPs, TDS, and dynamic disorder, and improves effective resolution — the
    single most effective lever for data quality when the science allows it.
```

## 15. Refinement staging (careful-crystallographer order)

```text
1. scale + overall U_iso against a solved model
2. all coordinates, then isotropic ADPs
3. anisotropic ADPs (only if data/parameter ratio and resolution allow)
4. absorption/extinction only if residuals demand and evidence supports
5. hydrogen treatment (riding for X-ray; free for neutron)
6. absolute structure (Flack) for non-centrosymmetric, at the end
7. twinning if merohedral/pseudo-merohedral suspected — try early if Rint/statistics hint at it
8. final weighting refinement to bring GooF ≈ 1 on a physically sound model
```

Reuse the staged controller and correlation/DOF diagnostics from `src/core/refinement/` (`staged.ts`, `diagnostics.ts`, `dofExclusion.ts`) — the mechanics are shared with powder.

## 16. Implementation modules (existing and to extend)

```text
src/core/diffraction/singleCrystalFactors.ts  L, P, extinction, F²-weighting, agreement
src/core/workflow/singleCrystal.ts            buildSingleCrystalProblem, singleCrystalComparison
src/core/workflow/singleCrystalRefinement.ts  spec builder, guided params, comparison
src/core/crystal/                             symmetry, space groups, site/cell/ADP constraints
src/core/absorption/                          transmission engine, habit/faces (shape correction)
src/core/refinement/                          shared solver, staging, DOF, diagnostics
src/core/diagnostics/                         assessment/interpret (extend with SC-specific gates)
```

Additions worth building on top of the existing spine:

```text
- pre-refinement data-quality report (Rint, Rsigma, completeness, redundancy, d_min) with gates
- twin-law handling + BASF batch scaling (HKLF-5-style per-reflection domains)
- Flack/Parsons absolute-structure estimation for non-centrosymmetric groups
- ADP sanity engine (NPD detection, Hirshfeld rigid-bond, ellipsoid shape flags)
- residual-density reporter (max/min Δρ + location classification)
- checkCIF-style alert generator (A/B/C severity) as a validation grammar
```

## 17. Acceptance tests

### Data and symmetry
```text
- wrong Laue class inflates Rint relative to the correct one (merging test)
- special-position atom cannot refine off its site; occupancy scaled by multiplicity
- cell parameters obey the crystal system after refinement
- completeness/resolution gates fire when a dataset is truncated
```

### Corrections
```text
- omitting absorption on a high-μR case leaves residual density at the heavy atom and biases ADPs
- extinction pulls the strongest low-angle Fo² up toward Fc² and nowhere else
- TOF Lorentz differs from CW (λ dependence) on the same reflections
```

### Physical sanity
```text
- NPD ADP is detected and reported, not silently accepted
- Hirshfeld rigid-bond violation flagged for an artificially perturbed atom
- Flack ≈ 0 for correct absolute structure, ≈ 1 for the inverted model, with a proper σ
- twin-law + BASF recovers a low R on a synthetically twinned dataset that fails single-domain
```

## 18. Non-negotiable rules

```text
- Refine against F², report R1 (I>2σ) and wR2/GooF (all data); never cherry-pick weak data.
- Determine and verify the space group before trusting any structural conclusion.
- Apply symmetry constraints on coordinates, occupancy, and ADPs — never refine the P1 expansion.
- Apply each of Lp, absorption, extinction exactly once (reduction OR model, not both).
- Do not accept non-positive-definite ADPs; treat them as a symmetry/absorption/element error.
- Do not add absorption, extinction, twinning, and occupancy together on correlated reflections.
- Do not claim absolute structure without adequate anomalous signal.
- Do not report X-ray hydrogen positions as true internuclear geometry.
- Do not offer powder preferred-orientation (texture) corrections in single-crystal mode.
- A low R factor is not proof: ADPs, geometry, residual density, and GooF must all be sane.
```

## 19. Practical target

The engine should behave like a careful single-crystal crystallographer:

```text
- gate on data quality (Rint, completeness, redundancy, resolution) before refining
- get the symmetry right and enforce its constraints
- correct Lp/absorption/extinction deliberately and once
- stage coordinates → ADPs → fine corrections → hydrogen → absolute structure
- recognize twinning instead of over-fitting disorder
- judge every result by physics (ADPs, geometry, Δρ, GooF), not R factor alone
- state limits honestly (H from X-ray, light-near-heavy, resolution, pseudo-symmetry)
```

## 20. Reference sources for implementation context

```text
- SHELX (SHELXL) documentation and Acta Cryst. C71 (2015) 3–8, Sheldrick: https://shelx.uni-goettingen.de/
- Crystal Structure Refinement (P. Müller et al., IUCr/OUP) — SHELXL practice, twinning, disorder
- International Tables for Crystallography, Vol. A (space groups) and Vol. C (corrections)
- IUCr checkCIF validation service and alert definitions: https://checkcif.iucr.org/
- Giacovazzo, Fundamentals of Crystallography (structure factors, extinction, absorption)
- Flack & Bernardinelli on absolute structure; Parsons, Flack & Wagner, Acta Cryst. B69 (2013) 249
- NIST X-ray form factor / attenuation tables: https://www.nist.gov/pml/x-ray-form-factor-attenuation-and-scattering-tables
- NIST neutron scattering lengths and cross sections: https://www.ncnr.nist.gov/resources/n-lengths/
```
