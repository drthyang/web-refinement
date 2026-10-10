---
name: my-rietveld-workflow
description: >-
  The user's personal powder Rietveld refinement methodology for MATERIA — a sanity
  check of the cell, a fixed freeing sequence, acceptance criteria, and the space group
  questioned last, only once everything else is refined — driving the MATERIA MCP
  tools. Use this whenever the user asks to refine a loaded powder pattern, run "my
  refinement", do a Rietveld refinement, stage or free parameters on a powder dataset,
  decide what to refine next, or asks why a fit is stuck — even if they don't name the
  skill. Covers constant-wavelength and time-of-flight, single- and multi-phase; hands
  off to the magnetic-analysis flow for magnetic structures. NOT for single-crystal
  integrated-intensity refinement, and NOT for ab-initio structure solution / indexing
  an unknown cell.
---

# My Rietveld workflow (MATERIA)

This encodes **how the user runs a powder refinement** — the order, the checks, and the
bar for calling it done. It is deliberately opinionated: it is their method, not a generic
"free everything and hope" Rietveld. Follow the sequence, but explain what you are doing
and why at each stage so they can steer — they judge the fit, you drive the mechanics.

The heuristics live in the app already (`suggest_next_steps`, `rank_next_parameters`,
`assess_refinement`, the staged plan). This skill's job is to apply **their** ordering and
**their** stopping rules on top of them.

## The rule that comes before everything: doubt the model before the symmetry

**Refine the model to the best its space group allows before questioning the space
group.** Changing the symmetry is the *last* step, taken only when everything in this
method has been refined and the fit is still not good — never at the beginning, and never
to explain a misfit that refinement has not yet had a chance to fix.

At the start, observed and calculated intensities differ on many reflections. That is
normal: it is exactly what refining the atoms, ADPs, occupancies, the profile and the
corrections fixes. A reflection the model has, with more or less intensity than calculated,
is a **misfit to refine**, never an "extra peak" and never evidence for a lower symmetry.
Only a peak that sits on no reflection of any phase is an extra peak.

## Stage 0 — Load and sanity-check the cell

1. Load the three inputs: `parse_structure` (CIF), `parse_powder_data` (pattern),
   `parse_instrument`. Confirm the radiation/geometry (CW vs TOF; capillary, flat-plate,
   or cylindrical) — it decides which corrections are even meaningful later.
2. Run the **free-intensity (Le Bail) check**: `check_cell_symmetry` (pass known impurity
   phases as `extraPhases`). It refines the cell by a Le Bail fit and reads what is left
   over. It is a sanity check, not a gate — it never holds a refinement:
   - **unindexed peaks** (`unindexedPeaks`) — a peak no reflection of the cell can place.
     Most often a missing phase (an impurity), sometimes a wrong cell. Worth settling with
     the user before the structure is refined: identify the phase and add it, or check
     the cell. This is the one thing refinement cannot fix.
   - **absence flags** (`absences.violated`) — leftover intensity at a reflection the
     space group forbids. A flag, not a verdict: before the structure is refined, a strong
     neighbour's profile misfit, an impurity line or the Le Bail fit's own shape error
     reads the same way. Note it (`write_note`) and go on; do **not** propose a lower
     symmetry here. The symmetry review at the end reads the refined residual and decides
     whether the flag was real.
   Report the numbers, not just "passed": how many absences were tested, how many were
   untestable (overlapped), and the tool's `limits` — it cannot see a too-large cell or a
   group with too few absences.
