# References

The single bibliography for this project — every external paper, dataset, or
software we rely on, **with how it is actually used**. The categories are
deliberate: they answer "do we actually use this?" honestly, so the reference
list can't quietly inflate into things we merely read once.

Web resources accessed **2026-07-08**.

## Software we validate against (must cite in any published use)

- **GSAS-II** — Toby, B. H. & Von Dreele, R. B. (2013). "GSAS-II: the genesis of
  a modern open-source all purpose crystallography software package."
  *J. Appl. Cryst.* **46**, 544–549.
  doi:[10.1107/S0021889813003531](https://doi.org/10.1107/S0021889813003531).
  This is the project's **primary external correctness gate**, and it is genuinely
  used, not decorative:
  - Golden-value tests — reciprocal metric tensor, site multiplicities, nuclear
    structure factors, neutron `b`/magnetic ⟨j0⟩ — check our numbers against
    GSAS-II output ([`VALIDATION.md`](./VALIDATION.md)).
  - The real GaNb₄Se₈ benchmark compares our staged fit against GSAS-II's
    extracted calc + reflection list ([`gsasBenchmark.test.ts`](../src/core/workflow/gsasBenchmark.test.ts)).
  - Its `.lst` printed neutron scattering lengths and its `atmdata` magnetic
    conventions were **inspected** when building the scattering tables.
  - We reimplement independently — **no GSAS-II source is copied** — but because
    its outputs are our validation reference, it must be cited.
  - Source browsed: <https://github.com/AdvancedPhotonSource/GSAS-II> ·
    `atmdata.py` at <https://subversion.xray.aps.anl.gov/pyGSAS/trunk/atmdata.py>

- Compared against at the *feature* level only (in [`COMPARISON.md`](./COMPARISON.md)),
  not used as data or validation sources: **FullProf** (Rodríguez-Carvajal 1993,
  *Physica B* **192**, 55) and **Jana2020** (Petříček et al. 2023,
  *Z. Kristallogr.*).

## Data actually used (values live in the codebase)

- **Neutron scattering lengths** — Sears, V. F. (1992). *Neutron News* **3**(3),
  26–37. doi:[10.1080/10448639208218770](https://doi.org/10.1080/10448639208218770).
  → [`neutron.ts`](../src/core/scattering/neutron.ts).
- **X-ray form factors (Cromer–Mann)** — Cromer, D. T. & Mann, J. B. (1968).
  *Acta Cryst.* **A24**, 321–324.
  doi:[10.1107/S0567739468000550](https://doi.org/10.1107/S0567739468000550);
  4-Gaussian coefficients as tabulated in International Tables Vol. C Table
  6.1.1.4. → [`xray.ts`](../src/core/scattering/xray.ts).
- **Magnetic form factors ⟨j0⟩/⟨j2⟩** — Brown, P. J., §4.4.5 in *International
  Tables for Crystallography Vol. C*. Analytic form after Forsyth & Wells (1959),
  extended to three Gaussians. Imported **verbatim** via the public-domain
  `periodictable` package (P. Kienzle) →
  [`magneticFormFactorData.ts`](../src/core/scattering/magneticFormFactorData.ts).
  Full provenance in [`SCATTERING_TABLES.md`](./SCATTERING_TABLES.md).

## Referenced but not yet used

- **Kobayashi, K., Nagao, T. & Ito, M. (2011).** *Acta Cryst.* **A67**, 473–480.
  doi:[10.1107/S010876731102633X](https://doi.org/10.1107/S010876731102633X).
  The 5d W–Ir magnetic form factors — **not imported**. Cite only if/when those
  ions are added to the table.

## Method background (informs the engine; no single source)

- The refinement engine's numerics — Levenberg–Marquardt, diagonal (Jacobi)
  scaling of the normal matrix, SVD truncation of near-null directions, staged
  parameter unlocking — follow **standard** nonlinear least-squares and Rietveld
  practice distilled in [`../knowledge/`](../knowledge/). No single paper is the
  source. If a specific scaling/Jacobian-conditioning paper is later attached, it
  belongs here, tied to [`REFINEMENT_ENGINE.md`](./REFINEMENT_ENGINE.md).
