# PDF & mPDF Roadmap

The plan for adding **pair distribution function (PDF)** and **magnetic PDF
(mPDF)** fitting to MATERIA Workbench — "real-space Rietveld" — matching the
capability of PDFgui / DiffPy-CMI (PDFfit2) and the `diffpy.mpdf` package, built
from scratch on the existing pure-TypeScript core and optimized for the
browser + agent goals.

Status legend: ✅ done · 🚧 in progress · ⬜ not started · 🔬 needs external validation

> **Scientific grounding.** Every equation and parameter below was cross-checked
> against primary sources (Farrow et al. 2007; Proffen & Billinge 1999; Juhás
> et al. 2013 PDFgetX3; Frandsen, Yang & Billinge 2014 / Frandsen & Billinge
> 2015 mPDF; Waasmaier & Kirfel 1995; Toby & Billinge 2004) and against the
> actual reuse seams in `src/core`. The six highest-risk claims were
> adversarially verified; the corrections are baked into the phasing and the
> honesty statement (§8).

---

## 1. Vision

PDF and mPDF are the natural next application of the project's founding
principle — **one engine, many workflows**. A PDF refinement is a weighted
non-linear least-squares fit of a periodic small-box structural model to an
observed reduced PDF `G(r)`, exactly the problem the Levenberg–Marquardt engine
already solves for Rietveld and single-crystal data. The observable changes from
reciprocal space (`y(2θ)`, `I(hkl)`) to real space (`G(r)`), but the optimizer,
the constrained-parameter machinery, the symmetry-adapted modes, the staged
controller, the multi-start escape, the worker pool, and most of the UI do not.

What is genuinely new is a **real-space forward model**: a pair-summation
calculator that turns a structure (and, for mPDF, a spin configuration) into
`G_calc(r)`. That is the one large new subsystem; everything else is a
parameterization, a table, or a thin surface on top of code that already exists.

MATERIA also has an asset the PDF world usually bolts on from external tools
(BasIreps / SARAh / ISODISTORT / Bilbao): a working **magnetic
space-group / irrep / k-search engine**. Its outputs (propagation vectors and
symmetry-allowed basis vectors) map one-to-one onto `diffpy.mpdf`'s spin-model
inputs — so MATERIA is unusually well-positioned to deliver a
**symmetry-constrained local magnetic model** for mPDF, which is the user's
feature (4) and a real differentiator.

Two principles carry over unchanged:

- **Correctness first, in TypeScript.** No new optimizer, no global-search
  shortcut; the CPU f64 real-space calculator is the reference, and any WebGPU
  pair-sum kernel is an opt-in accelerator validated against it. Nothing is
  claimed "validated" until a golden dataset or an external `diffpy` cross-check
  records it.
- **One engine, many workflows.** `G(r)` fitting plugs into the existing
  `RefinementProblem` seam; the whole refinement stack is reused verbatim.

### The build sequence, in one line

> **P0 data model + `.gr` import** → **P1 neutron PDF core (real-space
> calculator + `buildPdfProblem`)** → **P2 X-ray PDF + Q-averaging/W-K tables**
> → **P3 advanced PDF (Qmax termination, nanoparticle, partials, multi-phase,
> multi-dataset)** → **P4 mPDF (Frandsen unnormalized, co-refined)** → **P5
> symmetry-constrained local spin model** → **P6 agent tools + UI polish +
> uncertainty quantification**, with the optional **PR data-reduction pipeline**
> called out but deferred. Big-box RMC is **out of scope** — a different
> paradigm, not on this roadmap.

---

## 2. What is reusable today vs. what must be built

Grounded in a direct read of `src/core`. The headline finding: the serial PDF
fit needs **exactly one new science module** and **zero engine changes**.

| Layer | Reuse verbatim | Extend | Build new |
|---|---|---|---|
| **Refinement engine** `refinement/engine.ts` | `RefinementProblem`, `refine`, `refineParallel`, `refineStaged`, `refineMultiStart`, covariance/esd, diagnostics — all domain-blind | add `pdfScale`+PDF kinds to `LINEAR_KINDS`/`ParameterKind` | — |
| **Parameters** `refinement/types.ts` | `RefinementParameter`, `ParameterBinding`, `resolveTies` | new `ParameterKind` literals: `pdfScale`, `qdamp`, `qbroad`, `delta1`, `delta2`, `sratio`, `spdiameter`, `mpdfOrdScale`, `mpdfParaScale`, `corrLength` | — |
| **Workflow builders** `workflow/powder.ts` | the builder *template* (`resolveTies → applyParameters → calculate closure`), `applyParameters`, `applyMagneticMoments`, `weightsFromSigma`, `fitRangeMask`, geometry-cache concept | `AppliedModel` + apply switch for PDF envelope params | `workflow/pdf.ts`, `workflow/mpdf.ts` |
| **Real-space calculator** | — | — | **`core/pdf/` — pair enumerator + `G_calc(r)` (the core new subsystem)** |
| **Scattering tables** `scattering/` | neutron `b` (92 el.), magnetic ⟨j0⟩/⟨j2⟩, `cellContents` composition, `NEUTRON_CROSS_SECTIONS.incoherent` | — | `<b>`,`<b²>`,`<f>`,`<f²>` sample-average helper; **Waasmaier–Kirfel** table (only for reduction/high-Q normalization) |
| **Crystal / math** `crystal/`, `math/` | `fractionalToCartesian`, `metricTensor`, `expandStructureAtoms`, `expandMagneticSupercell`, `adp.ts`, `gaussLegendre` | — | rmax-bounded periodic-image **pair enumerator**; sine-FT / FFT bridge |
| **Magnetic** `magnetic/` | `buildMagneticModel`, `allowedMomentDirections`, `isotropySubgroup`/`buildMomentField`, `applyMagneticMoments`, `canonicalizeMomentValues`, k-search / MSG candidates | export `buildMomentField` | `magnetic/mpdf.ts` spin-pair kernel + ⟨j0⟩ real-space envelope |
| **UI** `app/`, `visualization/` | `ParameterPanel`, project I/O, CSV export, `StructureView` | `WorkbenchPlot` → signed-y variant (G(r) has negative lobes) | `PdfWorkbench.tsx`, `.gr` data card wiring |
| **Data / parsers** `parsers/`, `diffraction/types.ts` | `ProjectFile`, `parseCif`/`parseMagneticCif`, `detectFormat` chain | `DiffractionDataset` union; `schemaVersion` bump | `PdfPattern` type; `parsers/pdfData.ts` (`.gr`/`.sq`/`.fq`) |
| **MCP / agent** `mcp/` | `TOOL_REGISTRY`/`ToolDefinition` pattern, `createNodeEvaluatorPool`, `buildProblemForSpec` | `pdf`/`mpdf` `EvaluatorSpec` arm | ~9 new tools (§4) |
| **Workers / GPU** `workers/` | `refineParallel` pool, the GPU kernel class + two-gate validation *pattern* | `EvaluatorSpec` variant | optional WebGPU pair-histogram kernel |

