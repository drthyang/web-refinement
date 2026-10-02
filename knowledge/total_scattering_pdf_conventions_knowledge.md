# Total-Scattering / PDF Conventions Knowledge Base

Purpose: pin down exactly which correlation functions and units MATERIA's PDF
track implements, and map them onto the (notoriously inconsistent) conventions
used across the total-scattering community, so that data import, fitting, and
cross-checks against other packages can never silently mix definitions. The
canonical cross-reference for the whole function zoo is **Keen, *J. Appl.
Cryst.* 34, 172–177 (2001), doi:10.1107/S0021889800019993** — when in any
doubt about a third-party file's convention, resolve it against that paper
before writing conversion code. Complements `PDF_MPDF_ROADMAP.md` (build plan)
and `powder_structural_refinement_knowledge.md` (Bragg-side conventions).

## 1. The one function MATERIA fits: G(r), the reduced PDF

MATERIA's real-space engine (core/pdf/forwardModel.ts) computes and fits the
**reduced pair distribution function** of the "PDF community" (Egami &
Billinge; PDFfit2/PDFgui/diffpy; Keen 2001 labels it G^PDF(r)):

```text
G(r) = 4πr [ρ(r) − ρ0]                      units: Å⁻²
     = (1/N) Σ_i Σ_{j≠i} (b̄_i b̄_j / ⟨b̄⟩²) · δ(r − r_ij)/r  −  4πrρ0
```

- oscillates about ZERO; baseline −4πρ0·r at low r (below the first bond);
- weights are Q-INDEPENDENT: neutron coherent scattering lengths b̄ (fm), or
  X-ray f(0) = Z electrons (the PDFfit2 convention — folding f(Q) into the
  real-space weight would double-count the form-factor falloff);
- the experimental G(r) is what PDFgetX3/PDFgetN/Mantid write to `.gr` files:
  G(r) = (2/π) ∫_{Qmin}^{Qmax} Q[S(Q) − 1] sin(Qr) dQ — so finite Qmax means
  every feature is convolved with sin(Qmax·r)/(πr) (implemented in
  core/pdf/termination.ts) and Qdamp/Qbroad carry the Q-resolution.

**Everything else in this document exists to be converted TO this function.**

## 2. Q-space functions MATERIA understands at import

`parsers/pdfData.ts` (`classifyReducedKind`) + `totalscattering/fourier.ts`:

```text
S(Q)   total structure factor, dimensionless, S(∞) = 1     (.sq files)
F(Q) = Q·[S(Q) − 1]   "reduced structure function", Å⁻¹    (.fq files)
G(r) = (2/π) ∫ F(Q) sin(Qr) dQ                             (the transform we apply)
```

Import behavior: `.sq`/`.fq` (or header `outputtype`/`#L` labels, or an
S(Q)-baseline≈1 heuristic) are sine-transformed to G(r) at load, with the
data's own Q window recorded as the model's termination Qmax. The ORIGINAL
S(Q)/F(Q) — and its error column (Mantid `E`, PDFgetN `dS(Q)`), when present —
is retained on the pattern (`PdfPattern.reciprocal`), and σ_G(r) is propagated
onto every G(r) point (§5). Mantid S(Q) exports named for their content
(`*_SQ.dat`, `*SofQ*`) route here when their ordinate also settles flat at 1.

