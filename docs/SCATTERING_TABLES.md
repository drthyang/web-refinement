# Scattering & form-factor tables

All scattering parameters live in one place — [`src/core/scattering/`](../src/core/scattering/) —
behind small, replaceable interfaces ([`types.ts`](../src/core/scattering/types.ts)),
so the structure-factor calculators never hard-code a constant. This is the
single home for neutron scattering lengths, X-ray form factors, and magnetic
form factors; extend the records here, not the calculators.

The scattering variable throughout is `s = sinθ/λ = 1/(2d)` (Å⁻¹).

## What exists today

| Table | File | Form | Coverage | Source |
|---|---|---|---|---|
| **Neutron** `b` | [`neutron.ts`](../src/core/scattering/neutron.ts) | Constant bound coherent length `b` (fm), s-independent | **52 elements** (H–Bi, common isotopes) | Sears (1992); cross-checked vs. GSAS-II `.lst` (Mn −3.73, O 5.80, Ga 7.29, Sn 6.23, …) |
| **X-ray** `f(s)` | [`xray.ts`](../src/core/scattering/xray.ts) | 4-Gaussian Cromer–Mann `Σ aᵢe^{−bᵢs²} + c` | **14 elements** | International Tables Vol. C; f(0)=Z verified in tests |
| **Magnetic** ⟨j0⟩ | [`magnetic.ts`](../src/core/scattering/magnetic.ts) | `A e^{−a s²} + B e^{−b s²} + C e^{−c s²} + D`, normalized to 1 at s=0 | **8 ions** (Mn²⁺³⁺⁴⁺, Fe²⁺³⁺, Cr³⁺, Co²⁺, Ni²⁺) | International Tables Vol. C / Brown compilation |
| **Magnetic** ⟨j2⟩ | [`magnetic.ts`](../src/core/scattering/magnetic.ts) | `(A e^{−a s²} + … + D)·s²` | **scaffolded, unpopulated** | — |

Neutron scattering lengths are used for **both** nuclear structure factors and,
via ⟨j0⟩/⟨j2⟩, the magnetic form factor of an ion — so "the neutron table for
magnetic ions" is the magnetic ⟨j0⟩/⟨j2⟩ table below.

## Magnetic form factor — spin-only and dipole

The current magnetic structure factor uses the **spin-only** approximation
`f(s) ≈ ⟨j0⟩(s)` ([`structureFactor.ts`](../src/core/magnetic/structureFactor.ts)).

For moments with an orbital contribution (Landé `g ≠ 2`) — most real magnetic
refinements — the **dipole approximation** is required:

```
f(s) ≈ ⟨j0⟩(s) + (1 − 2/g)·⟨j2⟩(s)
```

`⟨j2⟩` carries an `s²` prefactor, so it vanishes at `s = 0` and the total form
factor is still 1 there. The API is already in place:

- `magneticFormFactorJ2(ion, s)` — ⟨j2⟩, or `NaN` when the ion is unpopulated.
- `magneticFormFactorDipole(ion, s, g)` — the full expression; **falls back to
  spin-only ⟨j0⟩** when `g = 2` or the ion has no ⟨j2⟩, so it is always safe to
  call and improves automatically as `J2_COEFFS` is filled.
- `magneticTable.dipole` / `magneticTable.hasJ2` expose the same via the table.

## Preparing for magnetic refinement (roadmap M4)

Ordered by what unblocks the most:

1. **Populate `J2_COEFFS`** for the eight ions already in `J0_COEFFS`, from
   International Tables Vol. C — this switches the dipole approximation on for
   `g ≠ 2` with zero calculator changes.
2. **Expand ⟨j0⟩/⟨j2⟩ ion coverage** to the common 3d ions (V, Ti, Cr²⁺/⁴⁺,
   Cu²⁺, Co³⁺, Ni³⁺) and the rare earths (Ce–Yb) needed for f-electron magnets.
3. **Cross-check** every added row: verify ⟨j0⟩(0) = 1, monotonic falloff, and,
   where a GSAS-II `.lst`/reflection list is available, that our |F_mag|² is a
   flat multiple of GSAS-II's (the same gate used for the nuclear structure
   factor in [`neutronSfValidation.test.ts`](../src/core/diffraction/neutronSfValidation.test.ts)).

Adding coefficients is a data-entry-plus-validation task; **do not** paste
unverified numbers — a wrong 7-coefficient row silently corrupts the magnetic
calculation. Add rows with a source citation and a test.
