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
- Thermal: **no atomic ADPs in the powder path**; CIF `U_iso` is read but
  anisotropic `U_ij` is **not parsed**. Structure factor already supports both.
- Presentation: a 12-row bond-length list; no atom table, esds, angles, or view.

---

## A — Refinement robustness (foundation)
1. **Parameter normalization / diagonal preconditioning** ⬜ — condition the
   normal equations by `diag(JᵀJ)` (column scaling) so mixing scale (~1e-11),
   cell (~10), B (~1), and positions (~0.1) no longer wrecks the solve. Biggest
   single robustness win.
2. **Analytic derivatives for linear parameters** ⬜ — scale and background
   coefficients are linear in the model; compute their Jacobian columns exactly
   and drop them from the finite-difference set (faster + stable). Needs the
   `RefinementProblem` to flag linear parameters.
3. **Shift limiting, bound projection, adaptive λ** ⬜ — cap the fractional
   parameter shift per cycle; project onto bounds; Marquardt diagonal damping.
4. **Staged (guided) refinement** ⬜ — unlock parameters in the expert order
   (scale → background → cell → profile → ADP → positions), each converged before
   the next. Robustness *and* the guided-sequence UX.
5. **Robust starting values** ⬜ — auto-scale (done), auto-background from the
   data's lower envelope, zero-shift / peak-position sanity check.
6. **Dual convergence test** ⬜ — on both Δχ² and max parameter shift; better
   stall-vs-converged discrimination.

## B — Background functions
1. **Chebyshev polynomial on x∈[−1,1]** ⬜ — GSAS/Topas standard; well
   conditioned, N refinable terms. Replaces the raw-power form (fixes overflow).
2. **Shifted Chebyshev, linear-interpolation (anchored), reciprocal (1/x)** ⬜.
3. **UI** ⬜ — choose function + term count; refined early in the staged sequence;
   auto-seeded from the data envelope.

## C — Thermal parameters (ADP)
1. **Isotropic Uiso/Biso per site (powder)** ⬜ — wire params + bindings + UI
   (the `bIso` kind and apply-logic already exist for the single-crystal path).
2. **Anisotropic Uani** ⬜ — parse `_atom_site_aniso_U_11…U_23`; add `U11…U23`
   kinds + apply; `anisotropicDebyeWaller` already consumes them.
3. **Site-symmetry constraints on Uij** ⬜ — derive allowed ADP components from
   site point symmetry (same null-space method as magnetic `allowedMomentDirections`).
   Required for stable anisotropic refinement.
4. **Report Ueq** from Uani ⬜.

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

## Physics / intensity model (gates real-data fit quality)
- **Lorentz handling — selectable** ✅ (`applyLorentz` on `powderPeakIntensities`
  / `PowderProfile.lorentz`). Pre-reduced synchrotron I(Q) from a PDF beamline
  (28ID) is already Lorentz-corrected; re-applying the 2θ factor over-amplifies
  low angle. Confirmed on GaNb4Se8: Lorentz-on wR≈53%, **off wR≈40%**. Still
  ⬜ in the UI (auto-default by data source + toggle).
- **Zero-shift** ⬜ — `zeroShift` kind exists but `apply.ts` is a no-op; wire it
  (real synchrotron patterns carry a small 2θ offset).
- **ADP damping** (workstream C) — without refined thermal parameters, high-angle
  intensities are systematically wrong.

## Cross-cutting prerequisite
- **Reader UI: Q / X-ray override** ⬜ — so real synchrotron patterns (e.g.
  `GaNb4Se8_XRD_28ID`) load with the correct unit and radiation for testing.

## Build order
**A → B → C → D.** First implementation chunk: **A1 + A3** (engine conditioning +
shift limiting) and **B1** (Chebyshev background) — where the "significantly more
robust" jump comes from — then A2/A4, then C, then D.
