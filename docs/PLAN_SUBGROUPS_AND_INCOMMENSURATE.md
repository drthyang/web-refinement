# Plan — PDF subgroups & supercells · incommensurate magnetic refinement

> **Status:** planning only, written 2026-09-16. Nothing here is implemented.
> Two independent tracks, raised together as the next things to build:
> **Track A** turns the PDF page's Γ-only distortion workflow into a real
> subgroup-tree + supercell workflow; **Track B** takes incommensurate magnetic
> refinement from "the amplitudes refine" to "the study is publishable".
>
> This is a focused plan, **separate from [ROADMAP.md](ROADMAP.md)** and
> [PDF_MPDF_ROADMAP.md](PDF_MPDF_ROADMAP.md), in the shape of
> [IMPROVEMENT_PLAN.md](archive/IMPROVEMENT_PLAN.md): verified current state first, then
> phases that are each independently shippable and independently validated. Do
> not fold these items into the roadmap tracks; when a phase lands, update the
> roadmap and [LIMITATIONS.md](LIMITATIONS.md) from here.

## Repo gates (apply to every phase in both tracks)

Inherited verbatim from [IMPROVEMENT_PLAN.md](archive/IMPROVEMENT_PLAN.md) §"Repo gates":

- `npm run typecheck` and `npm test` must pass.
- Any new `ParameterKind` must pass the analytic-vs-finite-difference derivative
  gate ([`analyticJacobian.test.ts`](../src/core/workflow/analyticJacobian.test.ts),
  [`pdfAnalyticJacobian.test.ts`](../src/core/workflow/pdfAnalyticJacobian.test.ts)).
- Tests reading `data/` gate on `existsSync`; prefer small fixtures under
  `src/testSupport`.
- New user-facing knobs are named, visible controls, and get MCP tool coverage
  in `src/mcp` where they fit the registry.
- Numeric code gets unit tests against analytic cases; citations at the point of
  implementation and in [REFINEMENT_NOTES.md](REFINEMENT_NOTES.md).
- One phase per PR/commit series. If code contradicts this document, flag it.

**One gate specific to this plan.** Both tracks add *approximate* physics next to
code whose comments currently say "callers must refuse, not approximate"
([`displaciveModes.ts:15-22`](../src/core/crystal/displaciveModes.ts)). Every
phase below either keeps that refusal or replaces it with something exact — no
phase may quietly downgrade it to a silent approximation.

---

# Track A — PDF subgroup tree & supercells

## A0 · Current state — verified 2026-09-16, do not re-derive

**What exists and works.**

- **Mode-amplitude refinement, AMPLIMODES/ISODISTORT style**
  ([`distortionModes.ts`](../src/core/crystal/distortionModes.ts)): amplitudes
  are ordinary `positionShift` parameters whose one value drives *many* bindings
  (one per site, each with its own fractional `axis`) — the same multi-binding
  pattern as magnetic `momentMode`, so the engine, staged refinement,
  multi-start, worker pool, analytic Jacobian and UI grouping all work
  unchanged. Amplitude 1 = 1 Å whole-cell displacement norm over the **child**
  cell (AMPLIMODES normalises on the parent; the difference is documented).
- **Two ways in:** `buildDistortionModes(parent, child)` decomposes an observed
  distortion from a parent CIF, and `buildSymmetryModes(structure)` enumerates
  the structure's own symmetry-conserving modes. `withDistortionModes` splices
  either into any engine spec.
- **A translationengleiche subgroup lattice**
  ([`subgroupTree.ts`](../src/core/crystal/subgroupTree.ts)) with covering edges
  and conjugacy/domain grouping, reusing the magnetic subgroup enumerator (98
  subgroups for Pm-3m, golden-tested).
- **Γ isotropy-subgroup activation**
  ([`isotropyTree.ts`](../src/core/crystal/isotropyTree.ts),
  [`displaciveModes.ts`](../src/core/crystal/displaciveModes.ts)): character
  projector (so multidimensional irreps of non-abelian groups work), subgroup
  identification against the 230-group table, `realizeSubgroup`, and an
  activation kick because an inversion-odd amplitude of 0 is an exact stationary
  point a gradient method cannot leave.
