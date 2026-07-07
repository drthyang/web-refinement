# Powder Refinement Roadmap

Focused plan to make **powder** refinement production-grade: a robust engine,
real background functions, atomic displacement parameters (not just peak width),
and a proper refined-structure view. Ordered so each stage rests on a stable one
below it.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

## Current state (baseline)
- Powder refines only **scale, one peak width, cell a/c** (`examples/synthetic.ts`).
- Engine: Levenberg–Marquardt, **central-difference numerical Jacobian**, no
  parameter scaling; stalls on mixed-magnitude parameter sets.
- Background: `background` kind exists in `apply.ts` / `profile.ts` but **no
  workflow creates background parameters**, and it is a **raw-power polynomial**
  (`c0 + c1·x + …`) that overflows for wide abscissae (Q, TOF).
- Thermal: powder refinement supports per-site isotropic B and symmetry-adapted
  anisotropic `U_ij` modes parsed from CIF.
- Presentation: a 12-row bond-length list; no atom table, esds, angles, or view.

---

## A — Refinement robustness (foundation)
1. **Parameter normalization / diagonal preconditioning** ✅ — condition the
   normal equations by `diag(JᵀJ)` (column scaling) so mixing scale (~1e-11),
   cell (~10), B (~1), and positions (~0.1) no longer wrecks the solve. Biggest
   single robustness win. (`engine.ts`, diagonal Jacobi preconditioning.)
2. **Analytic derivatives for linear parameters** ✅ — scale and background
   coefficients are linear in the model; their Jacobian column is computed
   exactly from a single evaluation (forward step differenced against the
   already-computed baseline y_calc — exact for an affine parameter, no
   truncation error) instead of a two-point central difference. Parameters carry
   a `linear` flag on `RefinementParameter`; `scale`, `background`, and
   `magneticScale` kinds default to linear. Faster (one `calculate()` call per
   linear column instead of two) and free of finite-difference error.
3. **Shift limiting, bound projection, adaptive λ** ✅ — cap the fractional
   parameter shift per cycle; project onto bounds; Marquardt diagonal damping.
   (`limitShift`, `clamp`, and the LM retry loop in `engine.ts`.)
4. **Staged (guided) refinement** ✅ — unlock parameters in the expert order
   (scale → background → cell → profile → ADP → positions), each converged before
   the next. Cumulative: once freed a parameter co-refines in every later stage.
   (`refinement/staged.ts` `refineStaged`; default plan in
   `workflow/structureRefinement.ts` `defaultStages`.) Robustness *and* the
   guided-sequence order in one driver.
5. **Robust starting values** ⬜ — auto-scale (done), auto-background from the
   data's lower envelope, zero-shift / peak-position sanity check.
6. **Dual convergence test** ⬜ — on both Δχ² and max parameter shift; better
   stall-vs-converged discrimination.

## B — Background functions
1. **Chebyshev polynomial on x∈[−1,1]** ✅ — GSAS/Topas standard; well
   conditioned, N refinable terms. Replaces the raw-power form (fixes overflow).
2. **Shifted Chebyshev, linear-interpolation (anchored), reciprocal (1/x)** ⬜.
3. **UI** ⬜ — choose function + term count; refined early in the staged sequence;
   auto-seeded from the data envelope.

## C — Thermal parameters (ADP)
1. **Isotropic Uiso/Biso per site (powder)** ✅ — params + bindings emitted by
   `buildStructureRefinement` (per isotropic site), refined in the `ADP` stage.
   UI wiring still ⬜.
2. **Anisotropic Uani** ✅ — parse `_atom_site_aniso_U_11…U_23`; emit
   symmetry-adapted `uAniso` modes; apply them back to the full U tensor consumed
   by `anisotropicDebyeWaller`.
3. **Site-symmetry constraints on Uij** ✅ — allowed ADP modes are the null space
   of `U = R U Rᵀ` over the site stabilizer. On the GaNb₄Se₈ Nb 16e site this
   correctly gives two modes: `U11=U22=U33` and `U12=U13=U23`.
4. **Report Ueq** from Uani ⬜.

