# Refinement Notes — Magnetic Powder Stability

Methods notes for the magnetic-powder refinement engine, written to be usable as
the basis of a methods section. Companion to [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md)
(Phase 1) and the local least-squares core in [REFINEMENT_ENGINE.md](REFINEMENT_ENGINE.md).

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

## References

- Levenberg, K. *Quart. Appl. Math.* **2**, 164 (1944).
- Marquardt, D. W. *SIAM J. Appl. Math.* **11**, 431 (1963).
- Bertaut, E. F. *Acta Cryst. A* **24**, 217 (1968) — representation analysis of magnetic structures.
- Wales, D. J. & Doye, J. P. K. *J. Phys. Chem. A* **101**, 5111 (1997) — basin hopping.
- Kirkpatrick, S., Gelatt, C. D. & Vecchi, M. P. *Science* **220**, 671 (1983) — simulated annealing.
- Rodríguez-Carvajal, J. *Physica B* **192**, 55 (1993) — FullProf; simulated-annealing magnetic structure determination.
