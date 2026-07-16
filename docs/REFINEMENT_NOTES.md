# Refinement Notes — Magnetic Powder Stability

Methods notes for the magnetic refinement engine, written to be usable as the
basis of a methods section. Companion to [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md)
(Phase 1 magnetic-powder stability, §1–§7; Phase 2 single-crystal joint
co-refinement, §8) and the local least-squares core in
[REFINEMENT_ENGINE.md](REFINEMENT_ENGINE.md).

Code: `src/core/refinement/engine.ts` (Levenberg–Marquardt), `src/core/refinement/multiStart.ts`
(seeded multi-start), `src/core/magnetic/canonicalize.ts` (equivalence + degeneracy),
`src/workers/computeClient.ts` (`refineMagneticPowderMultiStart`).

## 1. The local engine (unchanged, reused)

Refinement minimizes the weighted residual χ² = Σ wᵢ (y_iᵒᵇˢ − y_iᶜᵃˡᶜ)² by
Levenberg–Marquardt (Levenberg, *Quart. Appl. Math.* **2**, 164, 1944; Marquardt,
*SIAM J. Appl. Math.* **11**, 431, 1963). The implementation adds adaptive damping
(λ ×10 on a rejected step, ÷3 on an accepted one), diagonal (unit-diagonal)
preconditioning of the normal matrix before each solve, an SVD-style pseudo-inverse
that truncates near-null singular directions for the covariance/e.s.d. estimate,
and box bounds by projection. It already reports a condition number, the strongest
parameter correlations, the parameters dominating dropped singular directions, and
any parameter resting on a bound. Phase 1 reuses this engine unchanged; the magnetic
work is entirely in **parametrization, starting-point strategy, and equivalence
handling** layered on top.

## 2. Magnetic parametrization (pre-existing, not modified)

Moments are refined as amplitudes of **symmetry-adapted basis modes**, not raw
Cartesian components. For each magnetic site the allowed moment directions are the
null space of the site's magnetic (Shubnikov) stabilizer, k-phase-aware for a
propagation vector k; symmetry-forbidden components never enter the parameter set
(`src/core/magnetic/allowedMoments.ts`, `momentModel.ts`). Each mode is normalized
to unit Cartesian length, so one unit of amplitude is 1 µ_B along that mode
regardless of the cell metric. This is the representation-analysis parametrization
(Bertaut, *Acta Cryst. A* **24**, 217, 1968) and is the correct search space:
it is minimal and contains only physically allowed structures. Per-mode amplitudes
are bounded to ±12 µ_B (above any real ion; Eu²⁺ ≈ 7 µ_B).

## 3. Diagnosis (Phase 1a)

We characterized the reported instability on the Mn₃Ga 350 K POWGEN data
(`data/Mn3Ga_POWGEN_350K`, BNS group C m′c m′, moment modes: 2 on Mn1_0, 1 on
Mn1_1) by running **24 seeded random starting moment configurations** and recording,
per run, the final χ², the converged moments, and the engine's condition number,
correlation matrix, damping history, and at-bound flags. Reproduce with:

```
npm run test:mag-diagnostic     # src/core/workflow/mn3ga350KDiagnostic.test.ts
```

**Findings.** The dominant failure mode is **(a) ill-conditioning — a near-flat
"sublattice-partition" valley — compounded by (c) the global time-reversal
degeneracy. There is no evidence of (b) genuinely distinct deep minima.**

- 23 of 24 starts land within **0.9 %** of the best χ² (7.88×10⁴ – 7.96×10⁴). They
  sit on one flat valley floor, not in separated basins.
- Despite near-identical χ², the moments spread along a continuous ridge:
  |m(Mn1_0)| ≈ 1.1 → 2.2 µ_B, anticorrelated with |m(Mn1_1)| ≈ 1.5 → 3.0 µ_B.
  Several runs report the coupling directly: ρ(mom_Mn1_0, mom_Mn1_1) ≈ −0.99. This
  is the physics the data carries — the crystal-b direction is poorly determined by
  this pattern (the two published GSAS-II states, mCIF and final .lst, themselves
  differ along it by more than our run-to-run scatter).
- The single high-χ² outlier (+18 %) was a **nuclear** TOF peak-shape divergence
  (ρ(tof_β1, tof_βQ) = −1.00, λ → 59, three parameters railed to bounds), triggered
  by leaving the TOF profile free during the moment search — not a magnetic minimum.