- Real-data evidence: GaNb₄Se₈ at 5.8 K, F-43m → P2₁3, one mode amplitude
  beating the cubic average ([`realPdfData.test.ts`](../src/core/workflow/realPdfData.test.ts)).

**The four hard limits, all deliberate and documented in code.**

| Limit | Where it is stated |
|---|---|
| Γ (cell-preserving) modes only; zone-boundary needs **projective small representations** — "callers must refuse, not approximate" | `displaciveModes.ts:15-22`, `isotropyTree.ts:29-30`, `distortionModes.ts:385-388` |
| **Klassengleiche** (cell-multiplying) subgroups not enumerated — "the zone-boundary / supercell half of the full ITA1 tree" | `subgroupTree.ts:25-30` |
| Star labels come only from **lost half-integer centerings** (k ∈ {0,1}³, same cell); ⅓-type (rhombohedral) not handled | `distortionModes.ts:769-771, 288-293` |
| Origin-shifted subgroup settings not searched, so identification degrades to `point-group-only` (the UI says "approx.") | `isotropyTree.ts:226-227` |

**And the one that decides the whole track: the PDF forward model has no
supercell capability at all.** `pdf.ts` expands the asymmetric unit into **one
parent cell** (`expandStructureAtoms`) and enumerates pairs over periodic images
**on the parent lattice** (`pairEnumerator.ts:83-112`). `cellExpansion.ts` is
magnetic-only; the single PDF-side importer is `mpdf.ts`, and only for the spin
box. A user wanting a √2×√2×2 tilt system must build the supercell CIF
externally, and then the subgroup tree runs on the supercell's own group with no
relation to the parent irreps.

**Surface debts to fix while we are in here.**

- All subgroup/mode UI is **inline in `PdfWorkbench.tsx`** (~1819 lines); there
  is no component for it in `src/app/ui/`.
- MCP exposes `build_distortion_modes` and `build_symmetry_modes` only — the
  subgroup lattice and activation are UI-only, so an agent cannot drive them.
- [PDF_MPDF_ROADMAP.md](PDF_MPDF_ROADMAP.md) has **no distortion/subgroup
  section at all**; [ROADMAP.md](ROADMAP.md) lists the feature as shipped with no
  "Needed" entry. This plan is the missing backlog.
- Test gaps: no end-to-end subgroup-activation test against data; no project
  save→reopen round-trip that carries a stored `DistortionModeSet` (the schema
  validator covers it, no round-trip does).

## A1 · What "subgroup tree + supercell" has to mean for PDF

The target is the ISODISTORT workflow, run against G(r) instead of Bragg
intensities: **parent structure → k-point → irrep → isotropy subgroup → the
child cell that irrep implies → refine the mode amplitudes in that cell.**
Four capabilities, of which the app has the first in part:

1. **Modes at a k-point, not only Γ.** A Γ mode keeps the parent lattice; the
   distortions that matter for local structure — octahedral tilts, antipolar
   displacements, charge/orbital order — live at zone-boundary points (M, R, X,
   …) and multiply the cell. This is the mathematical core of the change.
2. **The child cell.** k fixes the child lattice: the smallest supercell in which
   the modulation is periodic. In general this is a **3×3 integer matrix**, not
   the axis-diagonal (n₁,n₂,n₃) the magnetic path assumes (an R-point tilt gives
   √2 × √2 × 2, whose transform is not diagonal).
3. **A displacement field over the supercell.** One amplitude must drive every
   symmetry-related atom in the child cell with the correct k-phase. This is the
   *same* algebra the magnetic side already runs for moments — polar vectors
   instead of axial ones, no time reversal — see `buildModulatedMomentModel` and
   `expandStructureToSupercell` in
   [`magneticSupercell.ts`](../src/core/magnetic/magneticSupercell.ts) and the
   k-phase expansion in [`cellExpansion.ts`](../src/core/crystal/cellExpansion.ts).