**The single reuse seam.** A PDF fit is a `RefinementProblem`:

```ts
{ parameters,
  observations: Float64Array,   // G_obs(r) on the r-grid
  weights:      Float64Array,   // uniform (see §3, correlated errors)
  calculate(values): Float64Array }   // G_calc(r) on the same grid
```

`refine(problem, opts)` runs a working serial PDF fit with **no** change to the
engine, staged controller, or multi-start — verified directly against
`engine.ts:31` (the interface is genuinely reciprocal-space-blind).

---

## 3. Answers to the six requirements

### (1) Synchrotron + neutron sources, and the scattering tables — *what's true*

The Rietveld tables are **partly** reusable; the honest breakdown matters because
it is easy to over- or under-scope:

- **Neutron: reuse `neutron.ts` as-is.** The bound coherent scattering length `b`
  is Q-independent, which is exactly correct for the real-space pair weight
  `b_i b_j/⟨b⟩²`. `cellContents` gives the composition for `⟨b⟩`, `⟨b²⟩`.
- **X-ray, the model: needs only `Z = f(0)`.** This is the crucial, non-obvious
  point. PDFfit2/PDFgui use a **Q-independent** weight `f_i(0) f_j(0)/⟨f(0)⟩² =
  Z_i Z_j/⟨Z⟩²` inside the real-space sum — folding the full `f(Q)` into the pair
  sum **double-counts** the form-factor falloff (it is already in the data). `Z`
  is trivially available. So *X-ray PDF modeling does not require a new table.*
- **X-ray, data reduction/normalization: needs Waasmaier–Kirfel.** The
  shipped Cromer–Mann 4-Gaussian `f(Q)` is fit only to `sinθ/λ ≈ 2 Å⁻¹`
  (Q ≈ 25 Å⁻¹); synchrotron PDF routinely uses Qmax 25–35 Å⁻¹. Getting `S(Q)`
  from raw intensity (the `⟨f²(Q)⟩`/`⟨f(Q)⟩²` normalization and Compton
  subtraction) at those Q **does** need the **Waasmaier–Kirfel 5-Gaussian**
  table (11 coeffs, valid to Q ≈ 75 Å⁻¹). Because we **defer data reduction**
  (see §3.6), W-K is only needed when the optional reduction module (PR) is built
  — *not* for the core fit.
- **Optional later:** ionic X-ray form factors, anomalous dispersion `f'(E)`,
  `f''(E)` (only near edges / resonant PDF), Compton tables, isotope-resolved `b`.

Net: neutron PDF and X-ray PDF *fitting* are unblocked today; the one table to add
(W-K) belongs to the deferred reduction track.

### (2) One robust optimizer for all refinements — *yes, verbatim*

Verified against the code: the LM engine, staged controller and multi-start are
data-agnostic. PDF/mPDF reuse `refine`/`refineParallel`/`refineStaged`/
`refineMultiStart` with no change. Register `pdfScale` as a linear kind for its
exact one-evaluation Jacobian column. Bounds, SVD-truncation, correlation/ESD
diagnostics all carry over — **with the interpretation caveat in §8** (G(r)
errors are correlated; esd/GoF are not absolute quality measures for PDF).

### (3) Shared UI and reused engines — *mostly reused*

`ParameterPanel` renders PDF parameters unchanged once the new `ParameterKind`s
are registered in its `CATEGORY` map. `WorkbenchPlot`'s draggable fit-range
handles give `rmin`/`rmax` windowing for free — but its y-scale hard-clamps to
`[0, yTop]`, which would flatten G(r)'s negative lobes; factor out a **signed-y**
variant. Project I/O, CSV export, CIF/mCIF load, `StructureView` all reuse. A new
`PdfWorkbench.tsx` mirrors `PowderWorkbench.tsx` with its own session state (do
not overload the powder session).

### (4) Combine magnetic symmetry with mPDF to constrain the local model — *the differentiator, reframed honestly*

There are two families of local magnetic models, and it matters which one this is:

