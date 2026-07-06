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

## Test matrix (101 tests, all passing)

| Area | Test kind | Status |
| --- | --- | --- |
| ProjectFile JSON round-trip | unit | ✅ `core/project/project.test.ts` |
| CIF parsing (cell, symmetry, sites) | unit + golden | ✅ `parsers/cif.test.ts` |
| Powder/reflection numeric parsing (esd) | unit | ✅ `parsers/cif.test.ts` |
| Reciprocal metric tensor / volume | golden (GSAS) | ✅ `core/crystal/unitCell.test.ts` |
| d-spacing / \|Q\| consistency | unit | ✅ `core/crystal/unitCell.test.ts` |
| Symmetry-op parsing & application | unit | ✅ `core/crystal/symmetry.test.ts` |
| Site multiplicity | golden (GSAS) | ✅ `core/crystal/symmetry.test.ts` |
| Systematic absences | unit | ✅ `core/crystal/symmetry.test.ts` |
| Neutron b / X-ray f / magnetic j0 | golden (GSAS) | ✅ `core/scattering/scattering.test.ts` |
| Nuclear structure factor `F_N` | analytic golden | ✅ `core/diffraction/structureFactor.test.ts` |
| Reflection generation + multiplicity | golden | ✅ `core/diffraction/reflections.test.ts` |
| Residual & agreement factors | unit | ✅ (via engine tests) |
| Optimizer behaviour (LM convergence) | unit | ✅ `core/refinement/engine.test.ts` |
| Constraint tie parsing/resolution | unit | ✅ `core/refinement/engine.test.ts` |
| Linear algebra (solve/invert) | unit | ✅ `core/math/linalg.test.ts` |
| Magnetic perpendicular-moment projection | unit | ✅ `core/magnetic/magnetic.test.ts` |
| Q / moment frame conversion | unit | ✅ `core/magnetic/magnetic.test.ts` |
| Single-crystal + powder workflow refinement | integration (GSAS structure) | ✅ `core/workflow/workflow.test.ts` |
| Magnetic CIF (mCIF) parsing + BNS ops | golden (GSAS) | ✅ `parsers/magneticCif.test.ts` |
| Magnetic moment magnitudes | golden (GSAS `.lst`) | ✅ `parsers/magneticCif.test.ts` |
| GSAS reflection-list (Fo²/Fc²) parsing | golden | ✅ `parsers/magneticCif.test.ts` |
| Magnetic single-crystal workflow + moment refinement | integration (GSAS structure) | ✅ `core/workflow/magneticWorkflow.test.ts` |
| Magnetic candidate generation (k=0 index-2 subgroups) | golden (P2₁/m → P2₁'/m') | ✅ `core/magnetic/magneticGroups.test.ts` |
| Allowed moment directions per site | golden (a–c plane) | ✅ `core/magnetic/magneticGroups.test.ts` |
| Candidate comparison ranks correct group best | integration (30 K) | ✅ `core/workflow/magneticCompare.test.ts` |
| Moment-size restraint → physical magnitudes | integration | ✅ `core/workflow/magneticCompare.test.ts` |
| TOF ↔ d conversion (POWGEN calibration) | golden (GSAS `.lst`) | ✅ `core/diffraction/instrument.test.ts` |
| Instrument-file parsing | unit | ✅ `core/diffraction/instrument.test.ts` |
| Anisotropic ADP (reduces to isotropic) | unit | ✅ `core/diffraction/features.test.ts` |
| March-Dollase preferred orientation | unit | ✅ `core/diffraction/features.test.ts` |
| Multi-phase powder (2-phase recovery) | integration | ✅ `core/workflow/multiPhase.test.ts` |
| Le Bail extraction (pattern reconstruction) | integration | ✅ `core/workflow/leBail.test.ts` |
| Magnetic powder (separable components + refine) | integration | ✅ `core/workflow/magneticPowder.test.ts` |
| Grouped (equal-value) constraints | unit | ✅ `core/refinement/engine.test.ts` |
| Real 200 K/350 K CIF + reflection lists | golden (GSAS d-spacings) | ✅ `parsers/realData.test.ts` |
| Plot scaling math | unit | ✅ `visualization/scale.test.ts` |

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

