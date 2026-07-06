# Roadmap

Phased build. Each phase ends with **passing tests, updated docs, a working local
app, and no broken intermediate state**. Later phases do not start until earlier
ones are stable. Atomic/nuclear refinement comes before magnetic; single crystal
before powder within each.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

## Phase 0 — Architecture & type drafts ✅
- Layered architecture, source tree, conventions documented.
- TypeScript interface drafts for all core models (`src/core/**/types.ts`).
- Project scaffold: Vite + React + TS (strict) + Vitest; `dev`/`build`/`test` work.
- Round-trip test for `ProjectFile`.
- **Deliverables:** the six `docs/*.md` + interface drafts. No calculation engine.

## Phase 1 — Atomic/nuclear refinement core ✅
Minimal, correct, testable. Cell, sites, occupancies, B_iso, symmetry ops,
reflection data, scale, (powder) background, parameter table with fixed/free +
bounds, refinement history. Not full GSAS-II.

## Phase 2 — Data models for single crystal & powder ✅
Finalize both observation models behind one engine (types exist from Phase 0;
this phase wires the shared residual/weight machinery and parsers).

## Phase 3 — Single-crystal atomic refinement ✅
Load CIF + hkl; compute `F_N`, `|F|²`, `I_calc`; refine scale (± coords,
occupancies); R and weighted R; obs-vs-calc plot; export reflection table +
project JSON. Simplified structure-factor equation; modular scattering table.

## Phase 4 — Powder atomic refinement ✅
Allowed reflections → nuclear intensities → profile (Gaussian, then
pseudo-Voigt) + background (constant, then polynomial). Refine scale, background,
lattice, peak width. Obs/calc/difference plot; export pattern + project. Minimal
profile refinement, not full Rietveld.

## Phase 5 — Magnetic structure model ✅
Moments on sites, propagation vector k, magnetic form-factor interface,
perpendicular-moment rule `M⊥ = M − q̂(M·q̂)`, simplified `F_M`, arrow
visualization. Nuclear/magnetic contributions kept separate.

## Phase 6 — Magnetic single-crystal refinement ✅
Nuclear + magnetic intensities; refine magnetic scale, moment magnitude
(± direction); fixed/free moment parameters; separate contribution reporting;
export magnetic model in project JSON.

## Phase 7 — Magnetic powder refinement ✅ (combined nuclear+magnetic profile, separable components)
Magnetic peaks, combined nuclear+magnetic profile with separable components,
moment + magnetic-scale refinement, obs/calc/difference plot, export. After
Phases 4 and 6 are working.

## Phase 8 — Constraints & advanced refinement ✅ (fixed/free/bounds/ties/groups + moment-size restraint + symmetry-allowed moments)
Fixed/free/bounds (from Phase 1) plus tied, grouped, site/occupancy/moment/
lattice constraints, presets. Start with direct tying and grouping; no complex
symbolic language early.

## Phase 9 — Validation ✅ (55 tests, GSAS-II golden values)
Tests for CIF/reflection/powder parsing, reciprocal lattice, phase factors,
nuclear structure factors, powder peak generation, residuals, optimizer, project
round-trip, magnetic projection, magnetic structure factors. Golden examples;
cross-checks vs GSAS-II/FullProf/Jana2020 where possible. See
[VALIDATION.md](./VALIDATION.md).

## Phase 10 — Documentation & limitations ✅
Finalize `README`, `ARCHITECTURE`, `ROADMAP`, `VALIDATION`, `LIMITATIONS`,
`PROJECT_FORMAT`, including the standing scope disclaimer.

## Deferred accelerators (post-correctness)
WebAssembly / WebGPU for structure-factor summation, profile convolution, and the
normal-equations solve — only after the TS core is correct and validated.

## Beyond the original plan — toward mature-package parity

Added after the 10-phase plan: multi-phase powder, Le Bail extraction,
anisotropic ADPs, March-Dollase preferred orientation, TOF/instrument support,
and in-app magnetic space-group candidate generation + comparison. The path to
GSAS-II / Jana2020 / FullProf capability is laid out in
[MATURITY_PLAN.md](./MATURITY_PLAN.md); the feature comparison is in
[COMPARISON.md](./COMPARISON.md).
