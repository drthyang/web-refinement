---
name: magnetic-analysis
description: >-
  The powder magnetic structure workflow in MATERIA, after the nuclear structure is
  refined: the propagation vector k from the peaks the nuclear model leaves, the magnetic
  space groups of the little group of k (top-down from the maximal ones), their moments
  fitted against the data, then nuclear and magnetic refined together, with the powder's
  limits stated. Use it whenever the user asks for the magnetic structure, to find k, to
  pick or compare magnetic groups, to refine moments, or why there are peaks below an
  ordering temperature — even if they don't name the skill. Drives the powder page's
  magnetic analysis step (in the app) or the magnetic MCP tools. NOT for the magnetic PDF
  (mPDF). A first draft, not yet confirmed as the user's own method.
---

# Powder magnetic analysis (MATERIA)

This is the magnetic step that `my-rietveld-workflow` hands off to. It is written from the
app's own workflow and the magnetic knowledge base; the user has not yet been interviewed on
it, so where it leaves a choice, say what you chose and why, and let them steer.

## Before anything: the nuclear structure is refined

Magnetic intensity is judged against the nuclear model. If the scale, background, profile,
positions and ADPs are not refined first, the moments absorb their error — above all for
k = 0, where magnetic intensity sits on nuclear reflections. So:

1. The nuclear refinement is converged (`my-rietveld-workflow`, at least its required
   stages). If it is not, do that first.
2. Prefer the nuclear structure from a dataset above the ordering temperature when the user
   has one: fix it, and refine only the magnetic parameters on the ordered data.
3. Know what the residual is. `find_unexplained_peaks` separates peaks on no reflection
   (candidate magnetic satellites, or an impurity) from misfits on known reflections (which
   refinement fixes; for k = 0 on neutron data they may also be magnetic).

## Stage 1 — the propagation vector k

1. Read the step (`magnetic_state`): the magnetic ions, and the residual peaks the k-search
   uses (peaks on nuclear reflections are left out by default; they are profile misfit
   more often than magnetic).
2. `search_propagation_vector` ranks commensurate k by how many included peaks their
   satellites G ± k explain and how closely. Prefer the k that explains every peak with
   the simplest fractions; an impurity's lines will not fit any k — check them against a
   second phase first.
3. Set it (`set_propagation_vector`). k = 0 when the magnetic intensity sits on the nuclear
   reflections (and the sample is below its ordering temperature on neutron data).
4. Choose the magnetic ions (`select_magnetic_ions`): the sites whose ions carry a moment.

## Stage 2 — the magnetic space group, top-down

The groups of the little group of k are listed by index (2 = maximal). Landau theory favours
a single irreducible representation — a maximal group — so start there:

1. `rank_magnetic_groups` with the default scope fits the maximal groups' moments (the
   nuclear model held) and ranks them by wR against the nuclear-only wR. Widen to
   `"all"` only when no maximal group explains the magnetic peaks.
2. Read the ranking honestly. A powder often cannot tell several groups apart (the
   direction ambiguity below): groups within the noise of the best are equally good fits.
   Among them prefer the maximal group with the fewest moment parameters (the ★), and say
   which others fit as well.
3. A group that puts no moment on the chosen ions (0 moment components) cannot be it.

## Stage 3 — the moments

1. `choose_magnetic_group` builds the symmetry-allowed moment model (amplitudes over the
   allowed directions, never free Mx, My, Mz) and starts from the ranked fit.
2. `set_moment_ties` when the powder cannot separate amplitudes: one moment for co-located
   ions on a mixed site (default), equal |M| across sublattices of one element.
3. `refine_moments`, the nuclear model held. Check the result:
   - |M| at most the ionic maximum (spin-only g·S µB; g_J·J for rare earths, usually less).
     More is a red flag: the form factor, the scale, the multiplicity, or overlap.
   - Reduced moments are expected and meaningful (covalency, fluctuations, crystal field).
   - The magnetic peaks are fitted, and the wR gain over the nuclear-only fit is real.

## Stage 4 — nuclear and magnetic together

1. `continue_magnetic_refinement` adds the moment amplitudes as parameter rows on the
   refinement step (and k's free components with `refineK`, for an incommensurate or
   two-arm k the little group lets move). `show_magnetic_model` instead keeps the moments
   held while the nuclear model refines against nuclear + magnetic.
2. Refine there by `my-rietveld-workflow`'s rules: the moments with the scale fixed first,
   then together, watching the correlations (moment ↔ scale; for k = 0, moment ↔ the ADPs
   and occupancies of the magnetic site).
3. `assess_refinement` and the acceptance bar as for the nuclear fit.

## What to report — and what not

- The k, the magnetic space group (BNS symbol and number) and its index, the moment per
  site with its esd, and the agreement against the nuclear-only fit.
- The powder's limits, always: in a cubic group the moment direction is not determinable
  from powder data (only |M|); in a uniaxial one only the angle to the unique axis. Do not
  report a direction the data cannot fix, and do not choose among degenerate groups by R
  factor alone.
- Domains: the group's domain count; a powder averages them.

## Tools

| Step | In the app | Over MCP |
|------|------------|----------|
| The step's state | `magnetic_state` | — |
| Residual peaks | `magnetic_state`, `find_unexplained_peaks` | `find_unexplained_peaks` |
| k | `search_propagation_vector`, `set_propagation_vector` | `search_propagation_vector` |
| Ions | `select_magnetic_ions` | `build_magnetic_model` (`ionLabels`) |
| Groups | `magnetic_state`, `rank_magnetic_groups`, `choose_magnetic_group` | `list_magnetic_subgroups`, `allowed_moments` |
| Moments | `set_moment_ties`, `refine_moments` | `build_magnetic_model`, `refine_magnetic_powder` |
| Together | `continue_magnetic_refinement`, then `refine` | `refine_magnetic_powder` |

## References

Longer knowledge bases behind this method. Read one only when a question needs it.

- [`magnetic_structure_symmetry`](../../../knowledge/magnetic_structure_symmetry_knowledge.md) — magnetic scattering, k, representation analysis and magnetic space groups, allowed moments, physical moments, the powder's direction ambiguity, nuclear–magnetic overlap, and the non-negotiable rules.
- [`refinement_fitting_algorithms`](../../../knowledge/refinement_fitting_algorithms_knowledge.md) — the least-squares engine: correlations and the SVD, restraints, esds and the GoF.