- Condition numbers were moderate (7×10² – 3×10³): the problem is not catastrophically
  singular, but the −0.99 moment correlation is a genuine soft (near-null) direction.

The instability the user observed ("different minima depending on the starting moment
configuration") is therefore **one flat valley plus a sign degeneracy**, not a rugged
landscape. The fix follows the diagnosis.

## 4. Mechanism (Phase 1b)

`ComputeClient.refineMagneticPowderMultiStart` implements, cheapest-sufficient first:

1. **Freeze the nuclear scaffold, search only the moment subspace.** The existing
   seeded multi-start (`refineMultiStart`, mulberry32 RNG) is extended with a
   `shouldPerturb` predicate so restarts kick only the moment modes; the nuclear
   parameters are held fixed during the search. This removes the run-7 profile
   divergence outright and makes the moment-only correlation structure clean.
2. **Best-of-N, then one joint LM.** After the moment-subspace search, the best
   moment partition is seeded into a single joint Levenberg–Marquardt over the
   caller's full freed set. E.s.d.s and correlations are taken from that final step
   only, so they describe the reported solution.
3. **Canonicalize the global sign** and **report the flat directions** (§5).

The seed is exposed and threaded through the RNG, so any run is reproducible: the
same seed yields a bit-identical trajectory and identical converged parameters
(asserted in `src/workers/magneticMultiStart.test.ts` and the Mn₃Ga acceptance test).

**Global-search layer (basin hopping / simulated annealing) is intentionally NOT
added.** The plan gates it on the diagnosis showing best-of-N insufficient — i.e.
persistent *distinct* basins after canonicalization. Phase 1a found none (23/24
starts at the same χ²), so adding a Metropolis accept/reject layer (Wales & Doye,
*J. Phys. Chem. A* **101**, 5111, 1997; Kirkpatrick, Gelatt & Vecchi, *Science*
**220**, 671, 1983; FullProf's simulated-annealing mode, Rodríguez-Carvajal,
*Physica B* **192**, 55, 1993) would add cost and stochasticity without addressing
the actual (flat-valley) failure mode. The `shouldPerturb` hook and the seeded RNG
are the seams through which such a layer would attach if a future magnetic problem
is shown to need it.

## 5. Equivalence and degeneracy (Phase 1a deliverable for mode (c))

Two solutions that a naive comparison would call "different minima" are handled as
what they are — symmetry/data facts, not solver noise (`canonicalize.ts`):

- **Global time reversal.** For an unpolarized powder, flipping every moment m → −m
  leaves |F_M(G±k)|² unchanged, so ±m are the *same* structure. `globalMomentSign`
  chooses a deterministic, basis-independent representative: it orders the moment
  entries by binding key and picks the sign that makes the first significant
  Cartesian component (x, then y, then z) of the first significant moment positive.
  `canonicalizeMomentValues` applies that sign to the momentMode amplitudes (moments
  are linear in the amplitudes), leaving nuclear parameters untouched. The operation
  is idempotent, so re-canonicalizing is a no-op.
- **Data-limited (flat) directions.** `momentDegeneracies` reads the engine's SVD /
  correlation diagnostics and surfaces, for the user, (i) any moment mode dominating
  a dropped near-null singular direction — its e.s.d. is unreliable — and (ii) any
  |ρ| ≥ 0.9 correlation involving a moment parameter — the sublattice-partition soft
  mode, or a moment↔scale/ADP coupling. This is a threshold-driven, best-effort
  surfacing: it fires when the converged covariance actually shows the degeneracy, so
  a well-determined refinement reports nothing and a flat one reports the specific
  parameters the data cannot separate. It is the honest deliverable for the flat
  valley: the moment *topology* is determined; the *partition* along the reported
  direction is data-limited.

## 6. Acceptance (Phase 1c)

- **CI-runnable** (`src/workers/magneticMultiStart.test.ts`, synthetic AFM,
  k = (0,0,½)): recovers the true moment from a bad cold start; deterministic under a
  fixed seed; canonicalizes a negative start onto the positive representative; and
  the fit range is threaded through the multi-start's problem-builder seam
  (regression for a previously dropped magnetic fit-range window).
- **Data-gated acceptance** (`src/workers/magneticMultiStartGolden.test.ts`, real
  Mn₃Ga 350 K): from ≥20 seeded starts, ≥95 % share the best χ² (observed 21/21) and
  the run recovers the golden topology (|m0| ≈ 2.06 µ_B along a, |m1| ≈ 1.70 µ_B along
  b, both z-forbidden), consistent with the GSAS-II mCIF/.lst within the data-limited
  b-axis spread; identical results under a repeated seed.
- **No regression:** the full existing test suite (including the nuclear powder
  multi-start) passes; `npm run typecheck` is clean.

## 7. UI

The "Prefit ↻ / Escape min ↻" control (previously nuclear/multi-phase only) now
drives the magnetic path too: Prefit casts a wide moment-subspace net (more
restarts) from a cold start, Escape is a light nudge around a converged fit. The
result message reports the best-of-N outcome and, when present, the leading
data-limited direction from the degeneracy report.

## 8. Single-crystal joint nuclear + magnetic co-refinement (Phase 2)

Code: `src/core/workflow/jointSingleCrystal.ts` (joint problem + per-block
agreement), `src/workers/protocol.ts` / `runPowder.ts` (`jointSingleCrystal`
evaluator spec), `src/workers/computeClient.ts`
(`refineJointSingleCrystalParallel`, `refineJointSingleCrystalMultiStart`),
`src/mcp/tools.ts` (`parse_single_crystal_data`, `refine_joint_single_crystal`),
`src/app/SingleCrystalWorkbench.tsx` (UI). Tests:
`src/core/workflow/jointSingleCrystal.test.ts`, `src/workers/jointMultiStart.test.ts`.

**Objective.** Two integrated-intensity datasets — a nuclear `.int` and a magnetic
`.int` — are fit against one structure + magnetic model with

  χ²_total = w_N · χ²_N + w_M · χ²_M .

The Levenberg–Marquardt core (§1) minimises Σ w(obs−calc)² over one flat
observations/weights vector, so the joint problem is assembled by *concatenating*
the two blocks (nuclear rows first, then magnetic) and folding the user weights
w_N, w_M onto the per-block statistical weights 1/σ²(Fo²). No engine change — the
block scalars realise the weighted sum exactly. This is the single-crystal
counterpart of FullProf's multi-pattern weighted co-refinement (Rodríguez-Carvajal
1993).