## C½ — Atomic position refinement (the core of structure refinement)
1. **Symmetry-adapted positional modes** ✅ — a site's free coordinates are the
   null space of `(R − I)` over its stabilizer (`crystal/siteConstraints.ts`
   `allowedPositionShifts`), the same method as the magnetic moment / cell-metric
   constraints. Refinement drives one parameter per allowed mode (`positionShift`
   kind + `axis` on the binding; apply shifts `X = X₀ + Σ αᵢ·axisᵢ`), so a
   special-position atom like Se at 16e (x,x,x) refines its single free x with
   y,z tied — it cannot drift off its site. General positions get three modes.
   Validated by a synthetic recovery test (displace Mn1 along its mode, refine it
   back, wR→0) and the real GaNb4Se8 staged test.
2. **Occupancy refinement** ⬜ — `occupancy` kind is wired end to end and emitted
   by the builder behind `refineOccupancy` (off by default: correlates with
   scale/ADP); needs damping/constraints before it's on by default.
3. **Positional esds from the covariance matrix** ✅ (per-mode; reported on the
   `RefinementParameter.esd`). Convert mode esds → x/y/z esds in workstream D.

## D — Refined structure presentation
1. **Refined atom table** ⬜ — x/y/z, occ, Uiso/Ueq (+Uani) with **esds** from
   the covariance matrix.
2. **Geometry** ⬜ — bond lengths *and angles* with esds; coordination polyhedra.
3. **3D unit-cell view** ⬜ — atoms, bonds, thermal ellipsoids (Three.js/canvas,
   consistent with the rmc-toolkits / nebula3d viewers).
4. **Export refined CIF** ⬜ — cell, positions, occ, ADPs + esds.

## Testing example
Validation uses the **real GaNb4Se8 28ID synchrotron XRD** dataset, not the
self-consistent synthetic demo (which trivially converges to wR≈0 and proves
nothing). See `src/core/workflow/realPowderXRD.test.ts` (skips when `data/` is
absent). A genuine hard case: X-ray, F-4̄3m (96 ops), masked points, 100 K model
vs 298.8 K data.
- **Two traps this dataset exposed** (both now handled in the test):
  1. The `_gsas.dat` abscissa is **2θ in degrees at λ≈0.166 Å**, NOT Q — peaks
     index as (111)@1.585°, (400)@3.662°. Treating it as Q **collapses the scale
     to 0** (misaligned peaks + Poisson weighting ⇒ the optimizer drops the
     structure entirely and fits a flat background at wR≈82%). Wavelength must be
     supplied (instrument file / override).
  2. **Lorentz double-correction** (see below).
- **Working baseline:** with the correct unit + Lorentz off + pseudo-Voigt, a
  scale+cell+background+width+B refinement converges to **wR ≈ 40%** with a
  nonzero scale (peaks fit). Remaining gap to <15% is profile (Caglioti U,V,W),
  zero-shift, and anisotropic ADP. Tighten the test's wR bound as those land.

## E — Instrument profile (Caglioti) ✅
Angle-dependent width is required for real data: one width cannot fit both the
sharp low-angle and broadened high-angle peaks. Implemented:
- **Caglioti FWHM² = U·tan²θ + V·tanθ + W** wired into `buildPeaks` (2θ patterns),
  seeded from the GSAS-II `.instprm` (`parseInstrumentParameters` now reads
  U/V/W + `Polariz.`). Refined in the `profile` stage. **U is fixed by default**
  (`refineU`): over a narrow low-angle range tan²θ is tiny, so U is unconstrained
  and trades off against W — V and W absorb sample broadening instead.
- **Zero-shift** ✅ — `zeroShift` now applied in `buildPeaks` (was a no-op) and
  refined in the `profile` stage.
- Still ⬜: **Thompson-Cox-Hastings** pseudo-Voigt (separate Gaussian U,V,W and
  Lorentzian X,Y size/strain), needed when instrument-sharp low angle and
  sample-broadened high angle cannot be reconciled by one Gaussian.