⚠ **StoG writes S(Q) to `.fq`.** RMCProfile's StoG names its S(Q) output
`scale.fq`. Q[S−1] oscillates about 0 at high Q and cannot settle FLAT at 1,
so a `.fq` whose tail does is read as S(Q) (`classifyReducedKind`). Its
`*_rmc.fq` holds S(Q) − 1 (Keen's F for ⟨b̄⟩² = 1) — neither S nor Q[S−1];
convert to S(Q) before loading.

⚠ **Naming collision:** Keen 2001's own "F(Q)" is NOT Q[S−1] — his F(Q) is an
interference function carrying scattering-length units (barn-like), related by
F_Keen(Q) = ⟨b̄⟩²·[S(Q) − 1] in the monatomic reduction. Files from the
RMCProfile/GudrunN world may use Keen's meanings. The Q[S−1] object above is
the Egami–Billinge/PDFgetX3 usage, which is what `.fq` means here. When a file
says "F(Q)", check the high-Q baseline (→0 for both) and the amplitude GROWTH:
Q[S−1] oscillates with roughly constant envelope in Q while Keen's F decays
with the form factor for X-rays; if provenance is unclear, ask for S(Q).

## 3. The rest of the zoo (recognize, do not silently fit)

Per Keen 2001, with the identifications MATERIA cares about:

```text
g(r)          pair distribution function, dimensionless, g(∞)=1, g(0)=0.
              G(r) = 4πrρ0·[g(r) − 1] for the scattering-weighted total.
G_Keen(r)     Σ c_i c_j b̄_i b̄_j [g_ij(r) − 1]  — units barn; the neutron-
              community "G(r)". NOT our G(r): it is r-independent-baselined
              (→0 at large r, −(Σc_i b̄_i)² at r→0) and lacks the 4πrρ0 factor.
D(r)          4πrρ0 · G_Keen(r) — Keen's differential correlation function;
              equals our G(r) × (Σc_i b̄_i)² (barn Å⁻²). RMCProfile's "D(r)".
T(r)          D(r) + 4πrρ0·(Σc_i b̄_i)² — the total correlation function
              (positive-definite; GudrunN/ATLAS tradition).
RDF/N(r)      4πr²ρ(r) — the radial distribution function whose integral over
              a peak is a coordination number. Units atoms/Å.
"linear ρ(r)" some beamline outputs; check axes before assuming.
```

Practical rules:
- A curve that is **everywhere ≥ 0 and grows ~r²** is an RDF, not G(r).
- A curve that **tends to a positive sloped line T(r) ≈ 4πrρ0(Σcb̄)²** is T(r).
- A curve that **oscillates about 0 with a −slope·r ramp at low r** is our G(r).
- A curve that **decays to 0 at large r with a NEGATIVE constant at r→0** is
  G_Keen(r); multiply by 4πrρ0 (and mind the barn normalization) to get D(r).
- MATERIA currently imports G(r)/S(Q)/F(Q) only. T(r), D(r), G_Keen(r), RDF
  conversions are mechanical but need ρ0 and composition — convert upstream or
  extend `classifyReducedKind` + a converter with tests before fitting such data.

## 4. Unit traps that have burned real fits

```text
- Å⁻² vs barn·Å⁻²: our G(r) vs D(r) — a silent (Σc b̄)² scale error that the
  pdfScale parameter will happily absorb, corrupting occupancies/ADPs meaning.
- fm vs 10⁻¹² cm in b̄: PDFfit2 reflection lists are (10⁻¹² cm)²; NIST tables
  are fm. Factor 100 in |F|²-like quantities (see pdffit2Golden.test.ts).
- b̄ table provenance: e.g. Mn −3.73 (NIST/Sears) vs −3.750 (PDFfit2's table).
  Near-cancelling ⟨b̄⟩ (MnO!) amplifies last-digit differences to %-level
  amplitude offsets — document, don't "fix" (they land in the scale).
- Qmax termination: data reduced on the Nyquist grid Δr = π/Qmax carries no
  resolvable ripple; oversampled grids do. Never compare curves computed with
  different effective Qmax.
- X-ray weights are f(0) = Z by convention here and in PDFfit2 — a fit is NOT
  comparable against a package that keeps Q-dependent normalization in r-space.
```

## 5. S(Q) → G(r): the transform, its uncertainty, and "independent points"

`core/totalscattering/fourier.ts` (operator) + `grErrors.ts` (diagnostics).
ONE linear operator produces the values, σ and covariance, so they cannot
disagree about the quadrature:

```text
G(r) = (2/π) ∫_{Qmin}^{Qmax} F(Q) M(Q) sin(Qr) dQ          PDFgetX3 Eq. (3) (M ≡ 1)
     ≈ Σ_k c_k F_k sin(Q_k r) [+ G_low(r)],   c_k = (2/π) w_k M(Q_k)
w_k  composite-trapezoid weights on the MEASURED nodes (non-uniform allowed);
     the rule of pystog and StoG (golden-tested to ~1e-13)
M(Q) 1 (default — what the model's sinc termination assumes), or
     Lorch: sin(πQ/Qmax)/(πQ/Qmax), Qmax = last integrated node
G_low optional (StoG/pystog "omitted low-Q correction"): S(Q) linear from
     S(0) = 0 to the first measured S_0; closed form, series at small Q_0·r
```

Uncertainty — exact, because the operator is linear (JCGM 102:2011 §6.2.1.3,
Eq. 3: U_y = C U_x Cᵀ), for INDEPENDENT σ_S per Q point:

```text
σ_F(Q)          = Q·σ_S(Q)                                   (Q is exact)
Cov[G(r),G(r')] = Σ_k c_k² σ_F,k² sin(Q_k r) sin(Q_k r')     [+ node-0 low-Q term]
                = ½[P(r − r') − P(r + r')],   P(x) = Σ_k c_k² σ_F,k² cos(Q_k x)
```

The second line is a product-to-sum identity: a Toeplitz part (stationary
noise autocorrelation) minus a Hankel part (the odd reflection at r = 0). It
makes the full n×n covariance O(n_Q·n) on a uniform r grid.

What follows from it (derived here, each pinned by a test — not quoted from a
paper):

```text
- σ_G(0) = 0, σ_G ∝ r for r ≪ π/Qmax, then a plateau √(½P(0)).
- Neighboring points on a typical 0.01 Å grid are ~98 % correlated
  (Δr ≪ π/Qmax ≈ 0.12 Å at Qmax 26): the grid is ~12× oversampled.
- Stationary correlation at spacing Δ, continuum, Q grid from 0, u = Qmax·Δ:
    white F noise (σ_F const)          ρ = sin u / u           → 0 at Δ = mπ/Qmax
    white S noise (σ_F = Q·σ_S)        ρ = 3[(u²−2)sin u + 2u cos u]/u³
                                                                → −6/π² ≈ −0.61 at Δ = π/Qmax
  So Nyquist-spaced points are uncorrelated ONLY for white F(Q) noise
  (exactly so on a discrete grid: DST-I orthogonality). Real σ_S tends to grow
  with Q, which pushes ρ(π/Qmax) further negative (−0.75 measured for
  σ_S ∝ 1 + Q/8 on FeCoSn 199 K).
- Independent points in a window: the sampling-theorem count
  (r_max − r_min)·Qmax/π (Farrow et al. 2011), and the participation ratio
  N*_ef = (Σλ)²/Σλ² of the correlation matrix (Bretherton et al. 1999, Eq. 3),
  = n²/‖R‖_F². White F: N*_ef ≈ the Nyquist count. White S: ≈ 5/9 of it
  ((∫x²)²/∫x⁴ for a Q²-weighted spectrum) — fewer independent points than
  the Nyquist count assumes.
```

Practical rules:

- **The fit still uses uniform weights.** σ_G is displayed (±σ ribbon on G(r),
  the S(Q) tab) and available to the Bayesian likelihood, but `1/σ²` on an
  oversampled, correlated grid would over-count information. The full
  covariance (`sineTransformCovariance`) is the ingredient for a generalized
  least-squares or correlated likelihood; Toby & Billinge (2004) describe the
  PDF variance–covariance matrix as offering optimal least-squares weighting.
  Not wired into the refinement yet.
- **A file's own dG column is displayed as written.** Check its provenance.
  Mantid's `PDFFourierTransform2` (source read 2026-10-02,
  `convertFromLittleGRMinus1`) scales G(r) VALUES by 4πρ₀·r but their ERRORS
  by r only, so a dG(r) written by that path is off by the factor 4πρ₀
  (≈ 0.6–1.3). Prefer loading the S(Q) with errors and propagating here.
