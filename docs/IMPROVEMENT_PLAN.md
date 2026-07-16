# Improvement Plan — Magnetic Refinement Stability + Single-Crystal Co-Refinement

> **Status:** Phases 1–3 implemented (2026-07-16). Phase 2 was built as the
> physically-correct **single-file supercell merge** (nuclear + magnetic peaks are
> one measurement → ONE scale), NOT the two-file weighted objective the plan body
> below describes (§111): the domain requirement is that there is no relative scale
> to tune between nuclear and magnetic Bragg peaks. The reflection merge is
> validated byte-exactly against the real `data/fullprof_int_handles/` Eu₃In₂Te₄
> golden (k = (¼,0,¼)); see [REFINEMENT_NOTES.md](REFINEMENT_NOTES.md) §8. Remaining
> **pending external validation**: the Phase-3 `.int` **k-vector header** path (no
> golden exercises it — real files use the merge; see [SINGLE_CRYSTAL.md](SINGLE_CRYSTAL.md) §2).
> This is a focused improvement milestone, **separate from [ROADMAP.md](ROADMAP.md)** —
> it hardens what exists before the next roadmap milestone. Do not fold these items
> into the roadmap tracks.

MATERIA is a browser-based diffraction refinement app: TypeScript + React + Vite;
pure numeric core in `src/core` (no UI imports); worker-pooled evaluators in
`src/workers`; MCP agent tools in `src/mcp`.

## Current state — verified 2026-07-16, do not re-derive or rebuild

- LM engine (`src/core/refinement/engine.ts`): adaptive Marquardt damping, diagonal
  preconditioning, SVD truncation with logged dropped directions, condition-number
  diagnostics, parameter bounds with at-bound reporting. Reuse it.
- Seeded multi-start (`src/core/refinement/multiStart.ts`): mulberry32 RNG, esd-scaled
  perturbation, best-of-N. UI-wired as "Prefit ↻ / Escape min ↻" — but ONLY for the
  nuclear powder path (`refinePowderMultiStart` in `src/workers/computeClient.ts`).
  The magnetic powder path (`refineMagneticPowderParallel`) has no multi-start. **GAP #1.**
