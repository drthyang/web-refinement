# Architecture

Browser-native refinement workbench for atomic and magnetic structures. Static
web app (React + TypeScript + Vite), deployable to GitHub Pages, no backend for
the core workflow. Heavy computation runs in Web Workers; WebAssembly/WebGPU are
future accelerators, added only after the TypeScript implementation is correct
and tested.

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
┌──────────────────────────────────────────────┐
│ UI layer            src/components, src/app    │  React only: state + presentation
├──────────────────────────────────────────────┤
│ Visualization layer src/visualization          │  plots, structure/arrow rendering
├──────────────────────────────────────────────┤
│ Worker/compute layer src/workers                │  offload long calculations
├──────────────────────────────────────────────┤
│ Import/export layer  src/parsers, project I/O   │  CIF, hkl, powder, project JSON
├──────────────────────────────────────────────┤
│ Refinement engine    src/core/refinement        │  least-squares driver
├──────────────────────────────────────────────┤
│ Calculation engine   src/core/{crystal,         │  structure factors, profiles
│                       diffraction,magnetic,math} │
├──────────────────────────────────────────────┤
│ Scientific data model src/core/*/types.ts        │  pure data types (this phase)
└──────────────────────────────────────────────┘
                    ▲
        validation/test layer  src/**/*.test.ts (cross-cutting)
```

The **golden rule**: `src/core/**` is pure TypeScript with no DOM, React, or
worker dependencies. Every scientific function is pure and independently
testable. This is what makes validation and future WASM porting tractable.

## Source tree

```
src/
  app/              application shell, constants, top-level state
  components/        React UI components (presentation only)
  core/
    math/            Vec3/Mat3/Complex types + pure linear algebra
    crystal/         unit cell, symmetry, structure model, structure factors
    diffraction/     single-crystal & powder data models + calculators
    magnetic/        magnetic model, moment projection, magnetic form factors
    refinement/      parameters, constraints, least-squares engine
  parsers/           CIF, hkl, powder, project (de)serialization
  workers/           Web Worker entry points + typed message protocol
  visualization/     plotting and structure/arrow rendering helpers
  examples/          bundled reference datasets and projects
  tests/             cross-module and golden-value tests
docs/
  ARCHITECTURE.md ROADMAP.md DATA_MODEL.md REFINEMENT_ENGINE.md
  VALIDATION.md LIMITATIONS.md PROJECT_FORMAT.md
```

(Feature-specific tests may also live next to the code as `*.test.ts`; the
`tests/` directory holds cross-cutting and golden-example suites.)

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

## Worker / compute layer

Structure-factor and profile calculation, and the refinement loop, run in a Web
Worker to keep the UI responsive. The protocol is a typed, versioned
request/response message set; data types cross the boundary as plain JSON
(structured clone). The UI layer talks to workers through a thin typed client,
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

## Future acceleration points (WASM / WebGPU)

Not built until the TS core is correct and tested. Candidate hotspots, in
likely order of payoff:

1. Structure-factor summation over many reflections × many atoms (embarrassingly
   parallel; good WebGPU fit).
2. Powder profile convolution across the full pattern.
3. Jacobian assembly and the normal-equations solve in refinement.

Because `src/core` is pure and side-effect-free, these can be introduced as
drop-in alternative implementations behind the existing interfaces.
```

## Implementation rules (enforced)

- Strict TypeScript; `any` avoided (lint-enforced).
- Scientific functions pure and independently testable.
- React components handle UI state and presentation only.
- Long-running calculations run in Web Workers.
- No WebGPU/WebAssembly until the TS implementation is correct and tested.
- Every phase ends with: passing tests, updated docs, a working local app, and
  no broken intermediate state.
