# Scattering & form-factor tables

All scattering parameters live in one place — [`src/core/scattering/`](../src/core/scattering/) —
behind small, replaceable interfaces ([`types.ts`](../src/core/scattering/types.ts)),
so the structure-factor calculators never hard-code a constant. This is the
single home for neutron scattering lengths, X-ray form factors, and magnetic
form factors; extend the records here, not the calculators.

The scattering variable throughout is `s = sinθ/λ = 1/(2d)` (Å⁻¹).

## The tables

| Table | File | Form | Coverage | Source |
|---|---|---|---|---|
| **Neutron** `b` | [`neutronData.ts`](../src/core/scattering/neutronData.ts) | Constant bound coherent length `b = b′ − i·b″` (fm), s-independent, complex for absorbers | **88 elements + D, 248 isotopes** (Pu, Cm and Am by isotope only) | Sears (1992) *Neutron News*, as entered by NIST; one evaluation (Hf corrected to 7.77) |
| **X-ray** `f(s)` | [`cromerMannData.ts`](../src/core/scattering/cromerMannData.ts) | 4-Gaussian Cromer–Mann `Σ aᵢe^{−bᵢs²} + c` | **98 neutral atoms** (H–Cf) | International Tables Vol. C Table 6.1.1.4 (DABAX `f0_InterTables`, checked row by row against cctbx `it1992`); f(0)=Z verified per row |
| **Magnetic** ⟨j0⟩ | [`magneticFormFactorData.ts`](../src/core/scattering/magneticFormFactorData.ts) | `A e^{−a s²} + B e^{−b s²} + C e^{−c s²} + D`, normalized to 1 at s=0 | **97 ions** (3d Sc–Cu, 4d Y–Pd, rare earths Ce–Yb, actinides U–Am, all common valences) | ITC-C Vol. C §4.4.5 (Brown), via the public-domain CrysFML table in `periodictable` |
| **Magnetic** ⟨j2⟩ | [`magneticFormFactorData.ts`](../src/core/scattering/magneticFormFactorData.ts) | `(A e^{−a s²} + … + D)·s²`, → 0 at s=0 | **95 ions** (every ⟨j0⟩ ion except O¹⁺ and Pr³⁺) | same |

**All four tables are generated files** — do not hand-edit. Each `*Data.ts` is
produced from a cited source by its generator, with the evaluation logic kept in
the sibling module (`neutron.ts`, `xray.ts`, `magnetic.ts`):

- Neutron — [`scripts/gen_neutron_b.py`](../scripts/gen_neutron_b.py). Reads
  the NIST table of Sears (1992), pinned by SHA-256 of its extracted rows, and
  emits every element and isotope that prints a value, complex parts included.
  Pu and Cm print no element value (their isotopes differ by up to 10 fm), so a
  Pu or Cm site must name its isotope. Am's row is the ²⁴³Am value (its
  half-life is printed), so it is emitted as ²⁴³Am and an Am site must name
  its isotope too. Hf is corrected from NIST's 7.7 to 7.77 (below).
- X-ray — [`scripts/gen_xray_ff.py`](../scripts/gen_xray_ff.py). All neutral
  atoms from the ITC-C Cromer–Mann parametrization. Two pinned transcriptions
  are read (DABAX `f0_InterTables.dat` and cctbx `it1992.cpp`); every row must
  agree between them and give `f(0)=Z` within 0.1 e. DABAX prints the ITC Np4+
  row under "Pu" (f(0) = 89), so Pu comes from the cctbx transcription — the
  same row gemmi and GSAS-II carry (f(0) = 93.965).
- Magnetic — [`scripts/gen_magnetic_ff.py`](../scripts/gen_magnetic_ff.py),
  copying coefficients verbatim (no digit-altering float round-trips).

Only **neutral-atom** X-ray form factors are tabulated; the structure-factor
code looks up by element symbol and does not yet use ionic X-ray species (the
DABAX source carries them, so `gen_xray_ff.py` can be widened when needed).

