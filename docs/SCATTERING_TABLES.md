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
| **Magnetic** ⟨j0⟩ | [`magneticFormFactorData.ts`](../src/core/scattering/magneticFormFactorData.ts) | `A e^{−a s²} + B e^{−b s²} + C e^{−c s²} + D`, normalized to 1 at s=0 | **97 ions** (3d Sc–Cu, 4d Y–Pd, rare earths Ce–Yb, actinides U–Am, all common valences) | ITC-C Vol. C §4.4.5 (Brown), via the public-domain CrysFML table in `periodictable` |
| **Magnetic** ⟨j2⟩ | [`magneticFormFactorData.ts`](../src/core/scattering/magneticFormFactorData.ts) | `(A e^{−a s²} + … + D)·s²`, → 0 at s=0 | **95 ions** (every ⟨j0⟩ ion except O¹⁺ and Pr³⁺) | same |

The magnetic tables are a **generated file** — do not hand-edit. Regenerate from
the upstream source with [`scripts/gen_magnetic_ff.py`](../scripts/gen_magnetic_ff.py),
which copies coefficients verbatim (no digit-altering float round-trips).
[`magnetic.ts`](../src/core/scattering/magnetic.ts) holds only the evaluation logic.

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
factor is still 1 there. The full API is in place:

- `magneticFormFactorJ2(ion, s)` — ⟨j2⟩, or `NaN` when the ion has no ⟨j2⟩ row.
- `magneticFormFactorDipole(ion, s, g)` — the full expression; **falls back to
  spin-only ⟨j0⟩** when `g = 2` or the ion has no ⟨j2⟩, so it is always safe to call.
- `magneticTable.dipole` / `magneticTable.hasJ2` expose the same via the table.

Both ⟨j0⟩ and ⟨j2⟩ are now populated for the full ITC-C ion set, so `g ≠ 2`
(orbital) refinements are unblocked at the form-factor level.

## Validation

The generated coefficients are guarded by
[`scattering.test.ts`](../src/core/scattering/scattering.test.ts): ⟨j0⟩(0) = 1 for
a spread of 3d/rare-earth/actinide ions, ⟨j2⟩(0) = 0, the dipole term reduces to
⟨j0⟩ at `g = 2`, and an **external reference lock** against `periodictable`'s
Fe²⁺ doctest (`M_Q([0, 0.1, 0.2]) = [1, 0.99935, 0.99741]`), which pins both the
coefficients and the `s = sinθ/λ` convention. Building this table also corrected
a bad **Cr³⁺** ⟨j0⟩ row that had been in the hand-entered table (it normalized to
1 but matched no ITC-C Cr valence).

## Remaining for magnetic refinement (roadmap M4)

1. **5d transition ions (W–Ir)** — not in the CrysFML table; GSAS-II sources
   these from Kobayashi, Nagao & Ito, *Acta Cryst.* A67, 473–480 (2011). Add if a
   5d magnet needs them, from that reference, through the generator.
2. **End-to-end |F_mag|² cross-check** — where a GSAS-II `.lst`/reflection list is
   available, confirm our magnetic |F|² is a flat multiple of GSAS-II's, the same
   gate used for the nuclear structure factor in
   [`neutronSfValidation.test.ts`](../src/core/diffraction/neutronSfValidation.test.ts).

**Do not hand-edit `magneticFormFactorData.ts`** — a wrong 7-coefficient row
silently corrupts the magnetic calculation. Extend the upstream source or the
generator and regenerate, keeping the validation gates above.

## Sources & citations

Full provenance for the coefficient data, for citation and reproducibility. See
[`REFERENCES.md`](./REFERENCES.md) for the project-wide bibliography (including
**GSAS-II**, Toby & Von Dreele 2013 — the validation reference whose `.lst`
neutron `b` and `atmdata` magnetic conventions were cross-checked against the
tables below). Web resources accessed **2026-07-08**.

### Neutron scattering lengths (`neutron.ts`)

- **Primary reference:** Sears, V. F. (1992). "Neutron scattering lengths and
  cross sections." *Neutron News* **3**(3), 26–37.
  doi:[10.1080/10448639208218770](https://doi.org/10.1080/10448639208218770)
- **Convenient tabulation:** NIST Center for Neutron Research, "Neutron
  scattering lengths and cross sections,"
  <https://www.ncnr.nist.gov/resources/n-lengths/>
- Cross-checked against printed values in bundled GSAS-II `.lst` files.

### X-ray form factors (`xray.ts`)

- **Primary reference:** Cromer, D. T. & Mann, J. B. (1968). "X-ray scattering
  factors computed from numerical Hartree–Fock wave functions." *Acta Cryst.*
  **A24**, 321–324.
  doi:[10.1107/S0567739468000550](https://doi.org/10.1107/S0567739468000550)
- **Tabulated form used** (4-Gaussian coefficients): International Tables for
  Crystallography Vol. C, Table 6.1.1.4.

### Magnetic form factors ⟨j0⟩ / ⟨j2⟩ (`magneticFormFactorData.ts`)

- **Primary reference:** Brown, P. J. "Magnetic form factors," §4.4.5 in
  *International Tables for Crystallography Vol. C* (A. J. C. Wilson & E. Prince,
  eds.). IUCr online:
  <https://onlinelibrary.wiley.com/iucr/itc/Cb/ch4o4v0001/sec4o4o5/>
- **Analytic form** (three-Gaussian ⟨jₙ⟩) follows Forsyth, J. B. & Wells, M.
  (1959), *Acta Cryst.* **12**, 412–415, extended by Brown from two terms to three.
- **Redistribution actually imported:** the `periodictable` Python package
  (author Paul Kienzle, released into the public domain), file `magnetic_ff.py`,
  which transcribes the CrysFML `Magnetic_Form` table (itself the ITC-C data).
  - Raw file: <https://raw.githubusercontent.com/pkienzle/periodictable/master/periodictable/magnetic_ff.py>
  - Docs: <https://periodictable.readthedocs.io/en/latest/api/magnetic_ff.html>
- **Independent copies for cross-checking:**
  - ILL/CCSL "Magnetic Form Factors" (ffacts), <https://www.ill.eu/sites/ccsl/ffacts/>
    — the P. J. Brown / CCSL data (returned HTTP 404 on the access date above; the
    coefficients live on unchanged in the mirrors here).
  - GSAS-II `atmdata.py` (`MagFormFactors`),
    <https://subversion.xray.aps.anl.gov/pyGSAS/trunk/atmdata.py>
- **5d transition ions (W–Ir), not yet imported:** Kobayashi, K., Nagao, T. &
  Ito, M. (2011). "Radial integrals for the magnetic form factor of 5d transition
  elements." *Acta Cryst.* **A67**, 473–480.
  doi:[10.1107/S010876731102633X](https://doi.org/10.1107/S010876731102633X)
  (the source GSAS-II uses for these ions).

### Regeneration

The magnetic table is produced by
[`scripts/gen_magnetic_ff.py`](../scripts/gen_magnetic_ff.py), which fetches the
`periodictable` raw file above and copies coefficients verbatim. Re-running it
reproduces `magneticFormFactorData.ts` byte-for-byte from the cited source.