- **Small-box, symmetry-constrained (this feature).** `diffpy.mpdf` builds the
  spin configuration from a propagation vector `k` plus symmetry-allowed basis
  vectors and refines the mode-mixing amplitudes. MATERIA's `buildMagneticModel`,
  `allowedMomentDirections`, `isotropySubgroup`/`buildMomentField`, and k-search
  already produce exactly those inputs. So the bridge is direct: **enumerate a
  magnetic subgroup / irrep → read the symmetry-allowed moment basis → the only
  free mPDF parameters are the irrep amplitudes** (+ correlation length, scales).
  This constrains the local spin model to be a *symmetry-legal* distortion rather
  than arbitrary — genuinely novel and well-supported by MATERIA's engine.
- **Big-box RMC (SPINVERT / RMCProfile) is *symmetry-free*** — the opposite
  approach, refining thousands of unconstrained spins by Metropolis moves,
  useful for frustrated / spin-liquid / paramagnetic diffuse scattering. It is a
  **different paradigm (not LM, no symmetry) and is out of scope for this
  build** — kept here only so it is never conflated with the symmetry-constrained
  path P5 delivers.

The ordered-state route also works: the k-vector magnetic structure the engine
already refines *is* a valid mPDF input, so P4 can compute the mPDF of the
average ordered structure before P5 adds local (short-range-order) freedom.

### (5) Browser + AI-agent native — *designed in from P1*

- **Compute:** the real-space pair sum is the new hot loop. Ship a correct f64
  CPU calculator in a Web Worker first; add an **opt-in WebGPU pair-histogram
  kernel** later (thread = r-bin × model), cloned from `gpuStructureFactor.ts`
  with its mandatory two-gate validation (WGSL stride == JS stride; f64 kernel
  reproduces CPU G(r) to ≤1e-6). Pair-list caching keyed on geometry parameters,
  scale multiplied last for bit-identity.
- **Agent surface:** every capability is one `TOOL_REGISTRY` entry over one pure
  core function (§4), so the same validated functions drive the UI and an agent.
  Add PDF-aware diagnostics + next-step suggestions so an agent can run an
  end-to-end study (load `.gr` → calibrate Qdamp on a standard → build model →
  staged refine → co-refine mPDF → report).

### (6) What was missed — *the scope the feature list didn't mention*

1. **Data reduction is a whole separate discipline.** Turning raw `I(2θ/Q)` into
   `G(r)` (background, absorption, Compton/Placzek, normalization, Fourier
   transform) is what PDFgetX3/PDFgetN do — *not* what PDFgui/DiffPy do. Decision:
   **consume already-reduced `G(r)` (`.gr` import); defer reduction to track PR.**
   This makes the essential first deliverable a `.gr` parser, not a corrections
   engine.
2. **G(r) uncertainties are strongly correlated** (sine-FT of finite-Q data), so
   `w=1/σ²` is not a true weight and reported esds/GoF are optimistic. Use
   **uniform weights + Rw over G(r)**; treat esd/GoF as relative only; count
   independent points on the **Nyquist grid Δr = π/Qmax**. (See §8 — riskiest
   assumption.)
3. **Qmax termination ripples** are a genuine sinc convolution `sin(Qmax·r)/r`,
   distinct from the `Qdamp` Gaussian resolution envelope; model both, and extend
   the calculation range by `6·(2π/Qmax)` before trimming so edge ripples are
   correct.
4. **Qdamp/Qbroad are instrument constants** calibrated from a standard (Ni / Si /
   LaB₆), then **fixed** — not refined from scratch against an unknown structure.
5. **Correlated-motion sharpening** has two mutually-exclusive models
   (`delta1`/`delta2` vs `sratio`/`rcut`); refine one, never both; `delta1`↔`delta2`
   are highly correlated (1/r vs 1/r²) — usually free just one.
6. **Nanoparticle / finite-size** needs a shape characteristic function
   (`spdiameter` sphere envelope) and, for true clusters, the **Debye** path
   (the periodic real-space sum is wrong at large r for finite particles).
7. **Partial / differential PDFs** (by element-pair) — cheap once the enumerator
   exists, valuable for interpretation.
8. **Multi-phase and multi-dataset co-refinement** (temperature series; joint
   X-ray + neutron) — a natural, high-value extension of the residual-vector shape.
9. **Incommensurate mPDF** (helices, SDW) needs the `fourierMoment.ts` complex-
   coefficient route, not the commensurate supercell expander.
10. **Uncertainty quantification** beyond esd (residual-based, resampling) is a
    modern differentiator over PDFgui — delivered as Bayesian posterior
    sampling (ensemble MCMC; see P6).

---

## 4. Target module layout

New code lands as pure-core subsystems + thin surfaces, mirroring the existing
tree. Nothing below imports React into `core`.

