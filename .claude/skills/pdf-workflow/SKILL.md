---
name: pdf-workflow
description: >-
  Real-space (small-box) refinement of a reduced pair distribution function G(r) in
  MATERIA — what to free in what order, the gates, and how to judge and report the fit —
  driving the MATERIA PDF tools and the in-app Agent's PDF page. Use when the user asks to
  refine a PDF / G(r) dataset, decide what to free next on a PDF fit, or ask whether the
  local structure differs from the average one (boxcar scans). General small-box practice:
  the user's own PDF method has not been written down yet, so ask before a judgment call it
  does not settle. NOT for Rietveld (my-rietveld-workflow), magnetic PDF (mPDF), or
  big-box (RMC) modelling.
---

# PDF refinement workflow (MATERIA)

**Status: general practice, not yet the user's method.** This is the standard small-box
order and its usual guardrails. The user has not been interviewed for their own PDF
method; when they state a preference that differs, follow them, and say so.

The fit is a least-squares refinement of a structural model against G(r) over an r
window. Its agreement is **Rw**. The fit weights every point equally, so Rw is a relative
measure (compare fits of the same data, never across datasets), there is **no GoF**, and
the esds are not statistical — never quote them as Rietveld esds.

## Stage 0 — Check the data and the instrument before the structure

1. The reduction sets what the fit can see: Qmax (real-space resolution, termination
   ripples), the r range, and the convention (G(r) here; see the reference if a file is in
   another). If the data card or `get_state` shows something unexpected, stop and ask.
2. **Qdamp and Qbroad describe the instrument**, not the sample. They come from a standard
   measured on the same instrument (Ni, Si; `calibrate_qdamp`). Keep them fixed in the
   sample fit unless the user says otherwise — refined against the sample they absorb
   structure.
3. Choose the fit window deliberately: from just below the first peak to where the
   signal or the model stops being trustworthy. Say what window you use.

## Stage 1 — Refine in the small-box order

Refine (`refine_pdf`; in the app, `refine` after `set_free`) and check
(`assess_refinement`) between blocks; free the next block only once the current one is
stable and nothing sits at a bound.

1. **Scale + cell.** Establish these first.
2. **Displacement parameters** (U_iso, tied per element or per site as the model says).
3. **One correlated-motion term**: `delta2` at low temperature, `delta1` at high
   temperature. **Never both**, and never together with `sratio`/`rcut` — they describe the
   same near-neighbour peak sharpening, and the correlation check refuses the pair.
4. **Positions** (in the app, the constrained atomic coordinates, or the symmetry-mode
   amplitudes in irreps mode).
5. **Occupancies last**, under the same guardrail as Rietveld: never bare; only with a
   site Σ or a known composition tied (`set_site_ties` on the Rietveld page; the PDF page
   holds a shared site's Σ by itself), or a second contrast.

`spdiameter` (the particle-size envelope) is for nanoparticles only, refined over an r
range that reaches the particle size. A displacement parameter going to 0 usually means
the near-neighbour peaks are sharper than the model's — free the correlated-motion term
rather than accept U = 0. Heed the warnings `get_state` lists.

## Local versus average structure

To ask whether the local structure differs from the average one, run a **boxcar scan**
(`refine_pdf_boxcar`; in the app, `boxcar_scan`): the free parameters refined box by box
across r, each box seeded from the previous one. A parameter that drifts with r, or an Rw
that rises at low r, is the local-structure signal. Do this rather than comparing
hand-picked windows. Keep the free set small (scale, cell, ADPs, and the parameter in
question); a box holds less information than the whole window.

## When it's done

- Rw stable when the window's ends move a little; nothing at a bound; no correlation
  refused or developed (the correlation guardrail of my-rietveld-workflow holds here too).
- Physical sanity: U_iso > 0, bond lengths and angles reasonable (`bond_geometry`).
- If the average structure is known (a Rietveld fit of the same sample), say where the
  local one agrees and where it differs.

Report: Rw and the window, the refined values with their (non-statistical) esds, which
terms were free, and anything held at its standard (Qdamp, Qbroad).

## MCP tool map (quick reference)

| Step | Tool |
|------|------|
| Load | `parse_structure`, `parse_pdf_data` |
| Build the model | `build_pdf_model` |
| Instrument resolution from a standard | `calibrate_qdamp` |
| Run a refinement block | `refine_pdf` |
| Local vs average | `refine_pdf_boxcar` |
| Partial PDFs (which pairs make a peak) | `compute_partial_pdf` |
| Judge a block / the fit | `assess_refinement` |
| Geometry / bonds sanity | `bond_geometry`, `interpret_structure` |

## References

Longer knowledge bases behind this method. Read one only when a question needs it.

- [`total_scattering_pdf_conventions`](../../../knowledge/total_scattering_pdf_conventions_knowledge.md) — which correlation function MATERIA fits (G(r)) and how it maps onto the other conventions in use, with the units, for importing and cross-checking data.
- [`refinement_fitting_algorithms`](../../../knowledge/refinement_fitting_algorithms_knowledge.md) — the least-squares engine: Levenberg–Marquardt, convergence and shift/esd, correlations and the SVD, restraints and esds.
