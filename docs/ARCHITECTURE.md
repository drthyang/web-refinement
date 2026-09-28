# Architecture

Browser-native refinement workbench for atomic and magnetic structures: a static
web app (React + TypeScript + Vite) that deploys to GitHub Pages and needs no
backend for the core workflow. Heavy computation runs in Web Workers. Optional
WebGPU kernels add f32 acceleration, each validated against the f64 CPU path,
which stays the reference; the header's GPU chip turns them off to hold every
fit on that path. WebAssembly is deliberately skipped.

This document is the map. Detailed models live in
[DATA_MODEL.md](./DATA_MODEL.md) and [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md).
Scope and honesty statements live in [LIMITATIONS.md](./LIMITATIONS.md).

## Design goals

Guided by established crystallographic refinement practice:

- Transparent, inspectable data models.
- Reproducible project files (plain JSON, versioned schema).
- Constrained parameters with fixed/free states and bounds.
- Observed-vs-calculated comparison as a first-class view.
- A readable refinement history, and a reset to the starting values.
- Validation against known examples, with clearly labeled approximations.

## Layered architecture

Dependencies point one way: upper layers may import lower layers, never the
reverse. Scientific code never imports React.

```
┌───────────────────┬───────────────────────┬──────────────────────┐
│ Web app UI        │ MCP agent server      │ Web workers          │  three thin consumer
│ src/app,          │ src/mcp               │ src/workers          │  surfaces over the
│ src/components    │ (tool registry)       │ (long solves)        │  same core functions
├───────────────────┴───────────────────────┴──────────────────────┤
│ Import & presentation   src/parsers, src/visualization           │  CIF/hkl/powder in,
├──────────────────────────────────────────────────────────────────┤  plot data out
│ src/core — pure TypeScript, no DOM, no React, no side effects    │
│                                                                  │
│   workflow      problem builders (powder, magnetic, multi-phase) │
│   refinement    LM driver + MCMC samplers, esds, diagnostics     │
│   diffraction   structure factors, reflections, peak profiles    │
│   pdf           G(r) forward model, analytic gradients, partials │
│   totalscattering                                                │
│                 F(Q) → G(r) transform, σ_G(r), PDF weights       │
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
   validation layer  src/**/*.test.ts — unit + golden external-tool datasets
   (git-ignored data/, skip when absent) + MCP contract shapes + doc-sync
```

The **golden rule**: `src/core/**` is pure TypeScript with no DOM, React or
worker dependencies. Every scientific function is pure and independently
testable, which keeps validation tractable. It also keeps every consumer surface
thin, so adding a surface never adds science:

- **Web app:** React state over core functions.
- **MCP server:** a registry of the same functions behind a stdio transport.
  The transport keeps bulky data server-side and passes refs
  ([AGENT_TOOLS.md](./AGENT_TOOLS.md)).
- **Workers:** the same functions, off the UI thread.

## Source tree

```
src/
  app/               application shell, workbenches, ui/ panels, parameter specs
  components/        shared React panels (presentation only)
  core/
    math/            Vec3/Mat3/Complex types, linear algebra, FFT, quadrature
    crystal/         unit cell, symmetry, structure model, constraints,
                     distortion modes, subgroup trees
    scattering/      neutron b, X-ray f(Q), magnetic ⟨j0⟩/⟨j2⟩ tables
    diffraction/     reflections, structure factors, peak profiles
    pdf/             G(r) forward model + analytic gradients, partials
    totalscattering/ F(Q) → G(r) transform, σ_G(r) propagation, PDF weights
    magnetic/        MSG/k machinery, moment models, magnetic |F|², mPDF
    refinement/      parameters, constraints, LM engine; bayes/ MCMC samplers;
                     staged, sequential and multi-start controllers
    workflow/        problem builders: powder, magnetic, multi-phase, SC, PDF
    diagnostics/     assessment / next-steps / interpretation (judgment)
    export/          CIF, mCIF, FullProf + GSAS-II bundles, reports
    absorption/      μ, transmission, crystal habit, face indexing
    project/         project file: types, readable serializer, validation, migration
  parsers/           CIF/mCIF, hkl, powder formats, instrument files, PDF data
  mcp/               agent tool layer: tools.ts (pure handlers),
                     registry.ts (single source of truth), host.ts + refs.ts
                     (refs, path, free, read_ref), server.ts (stdio),
                     nodeEvaluator.ts (worker_threads pool)
  workers/           compute worker, typed protocol and client, WebGPU kernels
  visualization/     plot helpers: scales, axis units, reflection ticks, hit testing
  examples/          bundled demo structures and datasets
  testSupport/       helpers for tests over the git-ignored data/ folder
docs/
  ARCHITECTURE.md ROADMAP.md DATA_MODEL.md REFINEMENT_ENGINE.md
  AGENT_TOOLS.md MAGNETIC_SYMMETRY.md SINGLE_CRYSTAL.md VALIDATION.md
  LIMITATIONS.md PROJECT_FORMAT.md …
```