4. **A fit that stays affordable.** The PDF forward model costs pairs, and pairs
   scale with the square of the atom count: a 2×2×2 child cell is 8× the atoms
   and ~64× the pairs of the parent. A supercell feature that ignores this will
   hang the page, which is the same failure the 30 Å default window was added to
   avoid.

**Why this is the right feature for a PDF app specifically.** The average
(Bragg) structure and the local structure disagree exactly when a distortion is
correlated over a few unit cells but not long-range — the case where a
superstructure refined against G(r) at low r beats the parent while the parent
still wins at high r. The app already has the instrument for that comparison
(the boxcar / r-window sweep), so a supercell + mode parameterisation turns it
from a picture into a testable model: refine the same irrep amplitude in
successive r windows and watch it decay.

## A-I · A supercell the PDF model can actually compute  *(the keystone)*

Nothing else in this track is testable until a structure larger than the parent
cell can be evaluated against G(r). Build this first, independent of any
group theory:

1. `expandStructureToCell(structure, P, originShift)` in `src/core/crystal/` —
   a general **3×3 integer** supercell transform (the magnetic
   `expandStructureToSupercell` is axis-diagonal only and throws otherwise; an
   R-point tilt cell is not diagonal). The precedent to reuse is
   `buildCellAtoms`'s `standardRegion` fill in
   [`cellExpansion.ts`](../src/core/crystal/cellExpansion.ts), which already
   populates a general-P cell exactly by lattice translation.
2. A **cost model and a guard before a feature.** Pairs scale with the square of
   the atom count: a 2×2×2 child is 8× the atoms, ~64× the pairs. Benchmark
   `enumeratePairs` + `computeGofR` at 1×, 2×2×2 and √2×√2×2 for a real
   structure, publish the numbers in this document, and only then choose between
   (a) exploiting the child group's own symmetry in `expandStructureAtoms`,
   (b) capping r_max for supercell fits, (c) a parent-lattice pair list with
   per-image phase factors. Refuse (with a clear message) above the measured
   ceiling rather than hanging the page — the same discipline as the 30 Å
   default window.
3. **Gate:** a supercell built with zero distortion must give a G(r) that is
   byte-identical to the parent's, and its `positionShift` analytic Jacobian
   must pass the FD gate. This is the "the expansion changed nothing" test that
   makes every later phase trustworthy.

## A-II · Klassengleiche subgroups in the tree

1. Extend [`subgroupTree.ts`](../src/core/crystal/subgroupTree.ts) beyond
   rotation cosets to cell-multiplying (k-) subgroups, each node carrying its
   transformation `(P, p)` and index, so the tree becomes the full Bärnighausen
   lattice rather than its point-group half.
2. `realizeSubgroup` gains the cell-multiplying case, via A-I's expander.
3. UI: each node shows its child cell and transformation; "Activate" builds the
   child and re-parameterises. The existing activation kick and the
   `positionShiftValuesFor` carry-over apply unchanged.
4. **Gate:** index bookkeeping (|G| / |H| = index × cell multiplication) and a
   golden lattice for one non-symmorphic parent, in the style of the existing
   Pm-3m/Pnma goldens.

## A-III · Modes at a zone-boundary k

This is where the projective small representations sit. Take it in three steps,
each shippable, never approximating the group theory:

1. **Child-cell modes (no new group theory).** Once A-I and A-II can realise the
   child, run the existing `buildSymmetryModes` **in the child cell**. The user
   gets a symmetry-adapted basis and refinable amplitudes immediately. Label
   them honestly as *modes of the child*, not irrep-labelled parent modes.
2. **Authoritative labels by import.** Implement what `distortionModes.ts:37-39`
   already calls "Phase B (planned)": read ISODISTORT displacive-mode CIFs and
   attach the real irrep index and branch to the modes. This gives publishable
   labels (R4+, M3+, …) with no projective-rep engine, and makes the app
   interoperable with the tool crystallographers already use.
