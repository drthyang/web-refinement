# Refinement Notes — Magnetic Powder Stability

Methods notes for the magnetic refinement engine, written to be usable as the
basis of a methods section. Companion to [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md)
(Phase 1 magnetic-powder stability, §1–§7; single-crystal magnetic refinement via
the single-k supercell merge, §8) and the local least-squares core in
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

## 8. Single-crystal magnetic refinement — the single-k supercell merge

Code: `src/core/magnetic/magneticSupercell.ts` (supercell + nuclear/magnetic
merge), `src/core/workflow/magnetic.ts` (`buildMagneticSingleCrystalProblem`,
the single-dataset nuclear+magnetic forward model), `src/workers/computeClient.ts`
(`refineMagneticSingleCrystalMultiStart`), `src/mcp/tools.ts`
(`parse_single_crystal_data`, `write_single_crystal_data`,
`merge_magnetic_supercell`), `src/app/SingleCrystalWorkbench.tsx` (UI). Tests:
`src/core/magnetic/magneticSupercell.test.ts`,
`src/workers/magneticSupercellRefine.test.ts`, `src/parsers/fullprofInt.test.ts`.

**The convention.** A commensurate single-k magnetic structure is refined from a
single FullProf `.int` in the magnetic **supercell**, produced by merging two
nuclear-cell files:

  - `<name>_nuc.int` — nuclear Bragg reflections, indexed in the atomic cell.
  - `<name>_mag.int` — magnetic satellites, ALSO in the atomic cell: each `h k l`
    is the fundamental of a satellite at `hkl + k`.

For an axis-diagonal commensurate k = (p₁/n₁, p₂/n₂, p₃/n₃) the supercell is
(n₁a, n₂b, n₃c), where k becomes an integer reciprocal-lattice vector K = (nᵢ·kᵢ),
and the componentwise reflection transforms are

  nuclear   (h,k,l) → (n₁h, n₂k, n₃l)
  magnetic  (h,k,l) → (n₁h + K₁, n₂k + K₂, n₃l + K₃).

`mergeToMagneticSupercell` applies these and concatenates the two into one dataset.
In the supercell the nuclear reflections land on nodes that are multiples of nᵢ and
the satellites at the integer K offset, so nuclear |F_N|² and magnetic |F_M⊥|² are
each non-zero only on their own reflection class (the physical basis for one
combined dataset). Validated **byte-exactly** against the Eu₃In₂Te₄ HB-3A golden
(k = (¼,0,¼); `magneticSupercell.test.ts`): the reader parses `_nuc`/`_mag`/`_ALL`
with zero problems, and the merge reproduces the reference `_ALL_magcell.int` on
every `(h,k,l,I,σ)`.

**One scale — not a relative weighting.** Nuclear and magnetic Bragg peaks are the
**same measurement** (one crystal, one beam, one normalisation), so they share a
single overall scale k:

  I(hkl) = k · [ |F_N(hkl)|² + |F_M⊥(hkl)|² ]     (unpolarized ⇒ no interference).

There is no physical relative-scale parameter to tune between nuclear and magnetic
reflections. In `buildMagneticSingleCrystalProblem` this is enforced by tying the
magnetic scale to the nuclear scale (`magneticScale = scale`): without it the
magnetic block would use the default k_M = 1 while the nuclear block refines to k,
and the moments would come out wrong by √k. Tying also pins the moment magnitude
uniquely (no k_M·m² degeneracy). |F_M⊥|² is the Halpern–Johnson M⊥Q projection with
the ⟨j0⟩ form factor and the 2.695 fm/µ_B prefactor (§2), on the same fm scale as
the nuclear scattering length, so a single k is dimensionally correct.

**Setting for refinement.** The merged reflections are in the supercell, so the
**structure must be described in the supercell** (as FullProf's `.pcr` does) — a
nuclear-cell structure would score the satellites against a spurious nuclear |F|².
MATERIA provides the merge and the refinement; the supercell structure is the
user's model input.

**Optimizer.** `refineMagneticSingleCrystalMultiStart` is the single-dataset
sibling of the powder/joint escape-min paths (§4): freeze the nuclear scaffold,
search the moment subspace from a seeded multi-start (`shouldPerturb` = the
`momentMode` predicate), seed the best partition into one final LM over the full
freed set (the caller's options threaded through), canonicalize the global ±m sign,
and report the data-limited moment directions (§5).

**Acceptance.** The reflection merge is validated byte-exactly against the real
golden (above). The refinement is validated on a synthetic AFM supercell
(`magneticSupercellRefine.test.ts`): a cell doubled along a with antiparallel
moments where even-h reflections are purely nuclear and odd-h purely magnetic (like
a merged file), recovering the moments and the shared scale from a bad cold start,
deterministically (same seed ⇒ identical parameters and per-start costs). The
FullProf `.int` reader/writer round-trips (`fullprofInt.test.ts`) cover the plain
and propagation-vector variants. No regression: the full existing suite and
`npm run typecheck` are clean.

**Not modelled** (deliberately): a *tunable relative scale/weight* between nuclear
and magnetic reflections — physically unmotivated for one measurement, so the
single-crystal path exposes only the one-scale merged workflow. The FullProf `.int`
k-vector **header** variant (an in-file k block instead of the supercell merge)
stays pending external validation — real files use the merge; see
`docs/SINGLE_CRYSTAL.md` §2.

## References

- Levenberg, K. *Quart. Appl. Math.* **2**, 164 (1944).
- Marquardt, D. W. *SIAM J. Appl. Math.* **11**, 431 (1963).
- Bertaut, E. F. *Acta Cryst. A* **24**, 217 (1968) — representation analysis of magnetic structures.
- Halpern, O. & Johnson, M. H. *Phys. Rev.* **55**, 898 (1939) — magnetic interaction vector (M⊥Q).
- Wales, D. J. & Doye, J. P. K. *J. Phys. Chem. A* **101**, 5111 (1997) — basin hopping.
- Kirkpatrick, S., Gelatt, C. D. & Vecchi, M. P. *Science* **220**, 671 (1983) — simulated annealing.
- Rodríguez-Carvajal, J. *Physica B* **192**, 55 (1993) — FullProf; multi-pattern co-refinement and simulated-annealing magnetic structure determination.
