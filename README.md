# Web Refinement Workbench

A browser-native refinement workbench for **atomic and magnetic structures**.
Static web app (React + TypeScript + Vite), deployable to GitHub Pages, with no
backend for the core workflow. Heavy computation runs in Web Workers;
WebAssembly/WebGPU are future accelerators.

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. It is **not yet a
> replacement** for GSAS-II, FullProf, Jana2020, ShelX, or other established
> crystallographic refinement suites. Results intended for publication must be
> validated against established tools and expert crystallographic judgment.

## Status

**Working app — atomic/nuclear refinement (single-crystal + powder).** The
scientific core, Levenberg–Marquardt refinement engine, CIF parsing, plots, Web
Worker compute, and a functioning workbench UI are implemented and tested (55
tests). Crystallographic and scattering foundations are validated against a
bundled GSAS-II refinement (see [docs/REPORT.md](docs/REPORT.md) and
[docs/VALIDATION.md](docs/VALIDATION.md)). The magnetic structure factor is
implemented; magnetic refinement UI is pending. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Commands

```bash
npm install     # install dependencies
npm run dev     # start the local dev server
npm run build   # type-check and build the static site
npm run test    # run the test suite (Vitest)
```

## What it will do

Atomic/nuclear refinement first, magnetic later; single-crystal and powder
workflows sharing one refinement engine:

- Load CIF structures, hkl reflection tables, and powder patterns.
- Compute nuclear (and later magnetic) structure factors and intensities.
- Refine scale, coordinates, occupancies, displacement, lattice, background,
  peak width, and magnetic moments — with fixed/free states, bounds, and
  constraints.
- Compare observed vs calculated, track refinement history, and export a
  reproducible project JSON.

## Architecture in one paragraph

Strict layering with one-directional dependencies. `src/core/**` is **pure
TypeScript** — no React, DOM, or workers — so every scientific function is pure
and independently testable. UI components handle presentation only; long
calculations run in Web Workers. Full detail in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, source tree, conventions
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — data types and their reasoning
- [docs/REFINEMENT_ENGINE.md](docs/REFINEMENT_ENGINE.md) — the least-squares design
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased build plan
- [docs/VALIDATION.md](docs/VALIDATION.md) — testing & external comparison strategy
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — scope and known simplifications
- [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) — the project JSON format
- [docs/REFINEMENT_PROCEDURE.md](docs/REFINEMENT_PROCEDURE.md) — the guided 7-step workflow
- [docs/COMPARISON.md](docs/COMPARISON.md) — features vs GSAS-II / Jana2020 / FullProf
- [docs/MATURITY_PLAN.md](docs/MATURITY_PLAN.md) — roadmap toward mature-package parity
- [docs/REPORT.md](docs/REPORT.md) — build & validation report

## License

MIT.
