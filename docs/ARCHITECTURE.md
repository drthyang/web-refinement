# Architecture

Browser-native refinement workbench for atomic and magnetic structures. Static
web app (React + TypeScript + Vite), deployable to GitHub Pages, no backend for
the core workflow. Heavy computation runs in Web Workers; optional WebGPU kernels
add opt-in f32 acceleration over the correct f64 CPU path (validated against it,
never the default). WebAssembly is deliberately skipped.

This document is the map. Detailed models live in
[DATA_MODEL.md](./DATA_MODEL.md) and [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md);
scope and honesty statements live in [LIMITATIONS.md](./LIMITATIONS.md).

## Design goals

Guided by established crystallographic refinement practice:

- Transparent, inspectable data models.
- Reproducible project files (plain JSON, versioned schema).
- Constrained parameters with fixed/free states and bounds.
- Observed-vs-calculated comparison as a first-class view.
- Refinement history you can read and undo.
- Validation against known examples, with clearly labeled approximations.

## Layered architecture

Strict one-directional dependencies: upper layers may import lower layers, never
the reverse. Scientific code never imports React.

```
┌───────────────────┬───────────────────────┬─────────────────────┐
│ Web app UI        │ MCP agent server      │ Web workers         │  three thin consumer
│ src/app,          │ src/mcp               │ src/workers         │  surfaces over the
│ src/components    │ (33-tool registry)    │ (long solves)       │  same core functions
├───────────────────┴───────────────────────┴─────────────────────┤
│ Import & presentation   src/parsers, src/visualization           │  CIF/hkl/powder in,
├──────────────────────────────────────────────────────────────────┤  plot data out
│ src/core — pure TypeScript, no DOM, no React, no side effects    │
│                                                                  │
│   workflow      problem builders (powder, magnetic, multi-phase) │
│   refinement    LM driver + MCMC sampler, esds, diagnostics      │
│   diffraction   structure factors, reflections, peak profiles    │
│   pdf           G(r) forward model, analytic gradients, partials │
│   magnetic      MSG candidates, k-search, moments, |F_M|², mPDF  │
│   crystal       cells, symmetry, site/ADP constraints,           │
│                 distortion modes, isotropy + subgroup lattices   │
│   scattering    neutron b, X-ray f(Q), magnetic ⟨j0⟩/⟨j2⟩ tables │
│   diagnostics   assess / suggest / interpret (judgment as code)  │
│   export        CIF, mCIF, FullProf + GSAS-II bundles, reports   │
│   absorption    μ, transmission, habit, face indexing            │
│   math, project Vec3/Mat3/complex; project (de)serialization     │
└──────────────────────────────────────────────────────────────────┘
                    ▲
   validation layer  src/**/*.test.ts — unit + golden GSAS-II datasets
   (git-ignored data/, skip when absent) + MCP contract shapes + doc-sync
```

The **golden rule**: `src/core/**` is pure TypeScript with no DOM, React, or
worker dependencies. Every scientific function is pure and independently
testable. This is what makes validation and future WASM porting tractable —
and it is why every consumer surface is thin: the web app is React state over
core functions, the MCP server is a registry of the same functions behind a
stdio transport (see [AGENT_TOOLS.md](./AGENT_TOOLS.md)), and the workers are
the same functions off the UI thread. Adding a surface never adds science.

## Source tree

```
src/
  app/              application shell, workbenches, parameter specs
  components/        React UI components (presentation only)
  core/
    math/            Vec3/Mat3/Complex types + pure linear algebra
    crystal/         unit cell, symmetry, structure model, constraints
    scattering/      neutron b, X-ray f(Q), magnetic ⟨j0⟩/⟨j2⟩ tables
    diffraction/     reflections, structure factors, peak profiles
    pdf/             G(r) forward model + analytic gradients, partials
    magnetic/        MSG/k machinery, moment models, magnetic |F|², mPDF
    refinement/      parameters, constraints, LM engine; bayes/ MCMC sampler
    workflow/        problem builders: powder, magnetic, multi-phase, SC
    diagnostics/     assessment / next-steps / interpretation (judgment)
    export/          CIF, mCIF, FullProf + GSAS-II bundles, reports
    absorption/      μ, transmission, crystal habit, face indexing
    project/         project file (de)serialization
  parsers/           CIF/mCIF, hkl, powder formats, instrument files
  mcp/               agent tool layer: tools.ts (pure handlers),
                     registry.ts (single source of truth), server.ts (stdio)
  workers/           Web Worker entry points + typed message protocol
  visualization/     plotting and structure/arrow rendering helpers
  examples/          bundled reference datasets and projects
  testSupport/       helpers for tests over the git-ignored data/ folder
docs/
  ARCHITECTURE.md ROADMAP.md DATA_MODEL.md REFINEMENT_ENGINE.md
  AGENT_TOOLS.md MAGNETIC_SYMMETRY.md SINGLE_CRYSTAL.md VALIDATION.md
  LIMITATIONS.md PROJECT_FORMAT.md …
```

Tests live next to the code as `*.test.ts`. Suites that validate against real
GSAS-II refinements read the git-ignored `data/` folder through
`src/testSupport` and skip gracefully when it is absent (CI, fresh clones) —
see [VALIDATION.md](./VALIDATION.md).

## Core scientific data model

Full detail in [DATA_MODEL.md](./DATA_MODEL.md). In brief:

- **StructureModel** = UnitCell + SpaceGroup (list of SymmetryOperations) +
  AtomSites. Nuclear/atomic only; carries no magnetic data.
- **MagneticModel** decorates a StructureModel *by id*, adding MagneticMoments
  and a propagation vector. This layering is deliberate: atomic refinement never
  imports magnetic types, so Phases 1–4 cannot accidentally depend on Phase 5+.
