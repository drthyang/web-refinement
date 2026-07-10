# Powder microstructure — crystallite size & microstrain (M6)

The layer that turns the fitted **peak broadening** into the microstructure a
materials study reports: crystallite size ⟨D⟩, microstrain ε, their anisotropy,
and instrument-deconvoluted values. It sits on the Thompson–Cox–Hastings profile
(`profile.ts`): the profile *fits* the broadening; this *interprets* and
*extends* it. Consistent with the rest of the app — GSAS-II units, the same
symmetry-constraint discipline, one refinement engine.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## 1. The broadening model (existing) ✅

Each peak's Lorentzian and Gaussian widths carry the sample information, combined
into one pseudo-Voigt by Thompson–Cox–Hastings:

| Effect | Term | Angular form | Channel |
| --- | --- | --- | --- |
| Crystallite size (Scherrer) | Lorentzian `X` | Γ ∝ 1/cosθ | `lorentzianFwhm` |
| Microstrain (isotropic) | Lorentzian `Y` | Γ ∝ tanθ | `lorentzianFwhm` |
| Microstrain (Gaussian) | Caglioti `U` | Γ² ∝ tan²θ | `cagliotiFwhm` |
| Instrument resolution | Caglioti `U,V,W` | Γ² = U tan²θ + V tanθ + W | `cagliotiFwhm` |

`X`, `Y`, `U`, `V`, `W` are in GSAS-II **centidegrees** (the FWHM used in
`placePeaks` divides by 100). `X`, `Y` are refined in the profile stage.

---

## 2. Size–strain extraction ✅ — `diffraction/microstructure.ts`

`extractSizeStrain` converts refined `X`, `Y` into physical quantities, with
optional **instrument-standard deconvolution** and esd propagation:

- **Crystallite size** (Scherrer, from the Lorentzian size term):
  `D = 18000·K·λ / (π·X)` [Å]. The cosθ cancels between the Scherrer relation
  and the 1/cosθ shape, so a pure size term gives one angle-independent D. K is
  the Scherrer constant (default 0.9). Matches GSAS-II's `p = 18000·K·λ/(π·LX)`.
- **Microstrain** (Williamson–Hall, from the Lorentzian strain term):
  `ε = π·Y / 72000` (dimensionless, from β = 4·ε·tanθ). Reported as ε, ε·100 (%),
  and ε·10⁶ (ppm) — the last matching GSAS-II's microstrain.
- **Instrument deconvolution**: a Lorentzian ⊗ Lorentzian adds *breadths*, so
  `X_s = X_total − X_instr`, `Y_s = Y_total − Y_instr` (the standard — LaB₆/Si/
  CeO₂ — is refined the same way and subtracted). Sub-resolution size/strain is
  flagged rather than reported as a spurious finite value.
- **esd propagation**: σ_D/D = σ_X/X, σ_ε/ε = σ_Y/Y, combined in quadrature with
  the standard's errors.

`williamsonHall` gives the model-independent cross-check: a linear fit of
`β·cosθ = K·λ/D + 4·ε·sinθ` over individually-measured peak breadths (e.g. from
Le Bail / single-peak fits), returning size, strain, and the fit R².

Validated against the GSAS-II constants and a synthetic Williamson–Hall recovery
([`microstructure.test.ts`](../src/core/diffraction/microstructure.test.ts)).

---

## 3. Generalized microstrain — Stephens (1999) ✅ — `diffraction/anisoStrain.ts`

Direction-dependent strain via the phenomenological **Stephens model**: the
variance of `M = 1/d²` is a quartic form in the Miller indices,

    σ²(M) = Σ_{H+K+L=4} S_HKL · hᴴ kᴷ lᴸ ,

with the `S_HKL` restricted by Laue symmetry. The broadening (Gaussian, added in
quadrature to the Caglioti width) is

    Γ_G(2θ) = 2√(2 ln2) · d² · √(σ²(M)) · tanθ ,

derived from δ(2θ) = 2·tanθ·(δd/d) and δd/d = ½·δM/M. For an isotropic strain
(σ(M) = 2ε·M) it reduces exactly to Γ = 4√(2 ln2)·ε·tanθ.

**Symmetry-allowed terms are computed, not tabulated.** A quartic form is
admissible iff it is invariant under the Laue group acting on the indices, so the
allowed `S_HKL` are the invariant subspace of the 15-dim quartic space. The code
builds the Reynolds projector `P = (1/|G|)Σ_g ρ(g)` and takes its symmetrised
monomials as the basis — one refinable `S` per basis form. This reproduces
Stephens' Table 1 counts for *every* Laue class (triclinic 15, monoclinic 9,
orthorhombic 6, cubic m3̄m 2, …) from the operations alone, so hexagonal and
trigonal — where hand-tabulation is error-prone — come out right automatically.

Validated: invariant counts (15/9/6/2), index-permutation symmetry of the cubic
variance, the isotropic-limit identity Γ = 4√(2ln2)·ε·tanθ, and genuine
anisotropy (a Σh²k² strain broadens (hk0) but leaves (h00) untouched)
([`anisoStrain.test.ts`](../src/core/diffraction/anisoStrain.test.ts)).

References: P. W. Stephens, *J. Appl. Cryst.* 32 (1999) 281; N. C. Popa, *J.
Appl. Cryst.* 31 (1998) 176.

---

## 4. Anisotropic size — uniaxial / spheroidal ✅ — `diffraction/anisoSize.ts`

Platelet and needle morphologies via a spheroid of revolution about a unique
reciprocal-lattice axis **t**. The Lorentzian size coefficient interpolates with
the angle ψ between the reflection's scattering vector and the axis:

    X(hkl) = X_⊥ + (X_∥ − X_⊥)·cos²ψ ,   Γ_size = X(hkl)/(100·cosθ) ,