**Block forward models** (unpolarized neutrons ⇒ no nuclear–magnetic interference,
as in the single-dataset path, §2):

  nuclear:   I = k_N · L(θ) · P(θ) · y_ext · |F_N|²
  magnetic:  I = k_M · L(θ) · P(θ) ·          |F_M⊥|²

L = 1/sin2θ is the purely geometric single-crystal Lorentz factor (identical for
nuclear and magnetic scattering at the same 2θ; 1 for TOF) and P = 1 for neutrons.
Both blocks are computed from ONE `applyParameters` pass, so freed positions/ADP/
cell propagate into |F_M⊥|² (the Halpern–Johnson M⊥Q projection with the ⟨j0⟩ form
factor and shared Debye–Waller damping, §2). Extinction is nuclear-only (magnetic
Bragg intensities are weak; the correction is negligible) — the `jointSingleCrystal`
block-assembly is the plug-in point for a magnetic extinction or a twin/domain-
fraction correction, both out of scope for Phase 2.

**Lorentz toggle.** A named `lorentz` option (default on) applies L·P to *both*
blocks. FullProf DataRed-style `.int` files can hold already-Lorentz-corrected F²;
setting `lorentz: false` avoids double-correcting them. The convention the input
file is at (raw I vs corrected F²) is the user's to declare — it is unvalidated
against a real FullProf `.int` here (the Eu324 goldens are absent, below).

**Setting.** The model lives in one setting; each dataset carries an optional
integer 3×3 `HklTransform` mapping its file indices into that setting
([h′,k′,l′] = M·[h,k,l]). This is what makes a base-cell nuclear file co-refinable
with a magnetic-**supercell** file: describe the model in the supercell and give the
nuclear file the (integer) base→supercell map. The precondition on the magnetic
block is a *purely magnetic* supercell (no nuclear superstructure), so supercell-
only reflections carry only magnetic intensity.