3. **Small representations in-core, with factor systems** (Bradley & Cracknell
   1972 Ch. 3-4), which is the only way to *generate* zone-boundary irreps for a
   non-symmorphic parent without an import. Large; schedule it only if step 2
   proves insufficient. Until it lands, the refusal in `displaciveModes.ts`
   stays exactly as it is.

## A-IV · The local-structure payoff  *(what this is all for)*

With a supercell + mode parameterisation, wire the feature to the page's own
instrument for local vs average structure: refine **the same irrep amplitude in
successive r-windows** through the existing boxcar sweep, and plot amplitude vs
r. A distortion that is local shows a decaying amplitude; one that is long-range
does not. This is the differentiator over refining a hand-built supercell CIF,
and it needs no new physics once A-I…A-III are in.

## A-V · Debts, in the same series

Extract the subgroup/mode UI out of `PdfWorkbench.tsx` into its own component;
expose the subgroup lattice and activation as MCP tools; add the missing project
round-trip test for a stored `DistortionModeSet`; add the end-to-end
activation-against-data test; and give the feature its section in
[PDF_MPDF_ROADMAP.md](PDF_MPDF_ROADMAP.md), which has none.

Adjacent, explicitly **not** in this track: ADP and strain symmetry modes
([LIMITATIONS.md](LIMITATIONS.md) already calls them future work).

## Sequencing — Track A

A-I → A-II → A-III(1) is the smallest path to a usable supercell subgroup
workflow. A-III(2) makes it publishable. A-IV is the reason to do it. A-III(3)
and A-V are independent.

---

# Track B — incommensurate magnetic refinement

> **Scope.** What it takes to go from "an incommensurate k refines its Fourier
> amplitudes" (shipped 2026-09-09) to a workflow that can actually carry an
> incommensurate study: refine k, say the truth in the exports and the viewer,
> handle the star of k and its domains, and — eventually — harmonics and
> superspace. Ordered so each phase is independently shippable and validated.

## B0 · Current state — verified 2026-09-16, do not re-derive

- **The formalism is done and gated.** A k whose ±k arms are distinct (¼-, ⅓-type
  or irrational) refines complex Fourier coefficients through the ordinary
  moment-mode machinery: `allowedFourierModes` (complex-linear stabilizer null
  space, incl. symmetry-forced helices), a cosine + a sine amplitude per mode
  (`MagneticMoment.sinComponents`, `ParameterBinding.momentPart`), one sine
  amplitude fixed as the modulation-phase gauge (`MagneticModelBuild.phaseGauge`),
  and S = ½(M^cos + i·M^sin) with S* on the −k arm
  ([`fourierMoment.ts`](../src/core/magnetic/fourierMoment.ts),
  [`propagation.ts`](../src/core/magnetic/propagation.ts)).
- **The gate is convention-free**: a brute-force real-space supercell oracle
  ([`fourierModulation.test.ts`](../src/core/magnetic/fourierModulation.test.ts))
  reproduces every satellite from a plain sum over the magnetic supercell. An
  irrational cell cannot be brute-forced, so the oracle runs a *long-period
  commensurate* k (3/10) on the identical code path; a helix is recovered through
  the powder workflow from a wrong start
  ([`fourierPowder.test.ts`](../src/core/workflow/fourierPowder.test.ts)).
- **No real incommensurate dataset has been refined.** The real-data magnetic
  golden (Eu₃In₂Te₄, `data/fullprof_int_handles/`) is k = (¼,0,¼) — two-arm but
  commensurate.
- **k is not a parameter.** It is read from `magnetic.propagation[0]` at seven
  call sites (structureFactor ×2, cellExpansion ×2, obsCalc, magneticPowder,
  export/cif) and never varies during a fit.
- **The powder peak builder already recomputes satellite POSITIONS** when a
  magnetic-geometry parameter changes: `createCombinedPeakBuilder` keys a cache on
  the d-range plus the values of every binding whose kind is in
  `MAGNETIC_GEOMETRY_KINDS`, then re-enumerates `magneticSatellites` and re-places
  the peaks ([`magneticPowder.ts:52,89`](../src/core/workflow/magneticPowder.ts)).
  Adding a k parameter kind to that set is the whole invalidation story.