- Moments are already refined as symmetry-adapted mode amplitudes (null space of the
  site's magnetic stabilizer, k-phase-aware, unit-Cartesian-normalized):
  `src/core/magnetic/momentModel.ts`, `allowedMoments.ts`. Never bypass this with raw
  Mx/My/Mz or spherical coordinates.
- Magnetic structure factor validated per-reflection vs GSAS-II (Mn3Ga 350K).
  ⟨j0⟩ + dipole ⟨j2⟩ form factors implemented (`src/core/scattering/magnetic.ts`).
- Single-crystal magnetic refinement exists (`refineMagneticParallel`,
  `magneticSingleCrystal` evaluator, `src/core/workflow/magnetic.ts`) — single dataset
  only; no joint nuclear+magnetic two-file objective. **GAP #2.**
- FullProf `.int` reader exists (`src/parsers/fullprofInt.ts`), Fortran-format-aware,
  tested. No propagation-vector header support, no writer. **GAP #3.**
- Datasets: `data/Mn3Ga_POWGEN_350K` (published magnetic structure, GSAS-II-validated),
  `data/GaNb4Se8_XRD`, `data/Eu324_fullprof/Str/` (single-crystal goldens:
  `*_nuc*.int` + `*_mag*.int` pairs, plus `gaussian_nuc/mag.int`, `analytical_nuc.int`).
  NOTE: the magnetic goldens index in the magnetic SUPERCELL (integer hkl, no k-vector
  header lines) — they do not exercise the propagation-vector file variant.

## Repo gates (apply to every phase)

- `npm run typecheck` and `npm test` must pass (bare `npx tsc` checks nothing).
- Tests reading `data/` must gate on `existsSync` (data/ is git-ignored; CI deploy runs
  the suite). Commit small format fixtures under `src/testSupport` instead where possible.
- Any new ParameterKind must pass the analytic-vs-FD derivative gate.
- Changes touching workers must be verified against the production build
  (`npm run build` + preview), not just dev — Vite worker inlining has bitten before.
- Same seed ⇒ bit-identical trajectory (existing repo convention).
- Surface every new user-facing knob (weights, seed, restart count) as a named, visible
  control — GSAS-II-parity style. New capabilities also get MCP tool coverage in
  `src/mcp` where they fit the existing tool registry.
- One phase per PR/commit series; numeric code gets unit tests against analytic cases;
  citations in code comments at the point of implementation and in
  `docs/REFINEMENT_NOTES.md` (written as a usable methods-section basis).
- If code contradicts anything here, flag it — don't silently work around it.

## Phase 1 — Stabilize powder magnetic refinement

**1a. Diagnose first — report findings before any fix; the fix must match the diagnosis.**
On `data/Mn3Ga_POWGEN_350K`: from ≥20 seeded random starting moment configurations, run
the current magnetic refine and record per-run: final χ², moment solution, per-iteration
λ / rejected steps / shifts-vs-esd, condition number and correlation matrix at
termination (extend the existing engine diagnostics rather than new instrumentation).
Classify every distinct terminal state as one of:

  - (a) ill-conditioning / strong correlation (moment ↔ scale ↔ ADP ↔ background);
  - (b) genuinely distinct local minima in mode-amplitude space;
  - (c) SYMMETRY-EQUIVALENT solutions — ±m (time-reversal domain), powder-undetermined
    global spin direction, other domain degeneracies. These are physics, not
    instability: the deliverable for (c) is canonicalization (map solutions to a
    canonical representative before comparing) plus a user-visible degeneracy report,
    building on the existing site-symmetry/DOF diagnostics.

**1b. Fix per diagnosis — cheapest sufficient mechanism first.**

- First: extend the existing seeded multi-start to the `magneticPowder` evaluator spec
  (a `refineMagneticPowderMultiStart` sibling in computeClient), with perturbation
  restricted to (or strongly weighted toward) the moment-mode subspace; nuclear
  parameters frozen or heavily damped during restarts; one final joint LM on all
  parameters, with e.s.d.s and correlations reported from that final step only.
  Wire it to the existing Prefit/Escape-min UI affordance and thread the fit-range
  window through (it has been dropped on magnetic paths before — add a regression test).
- Only if the diagnosis shows best-of-N multi-start insufficient (persistent distinct
  basins after canonicalization): add a Metropolis accept/reject layer (basin hopping,
  Wales & Doye, J. Phys. Chem. A 101, 5111, 1997) or simulated annealing over the
  magnetic subspace (FullProf precedent: Rodríguez-Carvajal, Physica B 192, 55, 1993),
  reusing the same seeded RNG.
- Moment-mode amplitude bounds: |amplitude| ≤ 10 µB (above any real ion; Eu²⁺ = 7 µB),
  via the engine's existing bounds support.

**1c. Acceptance (gate to Phase 2).**

- Synthetic: pattern generated from the converged Mn3Ga 350K model (forward model is
  already GSAS-II-validated, so self-generation tests the optimizer, not the physics).
  ≥20 seeded random starts: ≥95% reach ground-truth χ² within 1% and the canonical
  moment topology (after 1a canonicalization).
- Real: Mn3Ga 350K refines to the published/GSAS-II moments within combined e.s.d.
- Determinism: same seed ⇒ identical result (bit-identical where the convention applies).
- No regression: full existing test suite passes, including nuclear powder multi-start.
- `docs/REFINEMENT_NOTES.md` documents the diagnosis, the chosen mechanism, and the
  degeneracy/canonicalization rules, with citations.

## Phase 2 — Single-crystal joint nuclear + magnetic co-refinement

- Reuse the Phase-1 optimizer stack on integrated intensities F²(hkl); the magnetic
  interaction vector (Halpern–Johnson, M⊥Q) and ⟨j0⟩/⟨j2⟩ form factors already exist —
  extend, don't rewrite.
- New joint objective: χ²_total = w_N·χ²_N + w_M·χ²_M over TWO datasets loaded into one
  session (nuclear .int + magnetic .int — the existing reader already parses both golden
  files). User-controlled weights, FullProf multi-pattern style. Decide shared vs.
  independent scale factors and justify in REFINEMENT_NOTES (note: `_mag` goldens are in
  the supercell setting — state explicitly how scale relates across the two settings).
- Out of scope unless stated otherwise: secondary extinction, twin/domain fractions —
  flag where they'd plug in.
- Acceptance: `data/Eu324_fullprof/Str/` nuclear-only, magnetic-only, and joint runs;
  joint result consistent with the published structure within e.s.d.; weights and both
  R-factors surfaced as named UI values; existing single-crystal tests pass.

## Phase 3 — Full FullProf `.int` reader/writer + pairing convention

- Extend `src/parsers/fullprofInt.ts`: propagation-vector header variant (k-vector count
  + components; per-reflection k index so satellites are indexed as integer (hkl) ± k,
  as consumed by FullProf/Mag2Pol). Add a writer producing files FullProf itself accepts
  (Irf/Int integrated-intensity mode) — individually valid, so users can cross-check.
- Do NOT trust training-data memory of the format. Validate widths/headers against the
  golden files and the FullProf manual. Round-trip: parse golden → re-serialize →
  semantically identical, byte-identical where fixed-width. Where goldens are ambiguous,
  list the ambiguity and ask — do not guess.
- KNOWN HOLE: no golden exercises the k-vector header. Implement from the manual, then
  export one k-vector file for manual validation in FullProf; mark that code path as
  pending-external-validation until confirmed.
- Pairing convention: `<name>_nuc.int` + `<name>_mag.int` (matches the existing Eu324
  naming) loaded as one co-refinement session feeding the Phase-2 objective. Reject
  malformed files with line number + expected-vs-found.
- Acceptance: round-trips pass on all Str/ goldens; a nuc+mag pair reproduces the
  Phase-2 joint result; malformed-file tests; export wired into the existing Export menu.