```
src/core/
  pdf/
    pairEnumerator.ts      NEW  all pairs r_ij within rmax over periodic images
                                (generalizes crystal/geometry.bondLengths: emits
                                the pair VECTOR, no dedup, weighted by species;
                                neighbor-binned, cached)
    peakWidth.ts           NEW  σ'_ij = n̂ᵀ(U_i+U_j)n̂ (bond-projected ADP, adp.ts)
                                + correlated-motion sqrt(1 − δ1/r − δ2/r² + Qbroad²r²)
    forwardModel.ts        NEW  G_calc(r): Σ pairs (w_i w_j/N)·Gaussian(r_ij,σ_ij)
                                − 4πρ₀r, × exp(−(r·Qdamp)²/2) × f_sphere(r;d)
    termination.ts         NEW  Qmax sinc convolution via FFT + range extension
    partials.ts            NEW  element-pair (Faber–Ziman) decomposition
  totalscattering/
    weights.ts             NEW  ⟨b⟩,⟨b²⟩,⟨f⟩,⟨f²⟩,⟨Z⟩ composition averages (cellContents)
    fourier.ts             NEW  sine transform S(Q)/F(Q) ↔ G(r) (gaussLegendre or FFT)
    reduction.ts           NEW (track PR, deferred)  PDFgetX3/N ad-hoc pipeline
  magnetic/
    mpdf.ts                NEW  Frandsen spin-pair kernel (A_ij δ + B_ij baseline),
                                ⟨j0⟩ real-space envelope, unnormalized d_mag(r)
  scattering/
    waasmaierKirfelData.ts NEW (track PR)  5-Gaussian f(Q) to Q≈75 (generated)
  workflow/
    pdf.ts                 NEW  buildPdfProblem + pdfCurves (template: powder.ts)
    mpdf.ts                NEW  buildMpdfProblem: nuclear PDF + d_mag(r) in ONE
                                residual, separable contributions (template:
                                magneticPowder.ts)
  refinement/types.ts      EDIT new ParameterKind literals + LINEAR_KINDS
  diffraction/types.ts     EDIT PdfPattern{ id,name, points:{r,gObs,sigma?}[],
                                rmin,rmax,rstep, qmax,qmin,qdamp,qbroad,
                                scatteringType } ∈ DiffractionDataset
src/parsers/pdfData.ts     NEW  .gr/.sq/.fq reader + header metadata; detectFormat branch
src/app/PdfWorkbench.tsx   NEW  mirrors PowderWorkbench; own session state
src/app/ui/WorkbenchPlot   EDIT factor out signed-y scale variant
src/workers/protocol.ts    EDIT EvaluatorSpec: | {kind:'pdf',...} | {kind:'mpdf',...}
src/workers/runPowder.ts   EDIT buildProblemForSpec: case 'pdf' / 'mpdf'
src/mcp/registry.ts+tools  EDIT ~9 tools (below)
```

**New MCP tools** (one registry entry ⇄ one pure core function):
`load_gr_data`, `build_pdf_model`, `refine_pdf`, `set_pdf_range`,
`calibrate_qdamp` (from a standard), `compute_partial_pdf`, `build_mpdf_model`,
`refine_mpdf`, `propose_local_spin_model_from_symmetry` (= `allowed_moments` +
`list_magnetic_subgroups`, judgment-free). Each mirrors `refine_powder`'s handler
and adds a `CONTRACTS` entry (registry tests are strict).

---

## 5. Phased roadmap

Each phase ends the project way: **passing tests + updated docs + a working local
app + a validation gate**, no broken intermediate state.

### P0 — Data model + `.gr` import ✅  *(small; unblocks everything)*

> **Status (2026-07-16):** done. `PdfPattern` + `.gr/.sq/.fq` parser (PDFgetX3 +
> Mantid dialects, validated on real NSLS-II 28-ID and POWGEN files), the
> `detectFormat` pdf branch, the signed-y `WorkbenchPlot` mode (data-min floor +
> zero line), and the `PdfWorkbench` shell. Remaining sliver: PDF session in the
> project-JSON schema (`PROJECT_SCHEMA_VERSION` bump + round-trip gate).
- **Goal:** ingest and display an observed `G(r)`.
- **Deliverables:** `PdfPattern` type in `diffraction/types.ts` + `DiffractionDataset`
  union; `parsers/pdfData.ts` reading two-column `.gr` (r, G) with the
  PDFgui/PDFgetX3 header (composition, qmax, qmin, qdamp, rstep, rpoly);
  `detectFormat` branch (`.gr` is already in the data-card accept list but has no
  parser — a live foot-gun); signed-y `WorkbenchPlot` variant; `PdfWorkbench`
  shell showing observed G(r); `PROJECT_SCHEMA_VERSION` 1→2 + no-op migration.
- **Reuse:** project I/O, plot, CSV export, data-card.
- **Gate:** round-trip a diffpy `.gr` (e.g. Ni) → JSON → back, byte-stable
  metadata; observed curve renders with negative lobes intact.

### P1 — Neutron PDF core forward model + refinement ✅ 🔬  *(large; the keystone)*

> **Status (2026-07-16):** done. `pairEnumerator` (periodic images + bond-projected
> anisotropic ADP), `forwardModel` (Proffen–Billinge sum, δ1/δ2, Qdamp/Qbroad,
> −4πρ₀r), `totalscattering/weights`, and the engine wiring: `workflow/pdf.ts`
> (`buildPdfProblem` — uniform weights, fit-range mask, geometry-keyed pair-list
> cache proven bit-identical; `buildPdfSpec` reusing the powder symmetry machinery;
> `pdfCurves`; `PDF_STAGE_KINDS`), new `ParameterKind`s with `pdfScale` linear, the
> `refinePdf` worker path, and a synthetic round-trip test recovering cell/scale/B
> to Rw ≈ 0. G_calc golden vs PDFgui (POWGEN Fe0.1Co0.9Sn 1.7K) locked in at
> corr 0.9998, κ ≈ 1.000. **Update 2026-07-17: the 🔬 refined-parameter gate is
> closed** — a committed PDFfit2-generated fixture (see P2) pins perturbed-model
> recovery of cell (<1 mÅ), scale, and per-element ADPs on CI. Minor note:
> peak-width `σ′_ij` lives in the enumerator rather than a separate
> `peakWidth.ts` (fold out only if a future phase needs it).
- **Goal:** a working neutron PDF fit of a known crystal.
- **Deliverables:** `pdf/pairEnumerator.ts` (rmax periodic-image pairs, neighbor-
  binned, vector output — **not** `geometry.bondLengths`, which dedups and tiles
  only ±1 cell); `pdf/peakWidth.ts`; `pdf/forwardModel.ts` (Proffen–Billinge
  master sum + `−4πρ₀r` baseline + `Qdamp` envelope); `totalscattering/weights.ts`;
  `workflow/pdf.ts` `buildPdfProblem` + `pdfCurves`; new `ParameterKind`s + apply
  wiring; `pdfScale` in `LINEAR_KINDS`; staged order
  `scale → (Qdamp/Qbroad fixed from standard) → cell → ADP → delta1 → positions →
  occupancy`; uniform-weight Rw over G(r).
