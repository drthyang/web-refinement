---
name: symmetry-review
description: >-
  The last step of a powder Rietveld refinement, taken only if needed: deciding whether
  the data ask for a lower space group, after the structure has been refined to the best
  its group allows (scale, background, cell, positions, profile, ADPs; occupancy and
  corrections where the data call for them) and the fit is still not good. Use it when
  the user asks whether the symmetry is right, when review_symmetry finds intensity at
  forbidden reflections, or when someone proposes lowering the symmetry — to check the
  proposal comes at the right time and on the right evidence. NOT for the start of a
  refinement: intensity misfit on allowed reflections, or a Le Bail absence flag before
  the structure is refined, is never a reason to change the space group.
---

# The symmetry review — last, and only on evidence

A Rietveld refinement is driven to the best its space group allows before the group is
questioned. Lowering the symmetry adds parameters that will always lower χ² a little; done
early, it absorbs misfit that refining the atoms, ADPs, profile or corrections would have
fixed, and the lower group is "confirmed" by a better wR it did not earn. So the order is
fixed:

1. Refine everything the method refines, each block to convergence
   (`my-rietveld-workflow`, Stages 1 and the corrections).
2. Judge the fit (`assess_refinement`). If it is acceptable, stop: the symmetry is fine.
3. Only if it is not, and the remaining misfit is not on the group's allowed reflections,
   review the symmetry.

In the app, `review_symmetry` refuses until the method's stages are done, and says which
are left. Do not work around it by reasoning from the Stage 0 check: an absence flag there
is a note to revisit, not a finding.

## What counts as evidence

The one direct signal is **intensity at a reflection the group forbids**, in the
**refined** residual, standing clear of every allowed reflection. `review_symmetry` reads
exactly that: each forbidden reflection at least 2% in d from any allowed one (closer, its
intensity cannot be told from that reflection's misfit — it is reported as untestable), and
a residual peak on it above its own noise.

Not evidence:
- **Intensity misfit on allowed reflections** — calculated too strong or too weak. That is
  the structure, ADPs, occupancy, texture (preferred orientation) or absorption.
- **A poor GoF on its own** — the profile, the background, a missing phase, or σ's that
  do not describe the data are far commoner causes.
- **Peak splitting or broadening of allowed reflections** — that may be a lower *lattice*
  symmetry (a distorted cell), which shows as allowed reflections splitting, not as
  forbidden ones appearing. Raise it with the user as such; `review_symmetry` does not test
  it.

## Before proposing a lower group: rule out the alternatives

Intensity at a forbidden position has other causes. Check each, and say what you checked:

- **An impurity line that lands there.** `find_unexplained_peaks`: are there other
  unexplained peaks a second phase would also explain? Then it is a phase, not the
  symmetry.
- **Magnetic order (neutron data).** Below the ordering temperature, k = 0 magnetic order
  puts intensity on nuclear-forbidden reflections. Is the sample magnetic and cold enough?
  That belongs to the magnetic analysis, not to a lower nuclear group.
- **λ/2 contamination or a detector artefact** — a forbidden reflection at exactly half
  the d of a strong allowed one is suspect.
- **Multiple diffraction** (Renninger) — rare in powders, but it fakes forbidden
  reflections in single crystals and textured samples.

## Reading `review_symmetry`

- `observedForbidden`: each forbidden reflection with intensity, its d and how many σ.
  One weak reflection is a hint; several, consistently, at the positions one lost
  symmetry element would open, is a case.
- `candidates`: the subgroups of the same lattice (translationengleiche) that allow them,
  smallest index first, with how many domains each has. A subgroup is named where it can be
  identified; otherwise its point group and index are given. Prefer the **smallest index**
  (the least symmetry lost) that explains *all* the observed reflections.
- `domains` > 1 means the lower-symmetry crystal grows as twin domains (orientations
  related by the lost operations). In a powder they average out; in a single crystal they
  must be refined as twins.
- `limits`: lost centrings and larger cells are not enumerated. If no t-subgroup explains
  the reflections, the answer may be a supercell (new reflections between the old ones —
  `find_unexplained_peaks` sees them as unexplained peaks) or a lost centring; say so
  rather than forcing a candidate.

## Proposing it to the user

Put the evidence, not a conclusion:

- the stages refined and the fit reached (GoF, the key values);
- the forbidden reflections with intensity, how many σ, and what you ruled out;
- the candidate subgroups (smallest index first) and what each would add — free
  coordinates that split, ADPs, the domain count.

The decision is the user's. Never change the model yourself. If they want to try it:

1. They load the lower-symmetry model (its CIF). On the page, that is a new analysis.
2. It is refined again **from the start of the method** — the cell check, then each block
   — not from where the high-symmetry fit stopped with everything free.
3. A distortion-mode parameterisation (`build_distortion_modes`, parent and child CIF)
   refines the few symmetry-breaking mode amplitudes instead of every split coordinate;
   modes that stay at zero within their esd say the symmetry is not really broken.
4. Compare the two fits on the same data and the same fit range, and keep the lower group
   only if all hold:
   - it fits the forbidden reflections, and the misfit does not move elsewhere;
   - the improvement in χ² is significant for the parameters added (Hamilton's R-factor
     ratio test is the classical yardstick; on powder data, with thousands of points, it
     passes easily — also ask whether the gain is concentrated at the forbidden
     reflections);
   - the new parameters are sensible: split positions and ADPs within physical bounds, no
     correlations near 1 between the formerly equivalent atoms, bond lengths reasonable.

If it fails any of these, the original group stands, and the misfit is reported as an open
question rather than "fixed" by lower symmetry.

## Tools

| Step | Tool |
|------|------|
| Is everything refined? | `get_state` (`method` stages), `assess_refinement` |
| The review | `review_symmetry` |
| An impurity instead? | `find_unexplained_peaks` |
| A lower-symmetry model as modes | `build_distortion_modes` |
| Record the outcome | `write_note` |

## References

Longer knowledge bases behind this review. Read one only when a question needs it.

- [`powder_structural_refinement`](../../../knowledge/powder_structural_refinement_knowledge.md) — the Rietveld model and its policy: what makes a refinement physically defensible, and the residual checks after it.
- [`refinement_fitting_algorithms`](../../../knowledge/refinement_fitting_algorithms_knowledge.md) — the least-squares engine: correlations and the SVD, esds and the GoF, and how symmetry constrains the landscape.
- [`magnetic_structure_symmetry`](../../../knowledge/magnetic_structure_symmetry_knowledge.md) — when intensity at a nuclear-forbidden position may be magnetic order instead.
