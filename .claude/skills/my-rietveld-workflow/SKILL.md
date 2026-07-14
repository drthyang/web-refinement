---
name: my-rietveld-workflow
description: >-
  The user's personal powder Rietveld refinement methodology for MATERIA — his fixed
  freeing sequence, his gates, and his acceptance criteria — driving the MATERIA MCP
  tools. Use this whenever the user asks to refine a loaded powder pattern, run "my/his
  refinement", do a Rietveld refinement, stage or free parameters on a powder dataset,
  decide what to refine next, or asks why a fit is stuck — even if he doesn't name the
  skill. Covers constant-wavelength and time-of-flight, single- and multi-phase; hands
  off to the magnetic-analysis flow for magnetic structures. NOT for single-crystal
  integrated-intensity refinement, and NOT for ab-initio structure solution / indexing
  an unknown cell.
---

# My Rietveld workflow (MATERIA)

This encodes **how the user runs a powder refinement** — the order, the gates, and the
bar for calling it done. It is deliberately opinionated: it is his method, not a generic
"free everything and hope" Rietveld. Follow the sequence, but explain what you are doing
and why at each gate so he can steer — he judges the fit, you drive the mechanics.

The heuristics live in the app already (`suggest_next_steps`, `rank_next_parameters`,
`assess_refinement`, the staged plan). This skill's job is to apply **his** ordering and
**his** stopping rules on top of them.

## The one rule that comes before everything

**Do not refine the structure until the cell and space group are trusted.** A structural
refinement on a wrong cell or space group produces a plausible-looking wR and a wrong
answer — the most expensive failure mode. So the workflow has a hard gate up front.

## Stage 0 — Load and gate on cell + symmetry

1. Load the three inputs: `parse_structure` (CIF), `parse_powder_data` (pattern),
   `parse_instrument`. Confirm the radiation/geometry (CW vs TOF; capillary, flat-plate,
   or cylindrical) — it decides which corrections are even meaningful later.
2. Run a **free-intensity (Le Bail) check** — in the app this is the Prefit path, which
   fits cell + profile + zero (+ background) with intensities free. The gate the user
   applies:
   - **every observed peak indexes**, and
   - the **systematic absences are consistent with the chosen space group**.
   If a peak won't index or an absence is violated, STOP and say so — the cell or space
   group is wrong, and no amount of structural refinement will fix it. Do not proceed.
3. Only once that holds do you carry the cell, zero, background, and a decent starting
   profile forward as the seed for the structural refinement.

Rationale: he gates on *indexing + absences*, not just "the Le Bail wR looks low" — a low
free-intensity wR can hide a wrong space group that still fits by absorbing intensity.

> **Dependency (MCP):** enforcing this gate needs an executable Le Bail fit **plus** an
> indexing / systematic-absence check. Until an MCP tool provides that (e.g. a
> `check_indexing` / Le Bail-gate tool), this gate is a *narrated judgement*, not a
> computed one — so state explicitly which peaks you checked index and which absences you
> verified, and have the user confirm the cell/SG rather than asserting "trusted."

## Stage 1 — Structural refinement, in his fixed order

His sequence is **atoms before profile**. Build the refinement (`build_refinement`) and
free parameters in this order, refining (`refine_powder`) and checking
(`assess_refinement`) between blocks. Free the next block only once the current one is
stable and hasn't railed to a bound.

1. **Scale + background + cell** — establish these first so intensity has somewhere sane
   to go. **Re-free the cell here** (with the zero) even though the gate already
   established it: the Le Bail cell is a starting value, and the structural refinement
   re-refines it against the full model. (Watch the cell↔zero↔displacement correlation —
   `assess_refinement` flags it; free the zero from a standard or on a wide range.)
2. **Atomic positions** — freed *early*, against the roughly-correct profile carried from
   the Stage 0 Le Bail fit (its peak shapes are already close). Getting the atoms roughly
   right first keeps the profile from later absorbing structural misfit as fake broadening.
   Treat this as a *quick* pass, not a fight: on a well-behaved pattern the positional gain
   here is often small — the profile is usually the bigger lever. Refine positions to a
   fast convergence and move on. If they barely move the fit, that's expected, not a
   problem; don't keep chasing positions before the profile is refined. (On the GaNb4Se8
   test this stage moved wR only 18.4→17.6%, then the profile took it to 7.6% — normal.)
3. **Profile** — now refine the peak shape. A reasonable order is Caglioti `W` → then
   `U, V` → then the Lorentzian size/strain `X, Y`, but this is *not* rigid: free whichever
   terms the residual actually needs. `U` correlates strongly with sample broadening, so on
   a narrow 2θ range it is often held — but free it (and the rest) when a genuine width
   mismatch demands it rather than withholding it on principle. Judge by the residual and
   the correlations `assess_refinement` reports, not by a fixed checklist.
4. **ADPs** — `B_iso` first. Go **anisotropic only if the data clearly support it**
   (high real-space resolution / low temperature); otherwise keep it isotropic. Watch for
   `B_iso` railing toward 0 — that usually means the background or an intensity correction
   is stealing high-angle intensity, not that the atom is truly rigid.
5. **Occupancy** — see the guardrail below. Usually near-last.
6. **Corrections** — end-stage polish only; see below.

