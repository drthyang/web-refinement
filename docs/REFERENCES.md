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

- **Segal, N., Subramanian, A., Li, M., Miller, B. K. & Gómez-Bombarelli, R.
  (2026).** "The loss landscape of powder X-ray diffraction-based structure
  optimization is too rough for gradient descent." *Digital Discovery* **5**,
  1590–1599. doi:[10.1039/D6DD00017G](https://doi.org/10.1039/D6DD00017G) ·
  arXiv:[2512.04036](https://arxiv.org/abs/2512.04036). Maps the loss landscape of
  the *inverse* (diffraction → structure) problem: whole-pattern similarity
  metrics (cosine / MSE / entropy) are too non-convex for gradient descent,
  projecting onto the ground-truth crystal family markedly improves recovery, and
  a universal-interatomic-potential energy landscape is a smooth complement.
  **Not implemented** — it grounds the loss-landscape discussion in
  [`../knowledge/refinement_fitting_algorithms_knowledge.md`](../knowledge/refinement_fitting_algorithms_knowledge.md)
  §16, and motivates future symmetry-aware / energy-guided directions. Cite
  if/when an inverse solver or MLIP-energy restraint is added.

## Physics formulas implemented (each tied to code)

- **Neutron magnetic scattering length** p = γ_n·r_e/2 = 2.695 fm/μ_B, and the
  Halpern–Johnson perpendicular-moment projection M⊥ = M − (M·Q̂)Q̂ — Squires,
  G. L., *Introduction to the Theory of Thermal Neutron Scattering* (CUP);
  Lovesey, S. W., *Theory of Neutron Scattering from Condensed Matter*, Vol. 2.
  → [`magnetic/structureFactor.ts`](../src/core/magnetic/structureFactor.ts),
  [`magnetic/moment.ts`](../src/core/magnetic/moment.ts).
- **Peak-width (Caglioti)** FWHM² = U tan²θ + V tanθ + W — Caglioti, G.,
  Paoletti, A. & Ricci, F. P. (1958). *Nucl. Instrum.* **3**, 223.
- **Thompson–Cox–Hastings pseudo-Voigt** (Voigt FWHM combination + η polynomial)
  — Thompson, P., Cox, D. E. & Hastings, J. B. (1987). *J. Appl. Cryst.* **20**,
  79. → [`diffraction/profile.ts`](../src/core/diffraction/profile.ts).
- **Finger–Cox–Jephcoat** axial-divergence asymmetry — Finger, L. W., Cox, D. E.
  & Jephcoat, A. P. (1994). *J. Appl. Cryst.* **27**, 892.
- **TOF back-to-back-exponential ⊗ Gaussian** peak shape — Von Dreele, R. B.,
  Jorgensen, J. D. & Windsor, C. G. (1982). *J. Appl. Cryst.* **15**, 581.
- **March–Dollase** preferred orientation — Dollase, W. A. (1986).
  *J. Appl. Cryst.* **19**, 267. → [`diffraction/intensity.ts`](../src/core/diffraction/intensity.ts).
- **X-ray polarization factor** (1−P)cos²2θ + P — Azaroff, L. V. (1955).
  *Acta Cryst.* **8**, 701; GSAS-II `Polarization`.
- **R factors, R_exp, goodness of fit** (with N = contributing observations) —
  Toby, B. H. (2006). "R factors in Rietveld analysis." *Powder Diffr.* **21**,
  67; Young, R. A. (ed.), *The Rietveld Method* (IUCr/OUP, 1993).
  → [`refinement/factors.ts`](../src/core/refinement/factors.ts).
- **Normal probability plot** — Abrahams, S. C. & Keve, E. T. (1971).
  *Acta Cryst.* **A27**, 157. → [`refinement/diagnostics.ts`](../src/core/refinement/diagnostics.ts).
- **Affine-invariant ensemble MCMC (stretch move)** — Goodman, J. & Weare, J.
  (2010). "Ensemble samplers with affine invariance." *Commun. Appl. Math.
  Comput. Sci.* **5**, 65–80.
  doi:[10.2140/camcos.2010.5.65](https://doi.org/10.2140/camcos.2010.5.65);
  Foreman-Mackey, D., Hogg, D. W., Lang, D. & Goodman, J. (2013). "emcee: The
  MCMC Hammer." *Publ. Astron. Soc. Pac.* **125**, 306–312.
  doi:[10.1086/670067](https://doi.org/10.1086/670067) (the walker / stretch-move
  conventions). → [`refinement/bayes/sampler.ts`](../src/core/refinement/bayes/sampler.ts).
- **MCMC convergence diagnostics — split-R̂ and ESS** — Gelman, A., Carlin,
  J. B., Stern, H. S., Dunson, D. B., Vehtari, A. & Rubin, D. B., *Bayesian
  Data Analysis*, 3rd ed. (CRC, 2013), §11.4–11.5 (split-chain R̂, effective
  sample size); Geyer, C. J. (1992). "Practical Markov Chain Monte Carlo."
  *Statist. Sci.* **7**, 473–483.
  doi:[10.1214/ss/1177011137](https://doi.org/10.1214/ss/1177011137)
  (initial-monotone-sequence truncation of the autocorrelation sum).
  → [`refinement/bayes/diagnostics.ts`](../src/core/refinement/bayes/diagnostics.ts).
- **Magnetic representation analysis** — Bertaut, E. F. (1968). *Acta Cryst.*
  **A24**, 217; Izyumov, Naish & Ozerov, *Neutron Diffraction of Magnetic
  Materials*; Bradley, C. J. & Cracknell, A. P. (1972), *The Mathematical Theory
  of Symmetry in Solids*. → [`magnetic/*`](../src/core/magnetic/).
- **Magnetic subgroup enumeration (full lattice, index, domains)** —
  Perez-Mato, J. M., Gallego, S. V., Tasci, E. S., Elcoro, L., de la Flor, G. &
  Aroyo, M. I. (2015). "Symmetry-Based Computational Tools for Magnetic
  Crystallography." *Annu. Rev. Mater. Res.* **45**, 217 (the k-SUBGROUPSMAG
  framework); Hermann, C. (1929). *Z. Kristallogr.* **69**, 533
  (translationengleiche/klassengleiche subgroup steps); *International Tables
  for Crystallography* Vol. A1 (Wondratschek & Müller, eds.) — group–subgroup
  relations; Litvin, D. B. (2013). *Magnetic Group Tables* (IUCr).
  → [`magnetic/subgroupLattice.ts`](../src/core/magnetic/subgroupLattice.ts).
- **Irrep combinations → isotropy subgroup (irrep ↔ MSG bridge)** —
  Wills, A. S. (2000). "A new protocol for the determination of magnetic
  structures using simulated annealing and representational analysis (SARAh)."
  *Physica B* **276–278**, 680 (mixing basis vectors of one or several irreps);
  Stokes, H. T. & Hatch, D. M. (1988). *Isotropy Subgroups of the 230
  Crystallographic Space Groups* (World Scientific) — order parameter →
  stabilizer (kernels/epikernels); Campbell, B. J., Stokes, H. T., Tanner, D. E.
  & Hatch, D. M. (2006). *J. Appl. Cryst.* **39**, 607 (ISODISPLACE/ISODISTORT:
  mode amplitudes ↔ symmetry group).
  → [`magnetic/isotropy.ts`](../src/core/magnetic/isotropy.ts).
- **Setting transformations for group identification** — *International Tables
  for Crystallography* Vol. A, §1.5 (transformations of coordinate systems:
  R′ = P⁻¹RP, t′ = P⁻¹(Rp + t − p)); orthohexagonal C-centered cells for the
  orthorhombic/monoclinic subgroups of hexagonal parents (ITA Vol. A1).
  → [`magnetic/bnsOg.ts`](../src/core/magnetic/bnsOg.ts)
  (`identifyMagneticGroupAnySetting`).
- **Non-abelian point-group irreps by construction** — Serre, J.-P. (1977).
  *Linear Representations of Finite Groups* (Springer), §8–9 (induced
  representations, subgroups of prime index / Clifford theory); Bradley &
  Cracknell (1972), Ch. 3 (at Γ the ordinary point-group irreps are the small
  representations, non-symmorphic groups included).
  → [`magnetic/pointGroupIrreps.ts`](../src/core/magnetic/pointGroupIrreps.ts).

## Method background (informs the engine; no single source)

- The refinement engine's numerics — Levenberg–Marquardt, diagonal (Jacobi)
  scaling of the normal matrix, SVD truncation of near-null directions, staged
  parameter unlocking — follow **standard** nonlinear least-squares and Rietveld
  practice distilled in [`../knowledge/`](../knowledge/). No single paper is the
  source. If a specific scaling/Jacobian-conditioning paper is later attached, it
  belongs here, tied to [`REFINEMENT_ENGINE.md`](./REFINEMENT_ENGINE.md).

- **Bayesian refinement precedent** — Fancher, C. M., Han, Z., Levin, I.,
  Page, K., Reich, B. J., Smith, R. C., Wilson, A. G. & Jones, J. L. (2016).
  "Use of Bayesian inference in crystallographic structure refinement via full
  diffraction profile analysis." *Sci. Rep.* **6**, 31625.
  doi:[10.1038/srep31625](https://doi.org/10.1038/srep31625). The
  crystallographic precedent for the posterior sampler: MCMC posterior sampling
  over a full-profile model, explicit treatment of the error model
  (heteroskedastic, correlated residuals), and posterior widths compared
  against Rietveld esds — the comparison our `esdRatio` diagnostic automates.
  We implement the ensemble sampler above, not this paper's specific
  sampler/error model; it motivates the marginalized noise model and the
  posterior-vs-esd check in [`REFINEMENT_ENGINE.md`](./REFINEMENT_ENGINE.md).
- **Reporting Bayesian analyses** — McCluskey, A. R., Caruana, A. J., Kinane,
  C. J., Armstrong, A. J., Arnold, T., Cooper, J. F. K., Cortie, D. L.,
  Hughes, A. V., Moulin, J.-F., Nelson, A. R. J., Potrzebowski, W. &
  Starostin, V. (2023). "Advice on describing Bayesian analysis of neutron and
  X-ray reflectometry." *J. Appl. Cryst.* **56**, 12–17.
  doi:[10.1107/S1600576722011426](https://doi.org/10.1107/S1600576722011426).
  The reporting checklist the sampler's output follows: state the priors
  (bounds), the sampler and its chains/steps, autocorrelation-aware ESS, and
  credible intervals rather than bare point estimates — all first-class fields
  of the `sample_posterior` result.