- **Reuse:** LM engine, staged, multi-start, `applyParameters`, `expandStructureAtoms`,
  `adp.ts`, `fractionalToCartesian`/`metricTensor`, neutron `b` table.
- **Gate 🔬:** golden **crystalline Ni neutron PDF** — `G_calc(r)` reproduces
  `diffpy`/PDFfit2 to a pinned tolerance; refined `a`, `Uiso`, `scale`, `delta1`
  agree with a PDFgui reference within esd. Golden-value snapshot like the
  GSAS-II gates.

### P2 — X-ray PDF + Q-averaging ✅  *(small–medium)*

> **Status (2026-07-17):** done. The `f(0)=Z` weight branch shipped with P0/P1;
> the golden gates now run against a **local PDFfit2 1.6.0** (diffpy.pdffit2
> wheel + Homebrew GSL) with a **committed** synthetic fixture
> (`core/pdf/pdffit2Golden.ts`), so they run on CI: Ni X-ray corr 0.99988 /
> κ 1.0001, MnO X-ray corr 0.99982 / κ 1.0000, plus a refined-parameter
> recovery (cell to <1 mÅ) that also closes P1's 🔬 item. Documented provenance
> caveat: PDFfit2's neutron b table (Mn −3.75018) vs our NIST Sears values
> (Mn −3.73) gives a ~2.3 % amplitude offset on MnO-neutron cases (⟨b⟩ nearly
> cancels), absorbed by the scale and gated explicitly in the test.
- **Goal:** X-ray (synchrotron) PDF fitting.
- **Deliverables:** X-ray branch of the pair weight using `Z = f(0)` (constant,
  matching PDFfit2 — **not** `f(Q)`); `⟨Z⟩` normalization; `Qbroad`;
  scattering-type dispatch on `PdfPattern.scatteringType`.
- **Reuse:** all of P1; element `Z` from `elementData`.
- **Gate 🔬:** golden **Ni or CeO₂ X-ray PDF** vs diffpy; document the `f=Z`
  approximation and its accuracy vs a Q-dependent normalization.

### P3 — Advanced PDF ✅  *(medium)*

> **Status (2026-07-17):** done (two small slivers below). Shipped and gated:
> - `pdf/termination.ts` — Qmax sinc band-limit (direct sampled kernel — exact,
>   no FFT padding pitfalls; swap-in FFT later behind the same seam) with the
>   6·(2π/Qmax) grid extension and the odd-reflection term at r → 0; identity at
>   grid Nyquist by construction; auto-applied when the pattern carries `qmax`.
> - `spdiameter` sphere envelope — external gate vs PDFfit2 (κ 1.0003).
> - `pdf/partials.ts` — Faber–Ziman element-pair partials (Σ ≡ total to 1e-10)
>   with the plot-overlay toggle.
> - **Multi-phase G(r)** — per-phase scale/cell/atoms/δ/Ø, shared Qdamp/Qbroad,
>   per-phase pair caches, per-phase overlay curves, Add-CIF/phase badges on the
>   PDF page; synthetic two-phase round trip to Rw ≈ 0 AND an external two-phase
>   gate vs PDFfit2 (corr 0.9998).
> - **Multi-dataset co-refinement** (temperature series / joint X-ray+neutron):
>   one concatenated residual, shared structure + sample terms, per-dataset
>   scale/Qdamp/Qbroad, per-dataset fit ranges — core + tests (UI to follow with
>   the multi-dataset data card, P6).
> - `sratio`/`rcut` kinds with the δ-family mutual-exclusion guard
>   (`correlatedMotionConflict`, surfaced as a warning in the workbench).
>
> Remaining slivers: `calibrate_qdamp` convenience (fold into the P6 MCP tools —
> freeing qdamp/qbroad on a standard already works by hand), `stepcut`, and the
> multi-dataset UI.
- **Goal:** publication-grade PDF: correct termination, finite size, partials,
  multi-phase, multi-dataset.
- **Deliverables:** `pdf/termination.ts` (Qmax sinc FFT + `6·(2π/Qmax)` range
  extension); `spdiameter` sphere envelope + `stepcut`; `sratio`/`rcut` as the
  alternative correlated-motion model (mutually exclusive with delta1/2 —
  enforce); `pdf/partials.ts` differential PDFs; multi-phase
  `G = Σ dscale·pscale·G_phase`; multi-dataset / temperature-series co-refinement
  (one concatenated residual); `calibrate_qdamp` from a standard.
- **Reuse:** multi-phase pattern from `workflow/multiPhase.ts`; `gaussLegendre`/FFT.
- **Gate 🔬:** reproduce a diffpy nanoparticle (`spdiameter`) fit and a two-phase
  fit; termination ripples match a low-Qmax reference (the PDFgetN Ni r≈3 Å
  spurious-peak case).

### P4 — Magnetic PDF (mPDF) ✅ *(core)*  🚧 *(UI/agent surface)*