The neutron `b` table covers nuclear scattering only. Its isotope entries are
used when a site sets `isotope` (a mass number); an isotope Sears does not list
is an error, never a fall-back to the natural value. For magnetic neutron
scattering, an ion's form factor comes from the ⟨j0⟩/⟨j2⟩ table below.

## Magnetic form factor — spin-only and dipole

Every magnetic calculation uses the **spin-only** approximation
`f(s) ≈ ⟨j0⟩(s)`: the magnetic structure factor
([`structureFactor.ts`](../src/core/magnetic/structureFactor.ts)), the GPU
magnetic kernel, and the magnetic PDF envelope.

For moments with an orbital contribution (Landé `g ≠ 2`) — most real magnetic
refinements — the **dipole approximation** is required:

```
f(s) ≈ ⟨j0⟩(s) + (2/g − 1)·⟨j2⟩(s)
```

This is Lovesey (1984) eq. 11.110. The spin part of the moment carries ⟨j0⟩ and
the orbital part carries ⟨j0⟩ + ⟨j2⟩. The ⟨j2⟩ weight is therefore the orbital
fraction of the moment, μ_L/μ = (2 − g)/g, which is positive for g < 2.

`⟨j2⟩` carries an `s²` prefactor, so it vanishes at `s = 0` and the total form
factor is still 1 there. The functions exist, but no calculation calls them yet:

- `magneticFormFactorJ2(ion, s)` — ⟨j2⟩, or `NaN` when the ion has no ⟨j2⟩ row.
- `magneticFormFactorDipole(ion, s, g)` — the full expression; **falls back to
  spin-only ⟨j0⟩** when `g = 2` or the ion has no ⟨j2⟩, so it is always safe to call.
- `magneticTable.dipole` / `magneticTable.hasJ2` expose the same via the table.

Both ⟨j0⟩ and ⟨j2⟩ cover the full ITC-C ion set, so the tables are ready for
`g ≠ 2`. Using the dipole form in the structure factor is the remaining step.

## Validation

The generated coefficients are guarded by
[`scattering.test.ts`](../src/core/scattering/scattering.test.ts): ⟨j0⟩(0) = 1 for
a spread of 3d/rare-earth/actinide ions, ⟨j2⟩(0) = 0, the dipole term reduces to
⟨j0⟩ at `g = 2`, Tb³⁺ (g = 3/2) gives f = 0.499 at Q = 5 Å⁻¹ with the
Lovesey/Mantid sign, and an **external reference lock** against `periodictable`'s
Fe²⁺ doctest (`M_Q([0, 0.1, 0.2]) = [1, 0.99935, 0.99741]`), which pins both the
coefficients and the `s = sinθ/λ` convention.

End to end, the magnetic |F_M|² matches GSAS-II within ±5% on all 82 reflections
of the Mn₃Ga 350 K data
([`mn3ga350KGolden.test.ts`](../src/core/workflow/mn3ga350KGolden.test.ts)).

## Not yet

1. **The dipole form factor in calculations** — the structure factor, GPU kernel
   and magnetic PDF use ⟨j0⟩ only (above).
2. **5d transition ions (W–Ir)** — not in the CrysFML table. GSAS-II takes them
   from Kobayashi, Nagao & Ito, *Acta Cryst.* A67, 473–480 (2011); add them from
   that reference, through the generator, when a 5d magnet needs them.
3. **Ionic X-ray form factors** — only neutral atoms are tabulated (above).

**Do not hand-edit `magneticFormFactorData.ts`.** A wrong 7-coefficient row
silently corrupts the magnetic calculation — a hand-entered Cr³⁺ row once
normalized to 1 while matching no ITC-C valence. Extend the upstream source or
the generator and regenerate, keeping the validation gates above.

## Sources & citations

Full provenance for the coefficient data, for citation and reproducibility. See
[`REFERENCES.md`](./REFERENCES.md) for the project-wide bibliography (including
**GSAS-II**, Toby & Von Dreele 2013 — the validation reference whose `.lst`
neutron `b` and `atmdata` magnetic conventions were cross-checked against the
tables below). Web resources accessed **2026-07-08**.

### Neutron scattering lengths (`neutron.ts`)