with cosψ from the reciprocal metric (correct for any cell). `X_∥ = X_⊥`
recovers the isotropic Scherrer term, so it is a strict generalisation. The two
coefficients convert to two crystallite dimensions through the same Scherrer
relation as §2 (`uniaxialSizeDimensions`).

Validated: cos²ψ limits (1 along the axis, 0 perpendicular), the isotropic
reduction, and needle/platelet broadening asymmetry
([`anisoSize.test.ts`](../src/core/diffraction/anisoSize.test.ts)).

References: J. I. Langford & D. Louër, *Rep. Prog. Phys.* 59 (1996) 131;
FullProf/GSAS-II uniaxial size models.

---

## 5. Uniaxial microstrain — Mustrain (GSAS-II) ✅ — `diffraction/anisoStrain.ts`

The direction-dependent counterpart of the isotropic Lorentzian `Y` (§1), for
samples whose strain is axial rather than fully general. Equatorial `Y_⊥` and
axial `Y_∥` broaden about a unique reciprocal-lattice axis **t**, interpolating
with the angle ψ between the reflection and the axis exactly as the uniaxial
size does:

    Y(hkl) = Y_⊥ + (Y_∥ − Y_⊥)·cos²ψ ,   Γ_strain = Y(hkl)·tanθ / 100 ,

with cos²ψ from the reciprocal metric (`uniaxialStrainFwhmDeg`). `Y_∥ = Y_⊥`
recovers the isotropic `Y·tanθ` term, so it is a strict generalisation.

**Seeded net-zero.** Both coefficients are seeded from the *refined isotropic*
`Y`, and `placePeaks` applies the uniaxial term as a *correction* on top of the
isotropic Lorentzian (`Γ += uniaxialStrainFwhmDeg(…) − Y·tanθ/100`). At the seed
the correction is exactly zero, so switching Mustrain to uniaxial never perturbs
a converged isotropic fit — it only opens the axial degree of freedom.

Validated: the isotropic reduction (`Y_⊥ = Y_∥`), the axial/equatorial split
about [0,0,1] ((00l) picks `Y_∥`, (hk0) picks `Y_⊥`), and the zero-clamp
([`anisoStrain.test.ts`](../src/core/diffraction/anisoStrain.test.ts)).

### Mustrain model selector + physical readout (UI)

The workbench exposes the microstrain model as a **Mustrain** selector mirroring
GSAS-II — `isotropic | uniaxial | generalized` (uniaxial and generalized are 2θ
CW only; the selector hides uniaxial for TOF):

- **isotropic** — the Lorentzian `Y` alone, surfaced with a **Microstructure
  readout**: `extractSizeStrain` (§2) turns the refined `X`/`Y` into
  `microstrain ≈ N ×10⁻⁶ (P %)` and `size ≈ D nm`, deconvoluting the instrument
  seed. This is the interpretable microstrain a study reports — visible once the
  profile is refined.
- **uniaxial** — adds the `Y_⊥`/`Y_∥` rows above (net-zero seeded).
- **generalized** — the Stephens `S_HKL` of §3.

---

## 6. Refinement integration ✅

Both anisotropic models are wired into the **same** refinement pipeline as every
other parameter, so they refine through the LM engine with correlations/esds:

- **Parameter kinds** `stephensStrain`, `anisoSizePerp`, `anisoSizePar`,
  `mustrainPerp`, `mustrainPar`, surfaced on the applied model by
  `applyParameters` and grouped under **Microstructure** in the parameter tables.
- **Emission**: `buildStructureRefinement({ stephensStrain: true })` emits one
  `S` per computed invariant (seeded 0 = isotropic); `{ uniaxialSize: { axis } }`
  emits `X⊥`, `X∥` (seeded from the isotropic size); `{ uniaxialStrain: { axis } }`
  emits `Y⊥`, `Y∥` (seeded from the isotropic strain `Y`, net-zero at the seed).
  All are unlocked by the **microstructure** stage in the expert sequence (after
  occupancy, before corrections).
- **Evaluation**: `placePeaks` receives each reflection's hkl and adds the
  Stephens Gaussian width in quadrature, the uniaxial-size Lorentzian breadth
  additively, and the uniaxial-strain Lorentzian breadth as a correction over the
  isotropic `Y`; the invariants are cached per space-group operation list. 2θ CW
  only (TOF has its own shape). No behaviour change when the options are off.

End-to-end wiring validated (hkl-dependent broadening through the full powder
calc, plus the uniaxial-strain net-zero-at-seed identity and directional
broadening)
([`microstructureRefinement.test.ts`](../src/core/workflow/microstructureRefinement.test.ts)).

---

## 7. Still open (M6 remainder) ⬜

- **Spherical-harmonic size** — the full ellipsoidal/harmonic crystallite-shape
  model beyond the uniaxial spheroid.
- **General texture (ODF)** — a spherical-harmonic orientation distribution for
  arbitrary sample/crystal symmetry, beyond the single-axis March–Dollase fibre
  texture already in `intensity.ts`.
- **Microabsorption** (Brindley) and flat-plate absorption geometries.
- **Size–strain report + UI** — the inline Microstructure readout (⟨D⟩, ε with
  esd; §5) is done; still open are the Williamson–Hall plot and the anisotropic
  size/strain surfaces.
- **Validation gate** — recover a known size/strain from a NIST line-profile
  standard (LaB₆ 660); match Stephens/March–Dollase coefficients against GSAS-II
  on the same pattern.