For each cross-check we record: the external tool, the input, the compared
quantity, the agreement achieved, and the tolerance we accept. The source is the
GSAS-II refinement bundled in `data/` (`isothermal_hex/Untitled.lst` and the
CIFs), a two-phase (Mn₃Ga + MnO) TOF neutron powder Rietveld.

| Quantity | Our value | GSAS-II value | Tolerance | Source |
| --- | --- | --- | --- | --- |
| Mn₃Ga cell volume | 110.759 Å³ | 110.759 Å³ | 1e-2 | `.lst` |
| MnO cell volume | 88.130 Å³ | 88.130 Å³ | 1e-2 | `.lst` |
| Mn₃Ga recip. tensor A11 | 0.0455025 | 0.045502499 | 1e-6 | `.lst` |
| Mn₃Ga recip. tensor A33 | 0.0524937 | 0.052493673 | 1e-6 | `.lst` |
| MnO recip. tensor A11 | 0.0504953 | 0.050495334 | 1e-6 | `.lst` |
| Mn₃Ga Mn1 multiplicity | 6 | 6 (Wyckoff 6h) | exact | `.lst` |
| Mn₃Ga Ga1 multiplicity | 2 | 2 (Wyckoff 2d) | exact | `.lst` |
| Neutron b (Mn / O / Ga) | −3.73 / 5.80 / 7.29 | −3.75 / 5.81 / 7.29 fm | 2e-2 | `.lst` |
| X-ray f(0) (Mn / O / Ga) | 25.0 / 8.0 / 31.0 | Z = 25 / 8 / 31 | 0.1 | Cromer-Mann |
| CIF cell (600 K Mn₃Ga) | a=5.42215, c=4.37566 | file values | 1e-5 | CIF |
| CIF cell (393 K refined) | a=5.41317, c=4.36462 | file values | 1e-5 | CIF |
| Magnetic moment \|M\| Mn1 (30 K) | 2.527 μB | 2.527 μB | 1e-2 | `30K/.lst` |
| Magnetic moment \|M\| Mn2 (30 K) | 2.829 μB | 2.829 μB | 1e-2 | `30K/.lst` |
| Magnetic moment \|M\| Mn3 (30 K) | 2.530 μB | 2.530 μB | 1e-2 | `30K/.lst` |
| BNS group / ops (30 K, 350 K) | P2₁'/m' 4 / Cm'cm' 16 | mCIF | exact | mCIF |

The magnetic moment magnitudes are a particularly strong check: the components are
given in crystal axes for a monoclinic cell (β = 60.69°), so reproducing GSAS-II's
reported magnitude confirms both the mCIF parse and the normalized-axis metric
used for `momentCartesian`.

The 200 K reflection list (`fitted_results_Cmcm_hkl.dat`) contains both phases;
its cubic MnO subset satisfies d·√(h²+k²+l²) = 4.438 Å, and our `dSpacing()`
reproduces GSAS-II's listed d-spacings for those reflections to < 2×10⁻³ Å.

**Scope note.** These validate the *crystallographic and scattering
foundations* — the quantities our engine shares with GSAS-II. The full
end-to-end fit is **not** compared: GSAS-II ran a two-phase TOF Rietveld with
instrument profile functions, background, and profile coefficients beyond this
minimal engine's scope (see [LIMITATIONS.md](./LIMITATIONS.md)). Our
refinement is validated only as *self-consistent* (recovers known parameters
from synthetic data), not against GSAS-II's wR.

## Honesty rule

If a number has not been checked against an independent source, the docs and UI
must not imply it has. See [LIMITATIONS.md](./LIMITATIONS.md) for the standing
scope statement that accompanies all results.