Tests live next to the code as `*.test.ts`. Suites that read the git-ignored
`data/` folder go through `src/testSupport` and skip when it is absent, as in CI
or a fresh clone ([VALIDATION.md](./VALIDATION.md)).

## Core scientific data model

Full detail in [DATA_MODEL.md](./DATA_MODEL.md). In brief:

- **StructureModel** = UnitCell + SpaceGroup (list of SymmetryOperations) +
  AtomSites. Nuclear/atomic only; carries no magnetic data.
- **MagneticModel** decorates a StructureModel *by id*, adding MagneticMoments
  and a propagation vector. This layering is deliberate: atomic refinement never
  imports magnetic types, so it cannot accidentally depend on magnetic code.
- **DiffractionDataset** is either a SingleCrystalDataset (h k l I σ) or a
  PowderPattern (x y σ with an x-unit). **PdfPattern** (r, G(r)) is its
  real-space counterpart. All of them feed one engine.
- **ProjectFile** is the saved session: the phases plus one technique-tagged
  `workspace` (powder / singleCrystal / pdf). The workspace holds that
  technique's dataset, settings, parameters and last result, and is validated
  per technique on load.

All data types are methods-free plain objects, so they serialize to JSON and
cross the worker boundary without custom (de)serialization.

## Calculation engine

The forward model splits by data type behind a shared interface
([REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md)):

- **Single crystal**: `F_N(hkl)` → `|F|²` → Lorentz–polarization → `I_calc`.
- **Powder**: allowed reflections → intensities (with multiplicity) → peak
  profile (Gaussian, pseudo-Voigt or Thompson–Cox–Hastings for constant
  wavelength; back-to-back exponential for TOF) + background → `y_calc(x)`.
- **PDF**: pairs within r_max → broadened pair sum → `G_calc(r)`.

The form-factor / scattering-length system is a **replaceable module** behind an
interface, so a table can be extended or swapped without touching the
calculators (see [SCATTERING_TABLES.md](./SCATTERING_TABLES.md)).

## Refinement engine

A data-agnostic Levenberg–Marquardt least-squares driver works on a flat
`RefinementParameter[]`. It sees only numbers, bounds and a residual function
supplied by the active workflow. Bindings map each parameter back onto a field
in the domain model.

Posterior samplers (`core/refinement/bayes/`) sit beside it on the same
`RefinementProblem` seam: an affine-invariant ensemble MCMC sampler and, for
single-phase PDF fits, a gradient-based NUTS sampler. The ensemble sampler
mirrors the LM core's sans-io generator design, so its serial and worker-pool
chains are bit-identical and a run resumes from a serialized token. The full
design is in [REFINEMENT_ENGINE.md](./REFINEMENT_ENGINE.md), and the gates are in
[VALIDATION.md](./VALIDATION.md).

## Worker / compute layer

The bulk of the evaluation runs in workers. The Levenberg–Marquardt core is a
sans-io generator (`refineCore`) that yields batches of evaluations, so a driver
decides only where they run.

- **Single-worker path.** A whole refinement runs inside the compute worker.
- **Parallel path.** The driver keeps the LM loop and the single baseline and
  trial evaluations on the calling thread, which in the browser is the UI
  thread. It fans the Jacobian columns out over a pool of evaluator workers, each
  holding a problem replica built by the same construction path.
  [`engineParallel.test.ts`](../src/core/refinement/engineParallel.test.ts) pins
  the two drivers to identical trajectories.
- **Posterior sampling.** The ensemble sampler fans its walker batches out over
  the same pools.

The protocol is a typed request/response message set
([`workers/protocol.ts`](../src/workers/protocol.ts)). Data types cross the
boundary as plain JSON through structured clone. Components talk to workers only
through the typed client
([`workers/computeClient.ts`](../src/workers/computeClient.ts)), never through
hand-rolled `postMessage` calls.

## Import / export layer

