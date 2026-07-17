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
data's own Q window recorded as the model's termination Qmax.

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

## 5. References

- Keen, *J. Appl. Cryst.* **34**, 172 (2001) — the definitive convention map.
- Egami & Billinge, *Underneath the Bragg Peaks*, 2nd ed. (2012) — G^PDF(r).
- Farrow et al., *J. Phys.: Condens. Matter* **19**, 335219 (2007) — PDFfit2.
- Juhás et al., *J. Appl. Cryst.* **46**, 560 (2013) — PDFgetX3 outputs.
- Toby & Billinge, *Acta Cryst.* **A60**, 315 (2004) — correlated G(r) errors.