- **pystog's dG differs slightly, by design.** It integrates the variance with
  its own trapezoid (endpoint weight ½ΔQ² instead of the exact ¼ΔQ²) and leaves
  the low-Q extrapolation's error out. The golden test reconciles both
  differences exactly.
- **A Lorch-modified G(r) needs a matched model termination.** The model's
  band-limit (`pdf/termination.ts`) is the unmodified sinc, so the load path
  never applies Lorch. A Lorch-transformed G(r) must not be fitted until the
  termination kernel (Qmax/2π²)[Si(π + Qmax·x) + Si(π − Qmax·x)] is
  implemented.
- **σ_S is the statistical error only.** Background, normalization and
  Compton/Placzek systematics are not in it, and they usually dominate at
  low r.

## 6. Boxcar (sliding-window) refinement — how to read one

```text
- What it is: refit the SAME model inside a fixed-width r-window slid across
  G(r), then plot each parameter against the box CENTER. A drifting track means
  the structure the PDF sees changes with length scale (local ≠ average); a flat
  track means one model describes every length scale. PDFgui calls this a
  boxcar refinement; the classic result is a low-r box that needs a
  lower-symmetry or differently-distorted model than the high-r boxes.
- Fixed width is the point. A trailing box narrowed to fit the range end would
  hold fewer points and a different information content, so its parameters are
  not comparable with the rest — MATERIA refuses to fit one and reports the
  uncovered tail instead.
- Box width vs what you free: the box must hold enough peaks to determine the
  free set. A 5 Å box on a 10 Å cell may contain only the first coordination
  shell — the cell is then determined by one or two peak positions, and the esd
  says so. Free the cell + ADPs; hold Qdamp/Qbroad (instrument constants, not
  functions of r) and spdiameter (a whole-particle envelope) fixed.
- Esds grow as the box shrinks — fewer points, same parameters. They are
  relative (uniform weights, correlated G(r) errors), so compare esd to the
  DRIFT, not to an absolute threshold: a drift smaller than its error bars is
  not a result.
- Seeding forward makes the series PATH-DEPENDENT: each box starts from the
  previous box's answer, so one box that lands in a local minimum hands it to
  every box after it. Two checks, in increasing strength: randomized restarts
  per box (baseline = the seed, best χ² wins), and scanning BOTH directions
  from the same starting model. Two directions that land on the same track have
  reached the same minimum from opposite seeds — that is the drift being in the
  data. Where they separate by more than their combined esd, the value at that
  box is set by where the fit started, not by G(r); read the low-r end of a
  high→low pass and the high-r end of a low→high pass with that in mind, since
  those are the boxes furthest from their pass's starting point.
- Cost is not flat in r: pair enumeration reaches the box's UPPER edge, so a
  5 Å box at r = 45 Å still enumerates every pair out to ~51 Å.
```