- **`MagneticModel.domainPopulations` exists and is validated by the project
  codec, but no calculation reads it** — satellite multiplicities assume
  equal-population domains ([`satellites.ts`](../src/core/magnetic/satellites.ts)).
- **The candidate enumerator is translationengleiche only.** Type-IV
  (anti-translation) groups are explicitly the "star-of-k follow-up"
  ([MAGNETIC_SYMMETRY.md](MAGNETIC_SYMMETRY.md) Route A). The mCIF writer now
  *detects* a type-IV group from the expanded cell, but the page never *offers*
  one.
- **The k-search proposes rational candidates only** (`candidateKVectors`,
  denominators 2/3/4/6), so an incommensurate k must be typed in.
- **No finite supercell ⇒ the parent cell is shown and written.**
  `cellExpansion.magneticSupercell` returns (1,1,1) for an irrational component
  (and for any denominator > 12), so the 3D viewer draws one cell and the mCIF
  writes the parent cell with the cosine amplitudes in the moment loop and the
  sine amplitudes as comments.
- **The single-crystal supercell-merge path is commensurate and axis-diagonal
  only** — `magneticSupercell()` in
  [`magneticSupercell.ts`](../src/core/magnetic/magneticSupercell.ts) throws
  otherwise. The shared magnetic page's F² moment fit still works at any k.
- **The equal-|M| tie skips two-arm k** (complex amplitudes have no single size
  to constrain) — [`momentModel.ts`](../src/core/magnetic/momentModel.ts).

## B1 · Refine k  *(the highest value per unit of risk; powder first)*

**Why first.** Every incommensurate study starts by measuring k, and today the
app can only accept a typed value. The machinery to move it already exists.

1. New `ParameterKind` `"propagationK"` with a `ParameterBinding` carrying the
   component index (reuse `targetKey` = `"k1"|"k2"|"k3"`, `targetId` = the
   `<structure.id>-mag` model). Three rows, seeded from the current k, bounds
   ±0.5 with a per-cycle shift cap (a step larger than a peak width loses the
   minimum — the existing `limitShift` is relative, so k needs an absolute cap).
2. Resolve them where moments are resolved: `applyMagneticMoments` gains the
   propagation write-back (or a sibling `applyPropagation` called beside it), so
   every consumer that already calls it — powder builder, obs/calc, viewer,
   exports, report — sees the refined k with no further change.
3. Add `"propagationK"` to `MAGNETIC_GEOMETRY_KINDS` so the satellite cache
   invalidates and the peaks move.
4. Derivatives are finite-difference (k is non-linear). **Repo gate:** a new
   ParameterKind must pass the analytic-vs-FD comparison
   ([`analyticJacobian.test.ts`](../src/core/workflow/analyticJacobian.test.ts)).
5. Mode basis vs k: `allowedFourierModes` takes k, so in principle the basis is a
   function of the parameter. For a generic (incommensurate) k the stabilizer
   phases are generic and the basis is locally constant, so refining k against a
   **fixed** basis is correct; guard it — recompute the basis when k crosses a
   special value (any component within tolerance of a half-integer), and refuse
   to refine k when the current k IS special (a ½-type k that would leave its
   own symmetry).
6. UI: a "refine k" checkbox in step 2 of the magnetic page that adds the three
   rows to the parameter panel, and the refined k echoed in the k chip with its
   esd. MCP tool coverage in `src/mcp` alongside the existing magnetic tools.
7. **Single crystal is a separate sub-step.** The supercell-merge path bakes k
   into the index transform at merge time, so k cannot move there without
   re-merging. Ship powder first; for F² either re-derive satellite indices per
   evaluation in the shared page's fit or state that SC keeps k fixed.

**Validation.** (a) Synthetic: displace a known k by 0.02–0.05 r.l.u. and recover
it, esd sane. (b) Real: the AWO₄ 6 K set refines k = (½,0,0) back to ½ within its
esd (a self-conjugate k — also the guard case for step 5). (c) The Eu₃In₂Te₄
k = (¼,0,¼) golden refines to ¼.