- **Parsers** (`src/parsers`): pure `string → model` functions for CIF and mCIF
  structures, reflection lists, powder patterns, instrument files and PDF data.
  [LIMITATIONS.md](./LIMITATIONS.md#input-and-output) lists the supported
  formats.
- **Exporters** (`src/core/export`): CIF and mCIF, the HTML refinement report,
  and the FullProf + GSAS-II cross-check bundle.
- **Project I/O** (`src/core/project`): `ProjectFile ↔ JSON`, with a readable
  serializer, a `schemaVersion` gate with migrations, and structural validation
  by technique. The app layer (`src/app/projectIo.ts`) maps each engine's live
  state to its workspace block and back. The shell owns the envelope, and the
  active engine supplies its block through `projectWorkspace` in the engine
  contract. See [PROJECT_FORMAT.md](./PROJECT_FORMAT.md).

## Validation strategy

Every scientific function has unit tests, and key calculators have
**golden-value** tests, so numbers cannot change silently. Selected examples are
cross-checked against established tools where possible, with results labeled
*validated* or *approximate*. Details are in [VALIDATION.md](./VALIDATION.md).

## Acceleration

Three CPU layers speed up evaluation:

- **Windowed peak synthesis.** Each peak is summed only within ±20 FWHM of its
  center, located by binary search on a monotonic grid.
- **Geometry cache.** The problem builders reuse the structure-factor stage while
  no geometry parameter moves.
  [`peakCache.test.ts`](../src/core/workflow/peakCache.test.ts) pins cache hits
  bit-identical to cold evaluations.
- **Parallel-Jacobian pools.** Browser Web Workers, and Node `worker_threads` for
  the MCP server ([`mcp/nodeEvaluator.ts`](../src/mcp/nodeEvaluator.ts)). The
  same sans-io LM core drives both, bit-identically.

**WebGPU kernels** compute in f32, so they are approximate. Each has a hardware
validation harness and a precision contract, and the exact f64 CPU path stays the
reference ([VALIDATION.md](./VALIDATION.md#gpu-acceleration-precision)).

| Kernel (`src/workers/`) | Computes | Speed-up | Max deviation vs CPU | Used in refinement |
| --- | --- | --- | --- | --- |
| `gpuStructureFactor.ts` | nuclear \|F_N\|² over a batch of models × shared reflections; neutron or X-ray, isotropic or anisotropic Debye–Waller | 13.6× on 1439 reflections × 24 models | ≤ 5e-7 | single-phase nuclear powder |
| `gpuMagneticStructureFactor.ts` | magnetic \|F_M\|²: the complex-vector structure factor with the M⊥ projection and the ⟨j0⟩ form factor | — | 4.5e-7 on the Mn₃Ga AFM (175 satellites) | no |

The nuclear kernel enters refinement through an |F|²-injection seam. The exact
CPU intensity, profile and background assembly stays in place, so only |F|²
comes from the GPU and there is no second forward model. The GPU batches run in
a Web Worker; the driver thread keeps only the single baseline and trial
evaluations.

The `useGpu` request flag is off by default in the `ComputeClient` API — a
caller opts in per request. The powder workbench sets it for every single-phase
nuclear refinement that is not staged, so a browser with WebGPU runs that
refinement on the kernel; without WebGPU it falls back to the CPU pool. In the
app that choice is the user's: the header's GPU chip is the control, lit by
default where an adapter exists, and turning it off holds every fit on the exact
f64 CPU path. The post-fit status line reports whether a given refinement
actually used the kernel ("· GPU |F|²").

**WebAssembly** is deliberately skipped. The windowed CPU kernels and worker
pools already cover its niche. A second implementation of the same physics in
another language is exactly the maintenance drift this architecture avoids.

## Commands

```bash
npm install            # install dependencies
npm run dev            # local dev server
npm run build          # type-check (tsc -b) and build the static site
npm run lint           # ESLint (flat config, typescript-eslint + react-hooks)
npm run test           # the Vitest suite
npm run test:ganb4se8  # real-data powder regression (needs data/GaNb4Se8_XRD/)
npm run gen:tooldoc    # regenerate the tool tables in AGENT_TOOLS.md
npm run screenshots    # regenerate docs/screenshots/ from the running app
```

Run `npm run test:ganb4se8` after any refinement-engine change. It needs the
local `data/GaNb4Se8_XRD/` files (`data/GaNb4Se8_XRD_28ID/` is accepted too) and
fails when they are missing. This dataset is the primary real-data check: it
exposes powder-refinement failure modes that synthetic examples miss.

## Implementation rules (enforced)

- Strict TypeScript (`strict: true`), type-checked in CI by `npm run build`.
  Explicit `any` is avoided, and ESLint now enforces it: a flat config
  (`eslint.config.js`, typescript-eslint) runs `no-explicit-any` alongside the
  `react-hooks` rules and a no-leftover-logging rule, and CI runs `npm run lint`
  beside `tsc -b` and the suite. The rule set is small on purpose — a rule is
  enabled only where the code already holds to it, so every remaining
  `eslint-disable` comment marks a deliberate exception rather than describing a
  linter that was never there.
- Scientific functions pure and independently testable.
- React components handle UI state and presentation only.
- Long-running calculations run in Web Workers.
- GPU kernels only as f32 accelerators *over* a correct, tested f64 CPU path.
  Each is validated against the CPU path on hardware, each falls back to it
  wherever it does not apply, and the f64 path stays the reference even where a
  kernel is on by default. No WebAssembly (dual-implementation drift).
- Every piece of work ends with passing tests, updated docs, a working local
  app, and no broken intermediate state.
- **Layout: edges line up** (`src/app/workbench.css`, header comment).
  - One content edge: the header, the notice and disclaimer bars, the footer
    and the page all pad with `--wb-edge`. The brand mark, banner text, first
    card and last menu button share one left and one right line at every width.
  - Titles sit flush on that edge. A card's border sits on the same line, and a
    page title outside a card has no padding of its own.
  - Siblings are spaced by `--wb-gap` only. Inside a card, the inset is
    `--wb-inset`.
  - No hand-typed pixel gutters at page level.
  - A working row fills the window, with its columns stretched to one bottom
    edge. What does not fit scrolls inside its card; there are no sticky rails.
  - Verify with `getBoundingClientRect()` before and after a layout change, not
    by eye.
