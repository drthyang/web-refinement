# Web Refinement Workbench

A browser-native refinement workbench for **atomic and magnetic structures**.
Static web app (React + TypeScript + Vite), deployable to GitHub Pages, with no
backend for the core workflow. Heavy computation runs in Web Workers;
WebAssembly/WebGPU are future accelerators.

> This package is an early browser-native refinement workbench for transparent
> model building, simulation, and basic constrained refinement. Results intended
> for publication must be validated against established tools and expert
> crystallographic judgment.

## Status

**Working app — atomic/nuclear refinement (single-crystal + powder) plus a
commensurate single-k magnetic workflow.** The scientific core, Levenberg–
Marquardt refinement engine, symmetry-adapted constrained parameters, CIF
parsing, a 3D structure/moment viewer, plots, and Web Worker compute are
implemented and tested (**293 tests**). Crystallographic and scattering
foundations are validated against bundled GSAS-II refinements (see
[docs/REPORT.md](docs/REPORT.md) and [docs/VALIDATION.md](docs/VALIDATION.md)).

The magnetic workflow runs end to end: **auto-detect magnetic peaks → k-vector
search → little-group magnetic subgroups → editable moment preview → moment
refinement** (k = 0 *and* k ≠ 0, CW and TOF, on one shared scale). Occupancy-
disorder sites refine with tied position/ADP, a Σ(occupancy) restraint (optionally
= 1), and an optional shared moment. Fit quality is judged with **F_obs vs F_calc
and normal-probability plots**, not just wR. Candidate magnetic groups carry
their standard **BNS/OG labels** (bundled ISO-MAG table). The star of k /
multi-k, representation analysis, and refined CIF/mCIF export are the next
milestones; see [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md).

Two forward-looking directions are documented and being built toward: an
**LLM AI-guided refinement** loop and exposing the app's pure core as
**agent tools and skills** — see [docs/AGENT_TOOLS.md](docs/AGENT_TOOLS.md).

## Commands

```bash
npm install     # install dependencies
npm run dev     # start the local dev server
npm run build   # type-check and build the static site
npm run test    # run the test suite (Vitest)
npm run test:ganb4se8  # required real-data powder regression
```

Use `npm run test:ganb4se8` for refinement-engine changes. It requires the local
`data/GaNb4Se8_XRD/` files and fails if they are missing; this dataset is the
primary real-data check because it exposes the current build's powder-refinement
failure modes much better than synthetic examples.

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

- [docs/ROADMAP.md](docs/ROADMAP.md) — **the single authoritative roadmap** (vision, foundations, milestones, agent layer)
- [docs/AGENT_TOOLS.md](docs/AGENT_TOOLS.md) — agent tools, skills, and the LLM-guided refinement plan
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, source tree, conventions
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — data types and their reasoning
- [docs/REFINEMENT_ENGINE.md](docs/REFINEMENT_ENGINE.md) — the least-squares design
- [docs/SCATTERING_TABLES.md](docs/SCATTERING_TABLES.md) — neutron / X-ray / magnetic form-factor tables
- [docs/VALIDATION.md](docs/VALIDATION.md) — testing & external comparison strategy
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — scope and known simplifications
- [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) — the project JSON format
- [docs/REFINEMENT_PROCEDURE.md](docs/REFINEMENT_PROCEDURE.md) — the guided 7-step workflow
- [docs/COMPARISON.md](docs/COMPARISON.md) — features vs GSAS-II / Jana2020 / FullProf
- [docs/REFERENCES.md](docs/REFERENCES.md) — bibliography: papers, data sources, and GSAS-II (validation reference)
- [docs/REPORT.md](docs/REPORT.md) — build & validation report
- [docs/archive/](docs/archive/) — superseded plans (POWDER_ROADMAP, MATURITY_PLAN), kept for detail

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

This is a web application: if you run a modified version on a network server, you must make the complete corresponding source code available to its users (AGPL §13).