If the fit stalls between blocks, use `rank_next_parameters` / `assess_refinement` to see
what is limiting it, but keep the block order — don't jump ahead to occupancy or
corrections to chase a number.

## The occupancy guardrail (do not skip)

**Never free occupancies bare.** Scale and site occupancy are near-degenerate on a single
site — both just scale intensity — so a free occupancy will happily trade against the
scale and land somewhere chemically meaningless. Free an occupancy only when one of these
breaks the tie:

- a **Σ = 1 (or Σ = known total) restraint** on a shared/mixed site, or
- a **known chemical constraint** (fixed composition), or
- a **genuine second contrast** — anomalous (X-ray near an edge) or isotopic (neutron) —
  that makes occupancy separately determined.

If none of these is present, keep occupancy fixed and say why. This is a firm rule for
him, not a suggestion.

## Corrections are polish, not a crutch

Add sample/intensity corrections **only after the structure has converged**, to clean up
a residual — never early, and never to rescue a bad structural model. Available (all in
the correction registry): specimen **displacement** (∝cosθ), **transparency** (∝sin2θ),
**Suortti roughness**, cylinder **absorption μR**, and **preferred orientation** (March–
Dollase). Match the correction to the geometry and the residual signature:

- capillary / cylindrical transmission → **μR** for the low-angle intensity; roughness and
  transparency do **not** apply.
- flat-plate reflection → **displacement** (cosθ peak drift) and, if there's a low-angle
  intensity deficit, **roughness**; **transparency** for a low-μ slab.
- a systematic hkl-family intensity mismatch → **preferred orientation**.

Watch the correlations `assess_refinement` reports — displacement correlates with the cell
and the zero; roughness SRA/SRB correlate with each other and with scale/background. Free
at most what the angular range can actually separate.

## When it's done — his acceptance bar

He does **not** chase absolute Rwp. A fit is acceptable when all of:

1. **GoF (= Rwp/Rexp, i.e. reduced χ²) is reasonable** — the fit is close to the
   statistical floor, not just numerically small. Report GoF, not Rwp alone. **Flag a GoF
   meaningfully below 1** — it does not mean "great fit," it means the counting σ's are
   over-estimated or the model is over-parameterized for the real information, so the ESDs
   are optimistic. Say so and suggest checking the weighting / the free-parameter count
   rather than celebrating. (The GaNb4Se8 run landed GoF ≈ 0.46 — a good fit, but with
   generous σ's, exactly this case.)
2. **Physical sanity holds** — `B_iso > 0`, occupancy sums are chemically sensible, bond
   lengths/angles are reasonable. `assess_refinement` surfaces at-bounds and unphysical
   parameters; treat any as a blocker, not a rounding detail.
3. **External cross-check agrees** — export and re-run in **both GSAS-II and FullProf**
   (the app has one-click FullProf `.pcr` + GSAS-II bundle export) and confirm the
   parameters and ESDs are consistent. Offer to produce that bundle as the final step.

**Stopping rule — cross-check agreement.** The signal that the refinement is *done* is not
an internal Δχ² threshold; it's that the **external cross-check agrees**. Levenberg–
Marquardt converging is necessary but not sufficient — keep iterating (and re-examining the
model) until GSAS-II and FullProf reproduce the same parameters and ESDs on the same data.
If the packages disagree, the fit isn't finished, however good the internal GoF looks:
find and resolve the discrepancy before calling it. This makes the cross-check (acceptance
item 3) the actual terminator of the loop, not just a final rubber-stamp.

Report the outcome as: GoF + the key refined values with ESDs + which corrections were on
+ any correlations/at-bounds worth knowing — not just "converged, wR = X%".

## Multi-phase and magnetic

- **Multi-phase**: one instrument illuminates every phase, so the instrument/profile,
  zero, background, and the sample-geometry corrections are **shared**; only scale, cell,
  atoms, and per-phase microstructure are per-phase. **Default: free each block across all
  phases at once** — same stage, all phases simultaneously — because it's faster and the
  shared instrument keeps them coupled anyway. **Fall back to phase-by-phase only if the
  all-at-once step is unstable** (a phase's scale collapsing, divergence, or runaway
  cross-phase correlations that `assess_refinement` flags). Try the simple way first; split
  when it fights back.
- **Magnetic**: once the nuclear structure is converged, hand off to the magnetic-analysis
  flow (`build_magnetic_model`, `list_magnetic_subgroups`, `search_propagation_vector`,
  `refine_magnetic_powder`) — that's a separate methodology, not this one.

## MCP tool map (quick reference)

| Step | Tool |
|------|------|
| Load | `parse_structure`, `parse_powder_data`, `parse_instrument` |
| Cell/SG gate | free-intensity (Le Bail/Prefit) check |
| Build param set + staged plan | `build_refinement` |
| Run a refinement block | `refine_powder` |
| Judge a block / the fit | `assess_refinement` |
| Decide what's limiting the fit | `rank_next_parameters`, `suggest_next_steps` |
| Geometry / bonds sanity | `bond_geometry`, `interpret_structure` |
| Cross-check export | FullProf `.pcr` + GSAS-II bundle |
| Magnetic handoff | `build_magnetic_model`, `list_magnetic_subgroups`, `refine_magnetic_powder` |