## UI wiring ✅
Step 3 now builds the **full symmetry-allowed parameter set** via
`buildStructureRefinement` (`app/powderSpec.ts`): scale, Chebyshev background,
symmetry-reduced cell, instrument profile (Caglioti U/V/W + zero, seeded from a
loaded `.instprm`), per-site ADP, and symmetry-adapted positions — replacing the
old scale/width/cell-only set. Structural rows start fixed; **Refine selected**
does a flat co-refinement of freed rows, **Guided (staged)** runs the expert
sequence in the worker (`workers/runPowder.ts`, serializable `StageKinds` plan
over the worker boundary). A Lorentz toggle is exposed. Verified in-app: the
Mn₃Ga example converges to wR ≈ 5.9% via Guided.

## F — Corrections stack (GSAS-II physics) ✅ wired
- **March–Dollase preferred orientation** — refinable `poRatio` on a chosen hkl
  axis (`apply.ts` + `buildPeaks`), builder option `preferredOrientation`, in the
  `corrections` stage. Formula matches GSAS-II. Synthetic recovery test passes.
- **Debye–Scherrer cylinder absorption** — `cylinderAbsorption(μR, 2θ)` ported
  **verbatim from GSAS-II's `Absorb`** (both μR≤3 and μR>3 branches), refinable
  `absorption` param. Synthetic recovery test passes.
- Still ⬜: spherical-harmonic texture, flat-plate / other absorption geometries,
  microabsorption, extinction.

## Validated real-data status (GaNb4Se8, 298.8 K vs 100 K model)
Staged refinement (scale → bkg → cell → profile → ADP → positions) with the real
`.instprm` reaches **wR ≈ 36.5%, Rp ≈ 22.7%, Rexp ≈ 12.8%, GoF ≈ 8** — a genuine
fit (a=10.414, W 1.2→6.2, three refined (x,x,x) positions incl. Se17, per-site B).
The **high-angle region already fits ≈14%**; the residual floor is the strongest
low-angle reflection (400) under-predicted ~3× in integrated intensity.
**Diagnosed** (not corrections): March–Dollase PO barely helps (refined r≈1),
absorption is smooth, and the X-ray form factors are already correct Cromer-Mann —
so it is **structural**. Freeing site occupancies drops wR to **23.4%** and fixes
(400), but drives chemically impossible values (Nb 0.57, Ga 0.12): the classic
occupancy↔scale↔ADP correlation on X-ray-only data. Soft linear occupancy
restraints are now wired as least-squares pseudo-observations; the real-data
regression keeps restrained occupancies plausible (Nb/Se = 1.000, Ga ≈ 0.983).
Complementary neutron data remains the stronger physical way to break this
correlation.

## Physics / intensity model (gates real-data fit quality)
- **Lorentz handling — selectable** ✅ (`applyLorentz` on `powderPeakIntensities`
  / `PowderProfile.lorentz`). Pre-reduced synchrotron I(Q) from a PDF beamline
  (28ID) is already Lorentz-corrected; re-applying the 2θ factor over-amplifies
  low angle. Confirmed on GaNb4Se8: Lorentz-on wR≈53%, **off wR≈40%**. Still
  ⬜ in the UI (auto-default by data source + toggle).
- **Zero-shift** ✅ — wired in `apply.ts` + `buildPeaks` and refined in the
  profile stage (see workstream E).
- **ADP damping** (workstream C) — without refined thermal parameters, high-angle
  intensities are systematically wrong.

## Cross-cutting prerequisite
- **Reader UI: Q / X-ray override** ⬜ — so real synchrotron patterns (e.g.
  `GaNb4Se8_XRD_28ID`) load with the correct unit and radiation for testing.

## Build order
**A → B → C → D.** Landed: **A1 + A3** (engine conditioning + shift limiting),
**B1** (Chebyshev background), **A2** (analytic column for linear parameters),
**A4** (staged/guided refinement), **C1** (per-site isotropic ADP in the powder
path), **C2/C3** (anisotropic ADP with site-symmetry modes), and **C½**
(symmetry-adapted atomic-position refinement) — the powder path now does genuine
Rietveld *structure* refinement, driven by
`buildStructureRefinement` + `refinePowderStructure`
(`workflow/structureRefinement.ts`). Next: **D** (refined-structure
presentation: atom table with esds, geometry, 3D view, CIF export), and the UI
wiring for the staged flow.