> **Status (2026-07-17):** the core is done and externally gated. Shipped:
> `magnetic/mpdf.ts` (Frandsen A/B spin-pair kernel with the exact reference
> histogram/broadening/normalization, ⟨j0⟩ cosine-transform envelope + self-
> convolution, paramagnetic S′ term, net-moment line, SRO ξ envelope),
> `expandSpinField` in `crystal/cellExpansion.ts` (the unified k = 0 / k ≠ 0
> magnetic box), `workflow/mpdf.ts` (`buildMpdfSpec`/`buildMpdfProblem` — one
> separable residual over the nuclear machinery with geometry/moment-keyed spin
> caches, `mpdfComponents`, `MPDF_STAGE_KINDS`), and the four new kinds
> (`mpdfOrdScale`/`mpdfParaScale` linear, `mpdfPsigma`, `corrLength`).
> **Gate closed:** committed diffpy.mpdf fixtures (`magnetic/mpdfGolden.ts`) pin
> f(r) for an AFM and a net-moment FM box to ≤1e-6·peak and D(r) to
> corr > 0.9999 / κ within 0.5 % on CI, plus a synthetic co-refinement
> round trip recovering a perturbed moment to 3 decimals. Remaining for the
> milestone: the mPDF page/UI (the header's reserved "Magnetic PDF →" slot),
> worker `EvaluatorSpec` arm, and MCP tools (fold into P6).
- **Goal:** co-refine the magnetic PDF with the nuclear PDF (ordered structure).
- **Deliverables:** box spin-field expander (unifies commensurate k=0 and k≠0 via
  `displayMoment`, handling `expandMagneticSupercell`'s null-at-k=0);
  spin-pair enumerator (pair vector + both Cartesian moments); `magnetic/mpdf.ts`
  implementing the **unnormalized** Frandsen mPDF `d_mag(r)` = the two-term
  `A_ij`(δ, transverse `⟨S_i^y S_j^y⟩`) + `B_ij`(continuous baseline
  `r·(Σ_all − cumsum)`) histogram, the `⟨j0⟩` real-space envelope `S(r)`, and
  independent `ordScale`/`paraScale`; the **linear net-moment term
  `−(8π/3)r·ρ₀·m²` only for ferromagnets** (exactly zero for AFM — including it is
  a bug); `workflow/mpdf.ts` adding `d_mag(r)/(N_a⟨b⟩²)` to the nuclear `G(r)` in
  one separable residual; multi-start + `canonicalizeMomentValues` for the
  moment-sign degeneracy.
- **Reuse:** `buildMagneticModel`, `applyMagneticMoments`, magnetic ⟨j0⟩ table,
  `magneticPowder.ts` separable-contribution pattern, the whole LM stack.
- **Gate 🔬:** golden **MnO neutron PDF+mPDF** (the Frandsen & Billinge 2015
  reference case); numeric cross-check of `d_mag(r)` against `diffpy.mpdf` for a
  fixed spin config.

### P5 — Symmetry-constrained local spin model ⬜  *(medium — the differentiator)*
- **Goal:** feature (4): a local magnetic model whose freedom is exactly the
  symmetry-allowed modes.
- **Deliverables:** `propose_local_spin_model_from_symmetry` (enumerate maximal
  magnetic subgroups → per-site allowed moment basis → seed irrep amplitudes),
  wiring the existing k-search/MSG/irrep outputs into the P4 mPDF as its free
  parameters; isotropic/anisotropic short-range-order correlation length
  `exp(−r/ξ)`; export `buildMomentField` from `isotropy.ts`.
- **Reuse:** `allowedMomentDirections`, `isotropySubgroup`, `magneticGroups`,
  `subgroupLattice`.
- **Gate:** on a known case, the proposed model's free-parameter count equals the
  irrep dimension; refining ξ recovers a correlation length consistent with peak
  fall-off; symmetry-illegal spin directions stay identically zero.

### P6 — Agent tools, UI polish, uncertainty quantification 🚧  *(medium)*

> **Status (2026-07-17):** the nuclear agent slice is live. Five PDF tools on
> the contract-tested registry (32 tools total, incl. `build_distortion_modes`
> and `build_symmetry_modes` — modes from the structure's own space group, no
> parent CIF): `parse_pdf_data`,
> `build_pdf_model` (single + multi-phase, scale-seeded), `refine_pdf`
> (flat/staged, fit range, node-pool parallel fast path, correlated-motion
> conflict in `warnings`), `compute_partial_pdf` (element pairs / per-phase),
> and `calibrate_qdamp` (standard → instrument constants). The P6 gate for the
> nuclear track passes: an agent completes parse → build → staged refine →
> partials → calibrate via the registry only (`pdfAgentLoop.test.ts`), and the
> `{kind:"pdf"}` EvaluatorSpec arm gives pooled/parallel refinement in both the
> browser workbench and the node MCP server, pooled ≡ serial bit-for-bit.
> Remaining for P6: mPDF tools (with P4), PDF-aware `assess_refinement` bands,
> next-step suggestions for PDF, multi-dataset UI.
>
> **Update (2026-07-19):** the uncertainty-quantification item shipped, beyond
> the planned resampling: **Bayesian posterior sampling**. An affine-invariant
> ensemble MCMC sampler (Goodman & Weare stretch move, emcee-style) lives in
> `core/refinement/bayes/` as a sans-io generator mirroring the LM engine's
> `refineCore` — RNG only in the generator, so the serial and worker-pool
> drivers are bit-identical and a run resumes from a serializable walker-state
> token. The default noise model is **marginalized** — `logL = −(N/2)·ln χ²`
> (unknown error scale integrated out under a Jeffreys prior) — exactly
> because G(r) is fitted with deliberate unit weights (§8's correlated-error
> caveat). Logit transforms handle [min, max] bounds with the log-Jacobian
> measure term. Diagnostics: split-R̂ (Gelman–Rubin), ESS (Geyer
> initial-monotone truncation), quantile credible intervals, the sample
> correlation matrix, and `esdRatio` (posterior std / linearized LM esd) —
> validated at **0.99–1.01** on the Ni PDFfit2 golden in the Gaussian limit.
> Exposed as the `sample_posterior` MCP tool (33 tools total) with bounded
> `nSteps` + resume-token continuation; agents run `refine_pdf` first and seed
> walkers from the converged values. See VALIDATION.md and Fancher et al.
> (2016) / McCluskey et al. (2023) in §9. **Since then:** a gradient-based
> **NUTS** sampler (`sampler:"nuts"`, consuming §6's `gradChi2`; LM-esd-seeded
> mass matrix, R̂ ≈ 1.001 on Ni in ~5× fewer evaluations) and the workbench
> **Posterior view** (ensemble over the worker pool; marginals, credible
> intervals, esdRatio, R̂/ESS, resume-token Continue).
>
> **UI status (2026-07-17):** the PDF page is design-unified with the powder
> page (same plot-card layout, toolbar, segmented Refinement | 3D Model view,
> fit-window chip, Prefit/Refine actions, `wb-work2` grid) and ships as one of
> the two start-page demos (GaTa₄Se₈ 299 K X-ray, Rw 8.1%). The header shows
> the technique state as chip pairs (Powder | Single crystal · Rietveld | PDF ·
> Nuclear | Magnetic) with a disabled **Magnetic PDF →** action reserving the
> mPDF slot until P4.
- **Goal:** the browser + agent experience is first-class.
- **Deliverables:** the full MCP tool set (§4) with `CONTRACTS`; `pdf`/`mpdf`
  `EvaluatorSpec` arms for pooled/parallel refine; PDF-aware `assess_refinement`
  bands (**not** the Toby Rwp Bragg bands); next-step suggestions; residual-based
  / resampling uncertainty estimates surfaced with the correlated-error caveat;
  obs/calc/diff G(r) polish, partial-PDF overlays, r-range presets.
- **Reuse:** `createNodeEvaluatorPool`, `TOOL_REGISTRY`, diagnostics layer.
- **Gate:** an agent completes load → calibrate → build → staged refine →
  co-refine mPDF → report on the Ni and MnO fixtures via MCP only; `registry.test.ts`
  green.

### Deferred / optional tracks (called out, not silently dropped)
- **Track PR — data reduction** (`totalscattering/reduction.ts`): PDFgetX3/N
  ad-hoc pipeline (raw I → S(Q) → F(Q) → G(r)), Waasmaier–Kirfel table, Compton,
  Placzek. Large; only if users need to reduce raw data in-app. Until then, import
  reduced `.gr`.
- **Anomalous / resonant PDF** (`f'`,`f''` tables + complex `f`): needs a
  `ScatteringTable` interface extension (the current interface returns one real
  number). Only for near-edge experiments.
- **Incommensurate mPDF** (helix/SDW) via `fourierMoment.ts`.

### Explicitly out of scope
- **Big-box magnetic reverse Monte Carlo (SPINVERT / RMCProfile-style).** A
  fundamentally different paradigm — Metropolis moves on thousands of
  unconstrained spins, no symmetry, no LM — and **not part of this roadmap**. The
  local-magnetic capability here is the symmetry-constrained small-box model of P5.

---

## 6. Performance plan

The pair sum is `O(N_cell · N_images)` per phase and cubic in `rmax`. Strategy,
following the existing acceleration ladder:

1. **Correct f64 CPU in a Web Worker** (default, reference). Neighbor-bin the
   periodic images; cache the pair-list `[r_ij, amplitude, projected ADP]` keyed
   on geometry-bound parameter values; recompute only σ_ij / envelopes when only
   `Qdamp`/`delta`/`scale` move; multiply scale last for bit-identity — the
   `createPeakBuilder` cache pattern, adapted (cache key is `rmax` + geometry
   params, **not** the d-window).
2. **`refineParallel` pool** for the Jacobian, unchanged, once the `EvaluatorSpec`
   arm exists.
3. **Opt-in WebGPU pair-histogram kernel** (f32, approximate) cloned from
   `gpuStructureFactor.ts`, thread = r-bin × model, with the mandatory two gates:
   `wgslFieldCount == STRIDE` and an f64-kernel-vs-CPU-G(r) precision harness
   (≤1e-6). Note a real-space accumulation of many small Gaussians can be *more*
   f32-sensitive than the reflection sum — validate carefully.
4. **Analytic gradients (F1.1 real-space — shipped).** A fused single-pass
   pair loop (`pdf/gradients.ts`) returns G(r) **and** every requested analytic
   ∂G/∂p column in one traversal — the value curve is bit-identical to
   `computeGofR`, pinned by test. Covered kinds: `qdamp`, `qbroad`,
   `delta1`/`delta2`, `spdiameter` (> 0), `occupancy`, `bIso`, `uAniso`, and
   symmetry-mode `positionShift` — orbit-image derivatives transform correctly
   via per-atom op provenance (d pos/dv = M·R·axis, U → R·U·Rᵀ). `cell`,
   `sratio`/`rcut`, tie-referenced parameters, and multi-phase/multi-dataset
   problems fall back to FD (null column). `buildPdfProblem` feeds these to the
   LM engine as `analyticColumns` (restraints supported, unlike the powder
   template) and also exposes a complete scalar `gradChi2` (analytic columns +
   central-FD fill-in) — the contract a future NUTS sampler consumes. Measured
   **2.3× faster** LM refinement on the Ni golden, same basin.

---

## 7. Validation strategy

Adopt the project's golden-value + external-cross-check convention:

- **Standards:** Ni, Si, or LaB₆ for `Qdamp`/`Qbroad` calibration.
- **Nuclear golden:** crystalline **Ni** (neutron *and* X-ray) `G_calc(r)` and a
  full refinement vs a `diffpy`/PDFgui reference; CeO₂ or a diffpy test dataset as
  a second.
- **mPDF golden:** **MnO** (Frandsen & Billinge 2015) joint nuclear+magnetic PDF;
  plus a fixed-spin numeric cross-check of `d_mag(r)` against `diffpy.mpdf`.
- **Cross-checks:** partial-PDF weights sum to 1 (Faber–Ziman); termination
  ripple reproduces a known low-Qmax artifact; `⟨b⟩` sign handling for
  negative-`b` elements (Mn, H, Ti).
- **FD oracles need filtering, not the analytic columns:** the ±5σ Gaussian
  evaluation window is quantized on the r-grid, so a finite-difference *oracle*
  picks up spurious 1/h spikes when a pair crosses a window edge — and the Qmax
  band-limit **delocalizes** those spikes across the whole grid. The gate tests
  (`pdfAnalyticJacobian.test.ts`) therefore apply a **Richardson h-vs-h/2
  consistency filter** (compare only grid points where the FD estimate is
  h-stable) and run the tight tolerances with termination off. Recorded here so
  the lesson is not re-learned: when an analytic-vs-FD gate fails, suspect the
  oracle's discretization before the derivative.
- Fixtures live under the git-ignored `data/` folder via `testSupport`, skipping
  gracefully when absent, exactly like the GSAS-II suites.

---

## 8. Scientific caveats / honesty statement

In the spirit of `LIMITATIONS.md` — the deliberate, still-standing constraints:

- **Correlated G(r) uncertainties (the riskiest reuse assumption).** `G(r)` from a
  finite-Q sine transform has strongly correlated point errors, so `w=1/σ²` is not
  a true statistical weight. Reported esds come out **optimistically small** and
  the normal-probability diagnostics are non-linear even for a perfect fit —
  PDFgui itself warns its uncertainties are unreliable (Toby & Billinge, *Acta
  Cryst.* A60, 315). MATERIA must fit with **uniform weights**, report **Rw over
  G(r)** (not the Bragg Rwp), count independent points on the **Nyquist grid
  Δr = π/Qmax**, and label esd/GoF as *relative* indicators only. The LM
  *minimization* is unaffected; only the *interpretation* of the covariance is.
- **`σ=√yObs` fallback is invalid for G(r)** (the shared observation contract
  defaults to it and skips `yObs≤0`). PDF needs its own weight path.
- **X-ray model weight is `f(0)=Z`, Q-independent** — matching PDFfit2. This is an
  approximation vs a full Q-dependent normalization; documented, not hidden.
- **Data reduction is out of scope initially** — MATERIA consumes reduced `G(r)`,
  like PDFgui/DiffPy. Reduction quality (background, absorption, Compton/Placzek,
  Qmax choice) is the user's / upstream tool's responsibility until track PR.
- **Absolute mPDF moment magnitude** inherits the convention-dependent factor
  `momentModel.ts` already flags as not yet cross-checked against GSAS-II; and
  `crystalComponentsToCartesian` uses a normalized-direct-axis simplification for
  oblique cells (see `LIMITATIONS.md`) that a non-orthogonal magnetic cell
  inherits.
- **Commensurate, single-k mPDF first.** Incommensurate spin fields require the
  `fourierMoment.ts` route (deferred).
- **Local optimizer.** LM is local; PDF/mPDF assume a reasonable starting model.
  Multi-start mitigates moment-sign and shape/scale minima but is not global
  search.
- **GPU pair-sum, if built, is opt-in f32 and approximate** — the f64 CPU path is
  the default and the reference.

---

## 9. References

Farrow et al., *J. Phys.: Condens. Matter* **19** (2007) 335219 (PDFfit2/PDFgui) ·
Proffen & Billinge, *J. Appl. Cryst.* **32** (1999) 572 (PDFFIT) ·
Juhás et al., *J. Appl. Cryst.* **46** (2013) 560 (PDFgetX3) ·
Juhás et al., *Acta Cryst.* **A71** (2015) 562 (DiffPy-CMI / SrFit) ·
Frandsen, Yang & Billinge, *Acta Cryst.* **A70** (2014) 3 (mPDF theory) ·
Frandsen & Billinge, *Acta Cryst.* **A71** (2015) 325 (mPDF fitting, MnO) ·
Paddison, Stewart & Goodwin, *J. Phys.: Condens. Matter* **25** (2013) 454220
(SPINVERT) · Waasmaier & Kirfel, *Acta Cryst.* **A51** (1995) 416 (5-Gaussian
f(Q)) · Toby & Billinge, *Acta Cryst.* **A60** (2004) 315 (PDF uncertainties) ·
Egami & Billinge, *Underneath the Bragg Peaks*, 2nd ed. (2012) ·
Goodman & Weare, *Commun. Appl. Math. Comput. Sci.* **5** (2010) 65
(affine-invariant ensemble MCMC) · Fancher et al., *Sci. Rep.* **6** (2016)
31625 (Bayesian MCMC full-profile refinement) · McCluskey et al., *J. Appl.
Cryst.* **56** (2023) 12 (reporting Bayesian analysis of scattering data).