## 7. References

Canonical, DOI-linked entries live in [`../docs/REFERENCES.md`](../docs/REFERENCES.md)
(section "Real-space total scattering — PDF & mPDF").

- Keen, *J. Appl. Cryst.* **34**, 172–177 (2001) — the definitive convention map.
  doi:[10.1107/S0021889800019993](https://doi.org/10.1107/S0021889800019993).
- Egami & Billinge, *Underneath the Bragg Peaks*, 2nd ed. (2012) — G^PDF(r).
  ISBN 978-0-08-097133-9.
- Farrow et al., *J. Phys.: Condens. Matter* **19**, 335219 (2007) — PDFfit2.
  doi:[10.1088/0953-8984/19/33/335219](https://doi.org/10.1088/0953-8984/19/33/335219).
- Juhás et al., *J. Appl. Cryst.* **46**, 560–566 (2013) — PDFgetX3 outputs.
  doi:[10.1107/S0021889813005190](https://doi.org/10.1107/S0021889813005190).
- Toby & Billinge, *Acta Cryst.* **A60**, 315–317 (2004) — correlated G(r) errors.
  doi:[10.1107/S0108767304011754](https://doi.org/10.1107/S0108767304011754).
- Farrow, Shaw, Kim, Juhás & Billinge, *Phys. Rev. B* **84**, 134105 (2011) —
  Nyquist sampling Δr = π/Qmax for PDF refinement.
  doi:[10.1103/PhysRevB.84.134105](https://doi.org/10.1103/PhysRevB.84.134105).
- Lorch, *J. Phys. C* **2**, 229–237 (1969) — the modification function.
  doi:[10.1088/0022-3719/2/2/305](https://doi.org/10.1088/0022-3719/2/2/305).
- JCGM 102:2011 (GUM Supplement 2), §6.2.1.3 Eq. (3) — U_y = C U_x Cᵀ for a
  linear multivariate model.
- Bretherton et al., *J. Climate* **12**, 1990–2009 (1999) — the participation
  ratio N*_ef. doi:[10.1175/1520-0442(1999)012<1990:TENOSD>2.0.CO;2](https://doi.org/10.1175/1520-0442(1999)012%3C1990:TENOSD%3E2.0.CO;2).
- Tucker, Keen, Dove, Goodwin & Hui, *J. Phys.: Condens. Matter* **19**, 335218
  (2007) — RMCProfile, which ships StoG.
  doi:[10.1088/0953-8984/19/33/335218](https://doi.org/10.1088/0953-8984/19/33/335218).
- pystog (ORNL) — https://github.com/neutrons/pystog — the transform golden.