**Scale.** k_N (kind `scale`) and k_M (kind `magneticScale`, minted by the joint
caller — the nuclear spec builder never produces it) are independent by default,
routed by parameter *kind* (not dataset id). Operationally the two files come from
separate integrations/normalisations. Two crystallographic caveats:

  1. *Setting factor.* For a supercell of n base-cell copies a fundamental
     reflection has all n motifs in phase, so F_super = n·F_base and
     |F_super|² = n²|F_base|²: a scale shared across the base and supercell settings
     is off by n². Independent scales absorb this; a shared scale is only correct
     when both files are in one setting and one normalisation (tie k_M = k_N).
  2. *Degeneracy.* The magnetic intensity ∝ k_M·|F_M⊥|² ∝ k_M·m², so a free k_M and
     a free moment magnitude m are perfectly correlated. The standard resolution
     (one crystal / one beam ⇒ k_M = k_N) lets the nuclear block pin the scale and
     the magnetic block pin the moment; this is the UI default ("separate magnetic
     scale" off).

**Weights and e.s.d.s.** The e.s.d.s are GoF-scaled (covariance = normalised
(JᵀWJ)⁻¹ · χ²/dof, §1). An *overall* rescale w_N = w_M = α therefore cancels
exactly and leaves the e.s.d.s and the solution unchanged; only the *ratio*
w_N/w_M alters them. Per-block R-factors (R1/wR2/GooF for each block) are computed
outside the engine — `jointSingleCrystalComparison` slices the two blocks — because
the engine reports a single combined GoF over the stacked residual. When a block
lacks σ, `weightsFromSigma` falls back to unit weight, making that block's weight
incommensurate with a σ-weighted block; the UI/MCP *surface* the per-block σ
coverage rather than silently renormalising (which would corrupt the good block's
statistics).

**Optimizer.** The Phase-1 stack is reused unchanged: freeze the nuclear scaffold,
search the moment subspace from the seeded multi-start (`shouldPerturb` = the
`momentMode` predicate), seed the best partition into ONE joint LM over the full
freed set, canonicalize the global ±m sign, and report the data-limited moment
directions (§4–§5).

**Acceptance.** The synthetic golden (`jointMultiStart.test.ts`) generates both
reflection sets from a known model+moment and recovers the moment and the shared
scale from a bad cold start, deterministically (same seed ⇒ identical parameters
and per-start costs) — the CI-runnable optimizer proxy, as in Phase 1c. The
per-reflection magnetic-block value is checked against a hand-assembled
k_M·L·P·|F_M⊥|², and a cross-consistency test pins the `lorentz:false` block to the
legacy single-dataset `magneticComparison`. **Pending external data:** the real
`data/Eu324_fullprof/Str/` `*_nuc.int` + `*_mag.int` acceptance (nuclear-only /
magnetic-only / joint, consistent within combined e.s.d.) is not present on this
machine — the folder, its structure CIF, and the k-vector/magnetic space group are
absent, so this code path is marked pending-external-validation (as the Phase-3
plan does for the k-vector file). No regression: the full existing suite and
`npm run typecheck` are clean.

**UI.** The single-crystal workbench pairs a companion magnetic file ("Load
magnetic .int…") and, once a magnetic model is applied, shows a joint panel with
named w_N, w_M, restart-count, and seed controls, a shared/independent magnetic-
scale toggle, per-block R-factors, the σ-coverage warning, and the degeneracy
report. The `refine_joint_single_crystal` MCP tool exposes the same capability
headless.

## References

- Levenberg, K. *Quart. Appl. Math.* **2**, 164 (1944).
- Marquardt, D. W. *SIAM J. Appl. Math.* **11**, 431 (1963).
- Bertaut, E. F. *Acta Cryst. A* **24**, 217 (1968) — representation analysis of magnetic structures.
- Halpern, O. & Johnson, M. H. *Phys. Rev.* **55**, 898 (1939) — magnetic interaction vector (M⊥Q).
- Wales, D. J. & Doye, J. P. K. *J. Phys. Chem. A* **101**, 5111 (1997) — basin hopping.
- Kirkpatrick, S., Gelatt, C. D. & Vecchi, M. P. *Science* **220**, 671 (1983) — simulated annealing.
- Rodríguez-Carvajal, J. *Physica B* **192**, 55 (1993) — FullProf; multi-pattern co-refinement and simulated-annealing magnetic structure determination.
