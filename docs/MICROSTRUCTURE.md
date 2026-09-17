# Powder microstructure: crystallite size and microstrain

This layer turns fitted peak broadening into crystallite size ⟨D⟩, microstrain ε,
their anisotropy and instrument-deconvoluted values, in GSAS-II units. The peak
profile (§1) fits the broadening; this layer interprets and extends it.

Summary: [LIMITATIONS.md](./LIMITATIONS.md#powder-diffraction). Evidence:
[VALIDATION.md](./VALIDATION.md). Work order: M6 in [ROADMAP.md](./ROADMAP.md).
Controls: [USER_GUIDE.md](./USER_GUIDE.md#4-powder-rietveld-refinement).

Status legend: ✅ done · 🚧 in progress · ⬜ not started

## 1. The broadening model ✅

The Thompson–Cox–Hastings profile combines each peak's Lorentzian and Gaussian
widths into one pseudo-Voigt ([profile.ts](../src/core/diffraction/profile.ts):
`lorentzianFwhm`, `cagliotiFwhm`). X and Y refine in the profile stage.

| Effect | Term | Angular form |
| --- | --- | --- |
| Crystallite size (Scherrer) | Lorentzian X | Γ ∝ 1/cosθ |
| Microstrain, isotropic | Lorentzian Y | Γ ∝ tanθ |
| Microstrain, Gaussian | Caglioti U | Γ² ∝ tan²θ |
| Instrument resolution | Caglioti U, V, W | Γ² = U tan²θ + V tanθ + W |

| Quantity | Unit |
| --- | --- |
| X, Y and their ⊥, ∥ forms | GSAS-II centidegrees; `placePeaks` divides each FWHM by 100 |
| U, V, W | centidegrees² |
| Stephens S_HKL | Å⁻⁴, as a variance of 1/d² |
| TOF Mustrain; TOF σ | ×10⁻⁶ (µstrain); µs |

## 2. Size–strain extraction ✅

`extractSizeStrain` converts refined X and Y into physical values, with optional
instrument deconvolution and esds
([microstructure.ts](../src/core/diffraction/microstructure.ts)).

| Quantity | Formula | Note |
| --- | --- | --- |
| Size (Scherrer) | D = 18000·K·λ / (π·X) [Å], shown in nm | K = 0.9 by default; cosθ cancels, so D is angle-independent; GSAS-II's p = 18000·K·λ/(π·LX) |
| Microstrain (Williamson–Hall) | ε = π·Y / 72000, shown in % and ×10⁻⁶ | from β = 4·ε·tanθ; ε·10⁶ is GSAS-II's microstrain |

- **Deconvolution.** Lorentzian breadths add, so the code subtracts a standard
  (LaB₆, Si, CeO₂) refined the same way: X_s = X − X_instr, Y_s = Y − Y_instr.
- **Limits and esds.** X_s ≤ 0 gives D = ∞ and Y_s < 0 gives ε = 0, each with a
  note. σ_D/D = σ_X/X and σ_ε/ε = σ_Y/Y, in quadrature with the standard's.
- `williamsonHall`, the model-independent cross-check, fits
  β·cosθ = K·λ/D + 4·ε·sinθ to separately measured peak breadths and returns
  size, strain and R².
- Checked against the GSAS-II constants and a synthetic Williamson–Hall recovery
  ([microstructure.test.ts](../src/core/diffraction/microstructure.test.ts)).

## 3. Generalized microstrain: Stephens (1999) ✅

In the Stephens model the variance of M = 1/d² is a quartic form in the Miller
indices, with S_HKL restricted by Laue symmetry
([anisoStrain.ts](../src/core/diffraction/anisoStrain.ts)):

    σ²(M) = Σ_{H+K+L=4} S_HKL · hᴴ kᴷ lᴸ

| Data | Broadening | Added to |
| --- | --- | --- |
| CW | Γ_G(2θ) = 2√(2 ln2) · d² · √σ²(M) · tanθ | the Caglioti width, in quadrature |
| TOF | σ_T = \|dT/dd\| · ½·d³·√σ²(M) | the TOF Gaussian variance |

- The CW form follows from δ(2θ) = 2·tanθ·(δd/d) and δd/d = ½·δM/M. Isotropic
  strain, σ(M) = 2ε·M, gives exactly Γ = 4√(2 ln2)·ε·tanθ.
- **Computed terms.** The allowed forms are the Laue-invariant ones. The
  Reynolds operator P = (1/|G|)·Σ_g ρ(g) projects the 15-term quartic space, and
  one S refines per symmetrized basis form.
- Tests confirm Stephens' counts of 15, 9, 6 and 2 terms for triclinic,
  monoclinic, orthorhombic and cubic m3̄m, but not for tetragonal, trigonal or
  hexagonal classes.
  They also check cubic index symmetry, the isotropic limit, and (hk0)-only
  broadening from Σh²k² ([anisoStrain.test.ts](../src/core/diffraction/anisoStrain.test.ts)).

References: P. W. Stephens, *J. Appl. Cryst.* **32** (1999) 281–289,
doi:[10.1107/S0021889898006001](https://doi.org/10.1107/S0021889898006001);
N. C. Popa, *J. Appl. Cryst.* **31** (1998) 176–180,
doi:[10.1107/S0021889897009795](https://doi.org/10.1107/S0021889897009795).

## 4. Anisotropic size: uniaxial spheroid ✅

A spheroid about a unique reciprocal axis t models platelets and needles, with ψ
the angle between the reflection and t
([anisoSize.ts](../src/core/diffraction/anisoSize.ts)):

    X(hkl) = X_⊥ + (X_∥ − X_⊥)·cos²ψ ,   Γ_size = X(hkl) / (100·cosθ)

- cosψ uses the reciprocal metric, so any cell works. X_∥ = X_⊥ recovers the
  isotropic Scherrer term.
- `uniaxialSizeDimensions` converts X⊥ and X∥ into two sizes with the Scherrer
  relation (§2).
- Checked: the cos²ψ limits, the isotropic reduction, and needle versus platelet
  broadening ([anisoSize.test.ts](../src/core/diffraction/anisoSize.test.ts)).
  The pipeline test (§6) checks only emission and a finite pattern.

**Approximate**
- Core only: no workbench control or agent option enables it.
- `placePeaks` adds it on top of the isotropic X, and X⊥ and X∥ start at X, so
  the start doubles the size broadening.

References: J. I. Langford & D. Louër, *Rep. Prog. Phys.* **59** (1996) 131–234,
doi:[10.1088/0034-4885/59/2/002](https://doi.org/10.1088/0034-4885/59/2/002);
the FullProf and GSAS-II uniaxial size models.

## 5. Uniaxial microstrain: GSAS-II Mustrain ✅

Equatorial Y⊥ and axial Y∥ broaden about a unique axis t, like the uniaxial
size (`uniaxialStrainFwhmDeg` in `anisoStrain.ts`):

    Y(hkl) = Y_⊥ + (Y_∥ − Y_⊥)·cos²ψ ,   Γ_strain = Y(hkl)·tanθ / 100

- Y_∥ = Y_⊥ recovers the isotropic Y·tanθ.
- **Net zero at the start.** `placePeaks` adds
  `uniaxialStrainFwhmDeg(…) − Y·tanθ/100`, so Y⊥ and Y∥ replace Y. Both start
  at the Y given to `buildStructureRefinement`.
- Checked in `anisoStrain.test.ts`: the isotropic reduction, the split about
  [0, 0, 1] and the zero clamp. §6 checks the net-zero identity.

**Approximate**
- The workbench and `build_refinement` pass the instrument file's Y, not the
  refined Y, so switching after an isotropic refinement can change the fit.
- The workbench fixes t at [0, 0, 1].

### 5.1 Isotropic Mustrain for TOF ✅

TOF has no Lorentzian Y, so strain enters the Gaussian variance. A constant
ε = Δd/d spreads d by ε·d, mapped through T(d) = difC·d + difA·d² + difB/d
(`isotropicStrainSigmaTof`):

    σ_T = |difC + 2·difA·d − difB/d²| · ε·d        [µs, added in quadrature]

- The broadening grows ∝ d, against ∝ d² for size.
- It is exactly the isotropic limit of the Stephens TOF σ (§3), since
  σ²(M) = 4ε²/d⁴ gives σ_d = ε·d; tests agree to 8 digits.
- As in GSAS-II, it is a named µstrain parameter, which `buildPowderSpec` starts
  at Δd/d = 0.0015 (1500 ×10⁻⁶).
- Emitting it drops the instrument σ₁² term, whose ∝ d² variance would make the
  pair exactly degenerate. The generalized model keeps σ₁².
- Checked: the Stephens identity and ∝ d scaling in `anisoStrain.test.ts`, and
  emission and broadening in
  [tofMicrostrain.test.ts](../src/core/workflow/tofMicrostrain.test.ts).

### 5.2 Mustrain selector and readout

The Mustrain selector and the `build_refinement` agent tool offer GSAS-II's
three models.

| Setting | CW (2θ) | TOF |
| --- | --- | --- |
| isotropic | Lorentzian Y | µstrain parameter (§5.1) |
| uniaxial | Y⊥, Y∥ (§5) | hidden; falls back to isotropic |
| generalized | Stephens S_HKL (§3) | Stephens S_HKL (§3) |

- On CW data, uniaxial and generalized need a Caglioti instrument profile.
- The Microstructure readout and `interpret_structure` report microstrain, and
  size for CW. CW values come from `extractSizeStrain`; TOF uses the µstrain
  parameter.
- Both subtract starting values, as breadths for CW and as variances in
  quadrature for TOF.

**Approximate**
- The starting values are not a refined standard: the instrument file's X and
  Y for CW (X = 1, Y = 0 if absent), and 1500 ×10⁻⁶ for TOF.
- With uniaxial on, the readout still converts the isotropic Y, although Y⊥ and
  Y∥ set the width.

## 6. Refinement integration ✅

These parameters refine through the one LM engine, with correlations and esds.

| Kind | `buildStructureRefinement` option | Start | Stage |
| --- | --- | --- | --- |
| `stephensStrain`, one per invariant | `stephensStrain: true` | 0 | microstructure |
| `anisoSizePerp`, `anisoSizePar` | `uniaxialSize: { axis }` | isotropic X | microstructure |
| `mustrainPerp`, `mustrainPar` | `uniaxialStrain: { axis }` | isotropic Y | microstructure |
| `mustrainIso`, which drops σ₁² | `mustrainIso: µstrain` | given value | profile |

- The microstructure stage runs after occupancy and before corrections.
- Rule: refine `mustrainIso` in the profile stage; frozen at its start, its σ₁²
  width would keep wR above the previous best.
- `placePeaks` (2θ CW) adds Stephens in quadrature, uniaxial size directly and
  uniaxial strain as a correction to Y. `buildTofPeaks` adds `mustrainIso` and
  Stephens in quadrature.
- Options left off change nothing.
- Checked end to end: hkl-dependent Stephens broadening, and the uniaxial-strain
  net-zero identity and directional broadening
  ([microstructureRefinement.test.ts](../src/core/workflow/microstructureRefinement.test.ts)).

**Approximate**
- All phases share one isotropic size and strain (X, Y, `mustrainIso`); only
  the anisotropic terms are per phase.

## 7. Still open ⬜

**Not yet** ([ROADMAP.md](./ROADMAP.md) M6 sets the order of work):
- Spherical-harmonic size: a full ellipsoidal or harmonic crystallite shape
  beyond the uniaxial spheroid.
- General texture: a spherical-harmonic orientation distribution for any sample
  and crystal symmetry, beyond single-axis March–Dollase (`intensity.ts`).
- Microabsorption (Brindley) and flat-plate absorption geometries.
- Size–strain reporting: a Williamson–Hall plot and anisotropic size and strain
  surfaces in the UI, and derived ⟨D⟩ and ε in the HTML report.
- A workbench or agent-tool switch for uniaxial size (§4).
- Validation gate: recover a known size and strain from a NIST line-profile
  standard (LaB₆ 660), and match Stephens and March–Dollase coefficients against
  GSAS-II on the same pattern.
