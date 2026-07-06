# Build & Validation Report

**Project:** Web Refinement Workbench — a browser-native refinement workbench for
atomic and magnetic structures.
**Date:** 2026-07-06
**Stack:** React 18 · TypeScript 5 (strict) · Vite 5 · Vitest · Web Workers.
**Status:** Working static app; 55 tests passing; validated against the bundled
GSAS-II refinement in `data/`.

---

## 1. What was built

A functioning, deployable single-page app that performs atomic/nuclear structure
refinement for both single-crystal and powder neutron/X-ray data, plus the
scientific foundations for magnetic refinement. It follows the phased plan; the
architecture rule "no scientific code in React components" is upheld — everything
in `src/core/**` is pure, framework-free TypeScript.

### Layers delivered

| Layer | Location | Contents |
| --- | --- | --- |
| Scientific data model | `src/core/*/types.ts` | All 11 interface drafts, methods-free |
| Math | `src/core/math` | Vec3/Mat3/Complex, dense linear solver + inverse |
| Crystallography | `src/core/crystal` | Metric tensors, volume, d-spacing, symmetry ops, multiplicity, absences |
| Scattering | `src/core/scattering` | Neutron b, Cromer-Mann X-ray f, ⟨j0⟩ magnetic — behind a swappable interface |
| Diffraction | `src/core/diffraction` | Reflection generation, nuclear `F_N`, Lorentz-polarization, Gaussian/pseudo-Voigt profiles |
| Magnetic | `src/core/magnetic` | Perpendicular-moment projection, magnetic `F_M` |
| Refinement | `src/core/refinement` | Levenberg–Marquardt engine, R-factors, esds, constraint ties |
| Workflows | `src/core/workflow` | Single-crystal & powder problem builders + obs/calc comparison |
| Parsers | `src/parsers` | CIF (esd-aware), hkl, powder, project JSON |
| Compute | `src/workers` | Typed worker + client (refinement off the main thread) |
| Visualization | `src/visualization` | SVG pattern plot, obs-vs-calc scatter |
| UI | `src/app`, `src/components` | Workbench: structure view, parameter tables, refine, export |

### Commands

```bash
npm install     # deps
npm run dev      # dev server (localhost:5173/web-refinement/)
npm run build    # tsc -b && vite build → dist/ (worker bundled separately)
npm run test     # vitest — 55 tests
```

---

## 2. Validation against GSAS-II data

The `data/` folder contains a real GSAS-II two-phase (Mn₃Ga hexagonal + MnO
cubic) **time-of-flight neutron powder Rietveld** refinement: a `.gpx` project,
temperature-series CIFs, and a `.lst` output listing. We used the GSAS-II
**outputs as golden reference values** for every quantity our engine shares with
it. All comparisons pass as automated tests.

| Quantity | Our value | GSAS-II | Match |
| --- | --- | --- | --- |
| Mn₃Ga cell volume | 110.759 Å³ | 110.759 Å³ | ✅ |
| MnO cell volume | 88.130 Å³ | 88.130 Å³ | ✅ |
| Mn₃Ga reciprocal tensor A11 | 0.0455025 | 0.045502499 | ✅ |
| Mn₃Ga reciprocal tensor A33 | 0.0524937 | 0.052493673 | ✅ |
| MnO reciprocal tensor A11 | 0.0504953 | 0.050495334 | ✅ |
| Mn₃Ga Mn1 site multiplicity | 6 | 6 (6h) | ✅ |
| Mn₃Ga Ga1 site multiplicity | 2 | 2 (2d) | ✅ |
| Neutron b: Mn / O / Ga | −3.73 / 5.80 / 7.29 fm | −3.75 / 5.81 / 7.29 | ✅ |
| X-ray f(0): Mn / O / Ga | 25.0 / 8.0 / 31.0 e⁻ | Z = 25 / 8 / 31 | ✅ |
| CIF parse (600 K cell) | a=5.42215, c=4.37566 | file values | ✅ |
| CIF parse (393 K refined, esd stripped) | a=5.41317, c=4.36462 | file values | ✅ |

These pin the **crystallographic and scattering foundations** to an established
tool. The reciprocal metric tensors match GSAS-II to 6+ significant figures.

### Refinement-engine validation

The Levenberg–Marquardt engine is validated by **self-consistency** and on
analytic problems:

- Recovers a linear scale factor and a two-parameter non-linear model
  (`y = a·exp(bx)`) to ≥ 3–4 significant figures.
- Holds fixed parameters constant; resolves tied parameters
  (e.g. `occB = 1 − occA`).
- Single-crystal workflow: recovers a known scale from the GSAS-derived Mn₃Ga
  structure (R < 1 %).
- Powder workflow: synthesizes a 2θ pattern from the structure and recovers the
  scale from a wrong start (wR → 0.01 %).

Confirmed live in-browser: powder refine recovered scale 40 → 80.000 (wR 50 % →
0.01 %, GoF 0.30); single-crystal refine recovered scale 2 → 5.000 (R 0.00 %),
both executed in the Web Worker.

---

## 3. Honest limitations

- **Not a Rietveld replacement.** GSAS-II's own fit here is a two-phase TOF
  Rietveld with instrument profile functions (difC, α/β/σ coefficients),
  background, and profile terms beyond this minimal engine. We validate the
  shared foundations and self-consistency, **not** GSAS-II's wR (11.96 %).
- **Simplified physics (by design):** simplified structure-factor equation and a
  small (swappable) scattering table; isotropic ADPs only in calculation;
  Gaussian/pseudo-Voigt profiles with constant/polynomial background;
  constant-wavelength profiles only (TOF profile not modelled); local LM only
  (no global search).
- **Magnetic:** the model, perpendicular-moment projection, and magnetic
  structure factor are implemented and tested; a dedicated magnetic *refinement
  workflow and UI* are not yet wired (Phases 6–7). Non-orthogonal moment-frame
  conversion is a documented simplification.

Full detail in [LIMITATIONS.md](./LIMITATIONS.md). The standing scope disclaimer
appears in the app UI, README, and limitations doc.

---

## 4. Test summary

```
Test Files  12 passed (12)
Tests       55 passed (55)
```

Covering: linear algebra, unit-cell/metric/volume (GSAS golden), symmetry
parsing/multiplicity/absences (GSAS golden), scattering tables (GSAS golden),
nuclear structure factors (analytic golden), reflection generation, LM optimizer
+ constraints, magnetic projection & frames, CIF parsing (GSAS files), single-
crystal & powder workflow refinement, project round-trip, and plot math.

---

## 5. Suggested next steps

1. Wire the magnetic refinement workflow + moment-arrow visualization (Phases 6–7).
2. Add a TOF profile model to enable a genuine comparison against the GSAS-II
   `.lst` wR on the bundled Mn₃Ga/MnO data.
3. Parameter grouping and refinement presets (Phase 8 remainder).
4. WebGPU acceleration for structure-factor summation once coverage is broader.