3. Carry the cell (the tool's Le Bail `cell`), zero, background, and a decent starting
   profile forward as the seed for the structural refinement. When the user asks for a
   refinement, refine: the check informs the refinement, it does not stand in its way.

Rationale: the check catches what refinement cannot fix (a peak nothing indexes). What
refinement can fix — intensity on the group's own reflections, and the profile — it leaves
to refinement.

## Stage 1 — Structural refinement, in the fixed order

The sequence is **atoms before profile**. Build the refinement (`build_refinement`) and
free parameters in this order, refining (`refine_powder`) and checking
(`assess_refinement`) between blocks. Free the next block only once the current one is
stable and hasn't railed to a bound.

1. **Scale + background + cell** — establish these first so intensity has somewhere sane
   to go. **Re-free the cell here** (with the zero) even though the check already
   refined it: the Le Bail cell is a starting value, and the structural refinement
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
the user, not a suggestion — and in the app a refinement with a bare occupancy is refused;
only they can allow one (`allow_exception`), for a genuine second contrast.

In the app the first two are the Shared site ties (`set_site_ties`): **Σ occ = 1** holds a
mixed site full, and **hold composition** keeps each element's total in the cell, so atoms
exchange between sites while the formula stays — anti-site disorder or spinel inversion
then refines as one exchange fraction. The ties act only while an occupancy they cover is
free, and `get_state` lists them. Report the exchange fraction (e.g. the inversion as the
minority cation's occupancy on the other site) with its esd, not every occupancy.

## The correlation guardrail (do not skip)

**Never refine strongly correlated parameters together.** Two free parameters that
correlate at |ρ| ≥ 0.95 carry information the data cannot separate: the fit trades one
against the other along a valley, their esds inflate, and either can land anywhere on it.
Check the free set before each refinement — the in-app Agent's `refine` measures it at the
current values and refuses a correlated set; headless, read the correlations
`refine_powder` and `assess_refinement` report. When a pair correlates, fix one — usually
the one this sequence frees later (occupancy against scale, B against scale, the zero
against the cell) — or refine them in separate stages, and free it again only once the
other is stable. A combination the data cannot determine at all (a null direction) is the
same rule at its limit. This is a firm rule for the user, like the occupancy guardrail.

What does **not** count: the terms of one curve among themselves — the background
coefficients, and the Caglioti `U, V, W` of one FWHM²(θ). They trade off by construction
while the curve itself is determined, and nobody reports them as results, so free `U, V, W`
together on a wide range. Two occupancies tied by one restraint (a mixed site's Σ, the
composition) move together by construction too. Each of these against anything else (the
scale, a structural parameter) still counts, and so does the Lorentzian `X` ↔ `Y` (size
against strain, which people do report).

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

## The symmetry review — the last step, if at all

Only when every block above has been refined to convergence (scale/background/cell,
positions, profile, ADPs; occupancy and corrections where the data called for them) and the
fit is still not acceptable may the space group be questioned — and then only on evidence
in the **refined** residual, not on the Stage 0 flag. Run `review_symmetry` (in the app it
refuses, naming the stages left, until they are done). It reads the refined residual at the
reflections the group forbids and lists the subgroups of the same lattice that allow those
still carrying intensity.

- **No forbidden reflection carries intensity**: the symmetry is not the problem. Look at
  the profile, the background, a missing phase, or the model's chemistry instead.
- **Some do**: rule out what else puts intensity there, then put the evidence to the user
  — which reflections, how many σ, which subgroups (smallest index first), how many
  domains. The decision is theirs. Never change the model yourself. Read the
  `symmetry-review` skill for the full procedure.

What is **not** evidence for a lower symmetry: intensity misfit on allowed reflections; a
poor GoF on its own; an absence the Stage 0 check flagged that the refined residual no
longer shows.

## When it's done — the acceptance bar

The user does **not** chase absolute Rwp. A fit is acceptable when all of:

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
   and confirm the parameters and ESDs are consistent. Write both bundles with
   `export_bundle` (`target` `"fullprof"` and `"gsas2"`, the refine call's `parameters`
   and `result`, the original instrument file as `rawInstrument`, an `outDir`) and give
   the user the paths. The `.pcr` starts scale, background and the CW peak shape from seeds —
   say so, since they must be freed in FullProf before the comparison means anything.

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
  when it fights back. Report each phase's **weight fraction** (Hill–Howard, from the
  refined scales: `get_state` gives `phaseFractions` with esds) and say what it rests on —
  the crystalline phases in the model only, no microabsorption correction.
- **Magnetic**: once the nuclear structure is converged, hand off to the magnetic-analysis
  flow (`build_magnetic_model`, `list_magnetic_subgroups`, `search_propagation_vector`,
  `refine_magnetic_powder`) — that's a separate methodology, not this one.

## MCP tool map (quick reference)

| Step | Tool |
|------|------|
| Load | `parse_structure`, `parse_powder_data`, `parse_instrument` |
| Cell sanity check (start) | `check_cell_symmetry` (Le Bail cell, unindexed peaks, absence flags) |
| Build param set + staged plan | `build_refinement` |
| Run a refinement block | `refine_powder` |
| Judge a block / the fit | `assess_refinement` |
| Decide what's limiting the fit | `rank_next_parameters`, `suggest_next_steps` |
| Geometry / bonds sanity | `bond_geometry`, `interpret_structure` |
| Cross-check export | `export_bundle` (`fullprof` + `gsas2`, into `outDir`) |
| Magnetic handoff | `build_magnetic_model`, `list_magnetic_subgroups`, `refine_magnetic_powder` |
| Symmetry review (last, if at all) | `review_symmetry` on the converged residual; then the `symmetry-review` skill |

## References

Longer knowledge bases behind this method. Read one only when a question needs it.

- [`powder_structural_refinement`](../../../knowledge/powder_structural_refinement_knowledge.md) — the Rietveld model and its policy: profile functions, ADPs, occupancies, constraints, and what makes a refinement physically defensible.
- [`refinement_fitting_algorithms`](../../../knowledge/refinement_fitting_algorithms_knowledge.md) — the least-squares engine: Levenberg–Marquardt, convergence and shift/esd, correlations and the SVD, restraints, esds and the GoF.
- [`powder_background_texture`](../../../knowledge/powder_background_texture_knowledge.md) — background models and preferred orientation: which basis to use, how many terms, and how texture shows in the residual.
- [`magnetic_structure_symmetry`](../../../knowledge/magnetic_structure_symmetry_knowledge.md) — magnetic symmetry and refinement, for the hand-off: when excess intensity may be magnetic order and what the magnetic step needs.