- **Evaluation used:** Sears, V. F. (1992). "Neutron scattering lengths and
  cross sections." *Neutron News* **3**(3), 26–37.
  doi:[10.1080/10448639208218770](https://doi.org/10.1080/10448639208218770)
  — the one evaluation for every element. The single correction is Hf (below);
  GSAS-II's per-element pins are gone.
- **Redistribution actually imported:** the NIST Center for Neutron Research
  table "Neutron scattering lengths and cross sections"
  (<https://www.ncnr.nist.gov/resources/n-lengths/list.html>), NIST's manual
  entry of Sears (1992). The page cannot be pinned by URL, so the generator pins
  the SHA-256 of its extracted data rows (`dcf8ea74…`, the same snapshot as
  ScatterPlan's `data-sources/snapshots/nist-sears1992.tsv`).
- **Sign convention.** Sears prints `b = b′ − i·b″`, with `b″ ≥ 0` for an
  absorbing nucleus (B, Cd, In, Sm, Eu, Gd, Dy, …). The table stores that as
  printed. That is the physics convention (scattered amplitude ∝ Σ b·e^{−iQ·r});
  the crystallographic `F = Σ a·e^{+2πi h·x}` is its complex conjugate, so the
  structure factor uses `a = conj(b) = b′ + i·b″` (`neutronAmplitude`), the same
  sign as X-ray f″. Taking the printed b directly would give I(−h): powder
  patterns and centrosymmetric crystals would not notice, Bijvoet differences of
  a non-centrosymmetric crystal would flip. The real-space PDF weights a pair by
  Re(b_i·b_j*) and normalizes by |⟨b⟩|² (`compositionWeights`).
- **Not used:** the ITC Vol. C §4.4.4 edition as redistributed by
  `Dans_Diffraction` (the previous source of this table). It revises Ti, Mn, Zn
  and Hf, gives In as 2.08 fm (In's σ_coh in barn; Sears prints 4.065 − 0.0539i),
  assigns the ²³⁸Pu and ²⁴⁴Cm values to the elements, and stores the imaginary
  part with inconsistent signs. Also not used: Rauch & Waschkowski (2003) plus
  newer measurements, GSAS-II's `AtmBlens` (e.g. Au 7.90 there, 7.63 here).
- The GSAS-II validation elements (Mn, O, Ga, Sn, Co, Fe) print the same values
  in its `.lst` output.
- **Known inconsistencies in the printed table:** b and σ_coh = 4π|b|²/100
  disagree beyond rounding for Sn, Xe, Eu and Hf. Sn, Xe and Eu are used as
  printed. Hf is corrected: NIST's 7.7 fm gives 7.45 b against its σ_coh of
  7.6 b, while 7.77 fm (the ITC edition and Rauch 2003) fits, so 7.7 is read as
  an entry error. The generator applies this only while NIST still prints 7.7.
- **Am:** the table's Am row carries a half-life of 7.37E3 a, i.e. it is the
  ²⁴³Am value; the common ²⁴¹Am is not tabulated. It is emitted as "243Am", and
  an Am site must set its isotope.

### X-ray form factors (`xray.ts`)

- **Primary reference:** Cromer, D. T. & Mann, J. B. (1968). "X-ray scattering
  factors computed from numerical Hartree–Fock wave functions." *Acta Cryst.*
  **A24**, 321–324.
  doi:[10.1107/S0567739468000550](https://doi.org/10.1107/S0567739468000550)
- **Tabulated form used** (4-Gaussian coefficients): International Tables for
  Crystallography Vol. C, pp. 500–502 / Table 6.1.1.4.
- **Redistribution actually imported:** the ESRF **DABAX** `f0_InterTables.dat`
  table (oasys-kit/DabaxFiles @ `70ff903`, SHA-256 `d8c594a8…`), checked row by
  row against the cctbx `it1992.cpp` transcription (cctbx_project @ `d2d1c70`,
  SHA-256 `7ca28976…`). All 98 neutral atoms; Pu is taken from cctbx because the
  DABAX Pu/Np3+/Np4+/Np6+ rows are shuffled.

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