- **DiffractionDataset** is either a SingleCrystalDataset (h k l I σ) or a
  PowderPattern (x y σ with an x-unit). Both feed one engine.
- **ProjectFile** is the serializable aggregate of all of the above plus the
  parameter list and last result.

All data types are methods-free plain objects so they serialize to JSON and
cross the worker boundary without custom (de)serialization.

## Calculation engine

Splits cleanly by data type behind a shared interface (see REFINEMENT_ENGINE.md):

- **Single crystal**: `F_N(hkl)` → `|F|²` → Lorentz–polarization → `I_calc`.
- **Powder**: allowed reflections → intensities (with multiplicity) → profile
  convolution (Gaussian first, pseudo-Voigt later) + background → `y_calc(x)`.

The form-factor / scattering-length system is a **replaceable module** behind an
interface, so the simplified Phase 3 table can be swapped for complete tables
without touching the calculators.

## Refinement engine

Data-agnostic least-squares driver (Levenberg–Marquardt) operating on a flat
`RefinementParameter[]`. It sees only numbers, bounds, and a residual function
supplied by the active workflow. Bindings map each parameter back onto a field
in the domain model. Full design in [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md).

A **Bayesian posterior sampler** (`core/refinement/bayes/`) sits beside the
least-squares driver on the same `RefinementProblem` seam: an affine-invariant
ensemble MCMC (Goodman–Weare stretch move) with logit/log transforms for
bounded parameters, a marginalized-noise default likelihood, and convergence
diagnostics (split-R̂, ESS, credible intervals, `esdRatio` = posterior std /
linearized LM esd). It mirrors the LM core's sans-io generator design — RNG
lives only in the generator, so the serial and worker-pool drivers are
bit-identical and a run is resumable from a serialized walker-state token.
Prototype, PDF-first; gates in [VALIDATION.md](./VALIDATION.md).

## Worker / compute layer

Structure-factor and profile calculation, and the refinement loop, run in a Web
Worker to keep the UI responsive. The Levenberg–Marquardt core is a sans-io
generator (`refineCore`): the synchronous driver evaluates serially, and the
parallel driver fans the Jacobian columns out over a pool of EVALUATOR workers,
each holding a bit-identical problem replica built by the same construction
path — `engineParallel.test.ts` pins the two drivers to identical trajectories.
The protocol is a typed, versioned request/response message set; data types
cross the boundary as plain JSON (structured clone). The UI layer talks to
workers through a thin typed client,
never by hand-rolling `postMessage` calls in components.

## Import / export layer

- **Parsers** (`src/parsers`): CIF (cell, symmetry ops, sites), hkl intensity
  tables, powder tables (with x-unit metadata). Pure functions: `string → model`.
- **Project I/O**: `ProjectFile ↔ JSON`, guarded by `schemaVersion` for
  migration. See [PROJECT_FORMAT.md](./PROJECT_FORMAT.md).

## Validation strategy

Summary here; details in [VALIDATION.md](./VALIDATION.md). Every scientific
function has unit tests; key calculators have **golden-value** snapshot tests so
numbers cannot change silently; selected examples are cross-checked against
established tools where possible, with results labeled *validated* or
*approximate*.

## Acceleration status (workers + GPU kernels shipped; WASM skipped)

Three CPU layers are live, every one exactness-tested: windowed peak synthesis,
the geometry cache in the problem builders, and the parallel-Jacobian
evaluator pools (browser Web Workers AND node worker_threads for the MCP
server — the same sans-io LM core drives both, bit-identically).

**WebGPU** (f32, approximate, opt-in, each with a hardware validation harness +
precision contract; the exact f64 CPU path stays the default and reference):
- `gpuSynthesizer.ts` — batched Gaussian/pseudo-Voigt synthesis, 17×, max
  deviation 1.1e-5 of the pattern maximum.
- `gpuStructureFactor.ts` — the nuclear **structure-factor kernel** (|F_N|² over
  a batch of models × shared reflections; neutron/X-ray, iso/aniso DW), ≤5e-7 vs
  the CPU f64 truth, 13.6× on 1439 reflections × 24 models. **Wired into the
  refinement pool** (opt-in `useGpu`, single-phase powder) through a |F|²-injection
  seam that reuses the exact CPU intensity/profile/background assembly, so only
  |F|² comes from the GPU — no second forward model. Runs in a Web Worker, so the
  driver/UI thread stays free (the batched GPU work never touches the main thread).
- `gpuMagneticStructureFactor.ts` — the magnetic **|F_M|² kernel**: the
  complex-vector structure factor with the M⊥ perpendicular projection and ⟨j0⟩
  form factor, 4.5e-7 vs CPU on the Mn₃Ga AFM (175 satellites). Kernel + campaign
  done; pool-wiring pending (mirrors the nuclear injection seam).

Full precision numbers in [VALIDATION.md](./VALIDATION.md#gpu-acceleration-precision).

**WASM**: deliberately skipped — the windowed CPU kernels plus worker pools
already cover its niche, and a second implementation of the same physics in
another language is exactly the maintenance drift this architecture avoids.

## Implementation rules (enforced)

- Strict TypeScript; `any` avoided (lint-enforced).
- Scientific functions pure and independently testable.
- React components handle UI state and presentation only.
- Long-running calculations run in Web Workers.
- GPU kernels only as opt-in f32 accelerators *over* a correct, tested f64 CPU
  path — each validated against it on hardware; never the default or the
  reference. No WebAssembly (dual-implementation drift).
- Every phase ends with: passing tests, updated docs, a working local app, and
  no broken intermediate state.