## B2 · Tell the truth without a supercell  *(exports + viewer)*

1. **Superspace-style magCIF.** Replace "the sine amplitudes as comments" with the
   standard modulation loops — `_atom_site_moment_Fourier` /
   `_atom_site_moment_Fourier_param.{id,atom_site_label,axis,wave_vector_seq_id,cos,sin}`
   plus `_cell_wave_vector_*` — the form MAGNDATA uses for incommensurate
   entries and Jana2020 reads. This is a **bounded, high-value** change to
   [`export/cif.ts`](../src/core/export/cif.ts): the amplitudes already exist on
   the model; only the writer changes. Round-trip through the app's own parser is
   the test, plus a fixture from a published MAGNDATA incommensurate entry.
2. **Viewer.** Draw a labelled *approximant* — N cells along k (N chosen so N·k is
   integer within a tolerance, capped) — with the label saying it is an
   approximant, not a magnetic cell, instead of silently showing one parent cell.
   The expansion machinery already tiles cells and applies the k-phase
   (`expandMagneticBox`); only the N choice and the label are new.
3. The report's magnetic section states the propagation class (it already
   classifies) and, for an incommensurate k, that no magnetic cell exists.

## B3 · Star of k, domains, and type-IV candidates

1. Enumerate the arms of the star (the Laue orbit of k) — `satellites.ts` already
   computes the orbit for multiplicity; expose it as a domain list.
2. Make `domainPopulations` real: refinable populations (sum-to-one tie, which
   the constraint system now supports) weighting each arm's contribution, instead
   of the equal-population assumption baked into the multiplicity.
3. Offer type-IV (anti-translation) candidates in the enumerator for the
   commensurate k that admit them, so the page can propose the group the mCIF
   writer already knows how to name.

## B4 · Harmonics (squared-up modulations)

`MagneticMoment` carries one (cos, sin) pair. Squared-up structures need
m(n) = Σ_h [M^cos_h·cos(2πh k·n) + M^sin_h·sin(2πh k·n)], so:

1. The model gains an ordered list of Fourier components per site (h = 1…H),
   defaulting to H = 1 (today's behaviour, no migration for existing files).
2. `magneticSatellites` enumerates G ± h·k with the h-th coefficient; the
   structure factor sums per harmonic.
3. Parameter rows per harmonic, with H a user control (odd harmonics only for a
   symmetric square wave).
4. Validation: a synthetic square-wave modulation must be distinguishable from a
   sinusoid (the 3k satellites carry the signal), and H = 1 must reproduce
   today's numbers bit-for-bit.

## B5 · Full (3+1)D superspace  *(a milestone, not a phase)*

Superspace groups, modulation of positions and occupancies (not only moments),
and superspace-group symmetry constraints on the modulation functions. This is
Jana2020 territory and should be scoped as its own milestone after B1–B4; B2's
Fourier-loop mCIF is the interchange format that makes it optional for users who
just need to publish an incommensurate magnetic structure.

## Sequencing — Track B

B1 → B2 are independently useful and together make incommensurate work
publishable. B3 is the next physics gap. B4 and B5 are separate milestones.

---

## Cross-track note

The two tracks solve the same shape of problem twice — "a modulation with a
propagation vector, expanded into a cell, refined as symmetry-adapted
amplitudes" — and the magnetic side has already built most of that machinery
(k-phase expansion, multi-binding mode parameters, a subgroup lattice with
conjugacy classes, setting transformations). Track A should **reuse** it rather
than grow a parallel copy: `cellExpansion`'s general-P region fill, the
`momentMode`/`positionShift` multi-binding pattern, and `subgroupLattice`'s coset
machinery are all already shared or shareable. Where Track A generalises a piece
(a general 3×3 supercell transform, klassengleiche enumeration), Track B should
adopt the generalisation — B3's type-IV candidates and a non-axis-diagonal
magnetic supercell are the same mathematics.
