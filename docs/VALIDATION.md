# Validation

Validation is mandatory, not optional. This document records **what is tested**,
**what is validated against external tools**, and **what is only approximate**.
Every claim about correctness must be traceable to a test or an external
comparison recorded here.

## Principles

1. Every scientific function in `src/core` has unit tests.
2. Key calculators have **golden-value** tests: a known input produces a recorded
   output, and the test fails if the number changes. This prevents silent drift.
3. Selected end-to-end examples are compared against established tools
   (GSAS-II, FullProf, Jana2020) where feasible; agreement and tolerances are
   recorded below.
4. Documentation states plainly which features are *validated* vs *approximate*.

## Test matrix (target — populated as phases land)

| Area | Test kind | Phase | Status |
| --- | --- | --- | --- |
| ProjectFile JSON round-trip | unit | 0 | ✅ `core/project/project.test.ts` |
| CIF parsing (cell, symmetry, sites) | unit + golden | 1/3 | ⬜ |
| Reflection (hkl) parsing | unit | 3 | ⬜ |
| Powder data parsing (+ x-unit) | unit | 4 | ⬜ |
| Reciprocal lattice / metric tensor | unit + golden | 1 | ⬜ |
| Phase factor `exp[2πi(hx+ky+lz)]` | unit | 1 | ⬜ |
| Nuclear structure factor `F_N` | golden | 3 | ⬜ |
| Lorentz–polarization, multiplicity | unit | 3/4 | ⬜ |
| Powder peak generation | golden | 4 | ⬜ |
| Residual & agreement factors | unit | 3 | ⬜ |
| Optimizer behaviour (LM convergence) | unit | 3 | ⬜ |
| Magnetic perpendicular-moment projection | unit | 5 | ⬜ |
| Magnetic structure factor `F_M` | golden | 5/6 | ⬜ |

## Golden examples

Golden fixtures live under `src/examples/` with recorded expected outputs. Each
golden test names its source of truth (an analytic value, a hand calculation, or
an external-tool run). Updating a golden value requires an explicit, reviewed
change — it cannot happen silently.

Planned reference structures:
- **bcc Fe** — trivial one-site cell; exercises symmetry expansion and `F_N`.
- A simple oxide (e.g. rock-salt MgO) — two sites, neutron + X-ray form factors.
- A simple collinear antiferromagnet — magnetic projection and `F_M`.

## External comparisons

For each cross-check we record: the external tool and version, the input, the
compared quantity, the agreement achieved, and the tolerance we accept. Until a
row here exists for a feature, that feature is **approximate**, not validated.

| Example | Quantity | Tool | Agreement | Notes |
| --- | --- | --- | --- | --- |
| _(none yet — Phase 0)_ | | | | |

## Honesty rule

If a number has not been checked against an independent source, the docs and UI
must not imply it has. See [LIMITATIONS.md](./LIMITATIONS.md) for the standing
scope statement that accompanies all results.
