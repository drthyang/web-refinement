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

## Stage 0 — Load, set the fit range, and sanity-check the cell

1. Load the three inputs: `parse_structure` (CIF), `parse_powder_data` (pattern),
   `parse_instrument`. Confirm the radiation/geometry (CW vs TOF; capillary, flat-plate,
   or cylindrical) — it decides which corrections are even meaningful later.
2. **Set the fit range: read the data's ends** (`check_fit_range`) before anything is
   fitted. The ends of a scan are often not data the model should fit, and a model that
   fits them anyway bends its background — which then trades with the B values at high
   angle. The user's practice, which is also the GSAS-II tutorials': start **just below the
   first reflection** (the background before it tells the structure nothing), and end **in
   a gap below the end of the pattern** when the end is not real data:
   - counts that **step up and stay** at the last points (a detector's or a scan's edge),
     points with no counts, or a line cut by the last point;
   - at the short-d end, the stretch where **no peak stands out of the noise** any more
     (on POWGEN's short-TOF end: "find a place where there are still peaks and put the
     lower limit into a convenient gap");
   - on a converged fit, a stretch at an end the model misses by more than anywhere next
     to it.
   **Keep** what holds information: peaks below the first reflection that no phase explains
   are magnetic order (neutrons, below the ordering temperature) or another phase — they
   stay in the window and get explained (Cr₂WO₆ at 4 K: four peaks below the first nuclear
   reflection, the strongest 40σ). Keep both ends when peaks are clear to the last point.
   Every cut goes in a gap between reflections, never through a line. The tool reports
   each end with its evidence and the counting σ there (PbSO₄ on D1A: one detector counts
   the last 6°, 3.2× the middle's relative σ) and proposes the window; apply it with
   `set_fit_range`, which asks the user, and say why end by end. A large cut (more than
   15 % of the points) is the user's call. Read the ends again after the first refinement:
   the residual then shows what the data alone could not (PbSO₄: the last 0.8° sat 4.4σ
   above the model, more than anywhere just inside). The page fits one window; a stretch
   inside the pattern (a spike, a sample-environment line) cannot be left out — say so.
3. Run the **free-intensity (Le Bail) check**: `check_cell_symmetry` (pass known impurity
   phases as `extraPhases`). It refines the cell by a Le Bail fit and reads what is left
   over. It is a sanity check, not a gate — it never holds a refinement:
   - **unindexed peaks** (`unindexedPeaks`) — a peak no reflection of the cell can place.
     Most often a missing phase (an impurity), sometimes a wrong cell. Worth settling with
     the user before the structure is refined: identify the phase and add it, or check
     the cell. This is the one thing refinement cannot fix. On neutron data at low or high
     temperature, think of the sample environment first: `identify_peaks` matches the
     peaks against Al (can, cryostat shields), V, Cu, steels, Nb, Pb and common standards
     (Cr₂WO₆ at 150 K: weak lines at 62.4° and 73.5° were Al 111 and 200, shifted because
     the shields sit off the sample position). It knows the impurities a synthesis leaves
     most often too (NAC on 11-BM held fluorite), and `add_known_phase`
     adds a matched phase to the model once the user agrees; another phase needs the
     user's CIF. Small bumps on a strong line's flank are `shoulders` — a profile tail,
     not a phase.
   - **absence flags** (`absences.violated`) — leftover intensity at a reflection the
     space group forbids. A flag, not a verdict: before the structure is refined, a strong
     neighbour's profile misfit, an impurity line or the Le Bail fit's own shape error
     reads the same way. Note it (`write_note`) and go on; do **not** propose a lower
     symmetry here. The symmetry review at the end reads the refined residual and decides
     whether the flag was real.
   Report the numbers, not just "passed": how many absences were tested, how many were
   untestable (overlapped), and the tool's `limits` — it cannot see a too-large cell or a
   group with too few absences.
4. Carry the cell (the tool's Le Bail `cell`), zero, background, and a decent starting
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
4. **ADPs** — with the instrument's terms fixed: the zero, `U V W X Y` and the asymmetry
   are held while the B values refine (the guardrail below), then the two groups
   alternate. `B_iso` first. Go **anisotropic only if the data clearly support it**
   (high real-space resolution / low temperature); otherwise keep it isotropic. Watch for
   `B_iso` railing toward 0 — that usually means the background or an intensity correction
   is stealing high-angle intensity, not that the atom is truly rigid. When B values are
   not *determined* — they swap between two refinement paths at the same wR, an esd is as
   large as the value, or one rails at 0 as its partner climbs (common below Q ≈ 6 Å⁻¹) —
   `tie_parameters` constrains chemically alike atoms to one B (the cations of an oxide,
   all the oxygens): one value with a real esd beats two numbers the data cannot separate.
   Say in the report which B's are tied and why.
5. **Occupancy** — see the guardrail below. Usually near-last.
6. **Corrections** — end-stage polish only; see below.

If the fit stalls between blocks, use `rank_next_parameters` / `assess_refinement` to see
what is limiting it, but keep the block order — don't jump ahead to occupancy or
corrections to chase a number. When the verdict is poor or fair and you need to know *why*,
`diagnose_fit` reads the residual cause by cause (background, peak positions, asymmetry,
width/shape, intensity fall-off with angle, texture, structure), with the share of χ² each
carries and the action. Act on the largest first, and re-run it after each change.

**Peak asymmetry is part of the profile, not polish.** On constant-wavelength data a
one-sided residual at low angle (`diagnose_fit` says asymmetry) is axial divergence: switch
it on (`set_corrections` asymmetry; S/L refines, H/L follows it) and refine it with the
Caglioti terms. On PbSO₄ (D1A) it took wR from 12% to 6%. A Lorentzian X or Y that
refines negative is unphysical: reset it (`reset_parameters` with its id), hold it, refine
the rest.

**When the starting profile is far off, the profile comes before the positions.** The
order above assumes the instrument's widths are roughly the sample's. When `diagnose_fit`
measures the lines much broader (or narrower) than calculated (`peak-width`), refine the
Caglioti terms first and say why: positions refined against lines that wrong absorb the
width misfit. Then, if it says the lines are more Lorentzian than calculated
(`peak-tails`: a Gaussian core widened to reach long tails), free X and Y. Fluorapatite on
a Cu tube: lines 1.7× the instrument file's width, then η ≈ 0.8 — wR 37 → 18 → 9 %, with
the positions barely moving until the shape was right.

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

**Antisite disorder has a signature in the ADPs.** When, after the ADP stage, one cation
site's B rails toward 0 while another's is high, the first scatters more and the second
less than the ordered model says: the two elements exchange (Cr₂WO₆: B(Cr) 0.0, B(W)
1.7). If the probe has contrast between them (neutron b, or X-ray Z), `add_antisite`
puts each element on the other site at occupancy 0 with Σ occ = 1 and hold composition —
one exchange fraction under the formula (it asks the user). Free the four occupancies,
refine, and report the exchange with its esd and how the B values moved. On data to a
modest Q the exchange trades with the B values: a large esd is the honest result. If the
exchange refines to zero, the ADP contrast is not disorder: return to the ordered model
and, unless the contrast is significant and stable, tie the two cation B's.

## The instrument–thermal guardrail (do not skip)

**Never refine the instrument's terms together with the thermal parameters.** The
instrument's terms are GSAS-II's Instrument Parameters: the **zero** (or the TOF
calibration), the **peak shape** (Caglioti `U V W`, Lorentzian `X Y`, the TOF α β σ) and its
**asymmetry** (S/L, H/L). The thermal parameters are the **B values or ADPs**. They trade
against each other where the data can hardly separate them: wider or more Lorentzian
peaks put intensity into tails that the background takes up at high angle, and the B
values' fall-off with angle gives it back; the zero and the asymmetry shape the low-angle
lines, which fix the scale the B values are measured against. Refined together, each
absorbs the other's error — a B gone negative while the profile widens, a profile gone
wrong while the B values look fine — and the esds hide it, because the trade runs through
the background and the scale rather than one clean pair.

**Alternate the two groups instead.** Refine the instrument terms with the B values fixed,
then fix them and refine the B values; repeat. In the app, `refine` reports the
`alternation` after each step: the group refined, its largest shift since its last
refinement (in esd), and `settled` once a cycle moves neither group by more than 0.3 esd —
stop there. If the shifts shrink slowly (each cycle more than two-thirds of the last), the
groups are coupled: tell the user, and report the B values as conditional on the
instrument terms unless they allow one joint refinement. Either way, each group's esds are
conditional on the other held fixed — say so in the report.

**With an instrument file from a standard**, its terms describe the instrument already:
keep them fixed where they fit, and refine only what the sample adds. A microstrain model
(`set_microstrain`) is the sample's broadening and is not under this rule (watch its
correlation with the B values all the same); `X` and `Y` are, because they hold the
instrument's Lorentzian part as well as the sample's size and strain. When the file does not describe the
data — NAC on 11-BM: the 2009 profile was a quarter too broad in its Gaussian part —
refine its terms, alternating with the B values as above.

In the app this is a firm rule: `refine` refuses a free set that holds both groups and says
which to fix. Only the user lifts it (`allow_exception`, rule `instrument-with-thermal`),
for instance for one last joint cycle to get joint esds once the alternation has settled.

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

When a pair has to stay free together, or a value stays unconvincing after the method has
run (an esd as large as the value, a parameter on a bound, a value that moves between
refinement paths at the same wR), sample the posterior before reporting it: the
`bayesian-check` skill says when and how, and `sample_posterior` runs it on the page.

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

In the app, `set_corrections` switches each on (their rows come in fixed: free them, then
refine): `preferredOrientation` [h, k, l] when `diagnose_fit` finds the intensity misfit
following one direction, `peak` absorption (capillary), displacement / transparency /
roughness (flat plate).

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
   lengths/angles are reasonable (`bond_geometry` gives the bond-valence sums).
   `assess_refinement` surfaces at-bounds and unphysical parameters; treat any as a
   blocker, not a rounding detail. A parameter the result rests on that is weakly
   determined gets its credible interval (`bayesian-check`), not only its esd.
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
+ any correlations/at-bounds worth knowing — not just "converged, wR = X%". `structure_table`
gives the cell and the coordinates, occupancies and B as value(esd); compare them with a
published structure when there is one.

**The written report.** In the app, `write_report` writes it once the analysis is done and
reported: the page's report (data, model, fit figure, structure with esds, every parameter)
with the History's steps, the method's checklist, the engine's checks and open issues, the
Bayesian check of the refinement on screen if one ran, and the notes. Every number in it is
the engine's. Its `summary` is the account in your own words — the approach, what the result
says about the structure, the caveats, what is left open — and adds no number of its own: a
number it quotes must be one the tools gave (rounded at most). Numbers the report did not
compute are underlined in it and listed back; correct the account and write it again. Over
MCP, the same content comes from `export_bundle` and the tools' results.

**Lab X-ray data.** The instrument file says which lines the tube gives: a Cu or Co tube
without a monochromator gives Kα₁ and Kα₂, and every reflection is drawn at both (the
data card shows "λ 1.5405 / 1.5443 Å (Kα₂ 0.5)"). A Kα₂ peak is never an extra peak. The
polarization fraction P of the Lorentz-polarization factor is an instrument constant the
fit cannot determine: it changes intensity with angle as the ADPs do, so every B moves
with it at the same wR (fluorapatite: P 0.7 → 0.5 lowered every B by ≈ 0.55 Å², and with
0.5 they matched GSAS's own refinement of the data). Report the B values with the P they
assume. If the instrument file's P does not fit the setup the user describes (0.5
unpolarized; ≈ 0.56 for Cu with a graphite monochromator), propose
`set_instrument_constants` — it always asks the user.

**The cell is only as good as the wavelength.** On constant-wavelength neutron data the
wavelength is a calibration, not a constant: a cell uniformly off by a fraction of a percent
from the literature says the wavelength is (PbSO₄ on D1A: 0.13% small, λ ≈ 1.9115 Å rather
than the nominal 1.909 Å). Quote such a cell as uncalibrated, or calibrate λ against a
standard or an X-ray cell.

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
- **Magnetic**: once the nuclear structure is converged, hand off to the `magnetic-analysis`
  skill (in the app, the powder page's magnetic analysis step; over MCP,
  `search_propagation_vector`, `list_magnetic_subgroups`, `build_magnetic_model`,
  `refine_magnetic_powder`) — a separate method, not this one.

## MCP tool map (quick reference)

| Step | Tool |
|------|------|
| Load | `parse_structure`, `parse_powder_data`, `parse_instrument` |
| The fit range (first) | `check_fit_range` (the data's ends: where to start and stop; in the app, then `set_fit_range`) |
| Cell sanity check (start) | `check_cell_symmetry` (Le Bail cell, unindexed peaks, absence flags) |
| Build param set + staged plan | `build_refinement` |
| Run a refinement block | `refine_powder` |
| Judge a block / the fit | `assess_refinement` |
| Decide what's limiting the fit | `rank_next_parameters`, `suggest_next_steps` |
| Geometry / bonds sanity | `bond_geometry`, `interpret_structure` |
| Cross-check export | `export_bundle` (`fullprof` + `gsas2`, into `outDir`) |
| The written report (in the app) | `write_report` |
| Magnetic handoff | `build_magnetic_model`, `list_magnetic_subgroups`, `refine_magnetic_powder` |
| Symmetry review (last, if at all) | `review_symmetry` on the converged residual; then the `symmetry-review` skill |

## References

Longer knowledge bases behind this method. Read one only when a question needs it.

- [`powder_structural_refinement`](../../../knowledge/powder_structural_refinement_knowledge.md) — the Rietveld model and its policy: profile functions, ADPs, occupancies, constraints, and what makes a refinement physically defensible.
- [`refinement_fitting_algorithms`](../../../knowledge/refinement_fitting_algorithms_knowledge.md) — the least-squares engine: Levenberg–Marquardt, convergence and shift/esd, correlations and the SVD, restraints, esds and the GoF.
- [`powder_background_texture`](../../../knowledge/powder_background_texture_knowledge.md) — background models and preferred orientation: which basis to use, how many terms, and how texture shows in the residual.
- [`magnetic_structure_symmetry`](../../../knowledge/magnetic_structure_symmetry_knowledge.md) — magnetic symmetry and refinement, for the hand-off: when excess intensity may be magnetic order and what the magnetic step needs.
