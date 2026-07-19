# Build & Validation Report

**Project:** MATERIA Workbench — a browser-native refinement workbench for
atomic and magnetic structures.
**Stack:** React 18 · TypeScript 5 (strict) · Vite 5 · Vitest · Web Workers.
**Status (2026-07-19):** working static app; **1072 tests passing** (59
real-data/slow tests skip without local `data/`); atomic **and magnetic**
single-crystal + powder refinement, multi-phase, Le Bail extraction, magnetic
space-group candidate generation & comparison, and a real-space PDF track;
validated against the bundled GSAS-II refinements in `data/`
(30 K / 200 K / 350 K) and a local PDFfit2/PDFgui.

> **How to read this document:** §1–5 are the **historical validation record**
> from the first build passes — the golden-value comparisons there remain the
> foundation tests and still pass, but the "not yet" statements describe the
> state *at that time*. For current status see the [README](../README.md),
> [ROADMAP.md](./ROADMAP.md), and [LIMITATIONS.md](./LIMITATIONS.md); §6 lists
> what has landed since.

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
npm run test     # vitest (see §5 for the current counts)
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

## 3. Magnetic refinement (added with the 30 K / 200 K / 350 K data)

The new datasets are magnetic-structure refinements of Mn₃Ga: mCIF files (BNS
magnetic space groups with time-reversal symops and moment loops), `.lst`
outputs with refined moments, and `*_hkl.dat` reflection lists with GSAS Fo²/Fc².
This unlocked and validated the magnetic workflow:

- **mCIF parser** reads BNS operations (`x,y,z,+1` time-reversal notation) and the
  `_atom_site_moment.crystalaxis_*` loop into a `MagneticModel`.
- **Magnetic structure factor** transforms moments as axial vectors
  (`m' = θ·det(R)·R·m`), projects perpendicular to Q (`M⊥`), and sums with the
  p = 2.695 fm/μB prefactor (= γ_n·r_e/2, the constant usually quoted as
  0.2695 × 10⁻¹² cm; in fm because nuclear b is tabulated in fm). Nuclear and
  magnetic intensities are reported separately
  (`I = scale_N·|F_N|² + scale_M·|F_M⊥|²`).
- **Moment refinement** (single crystal) refines moment components; validated by
  recovering a perturbed moment from synthetic data and, in-browser, recovering
  Mn1 mₐ from −0.5 back to −1.577 μB.
- **UI**: a magnetic panel with moment arrows, per-reflection nuclear/magnetic/
  total intensities, and moment-parameter refinement; loading a magnetic CIF is
  auto-detected.

**Golden validation** (from `30K/.lst`): the refined moment **magnitudes**
Mn1 = 2.527, Mn2 = 2.829, Mn3 = 2.530 μB are reproduced exactly from the
crystal-axis components in the monoclinic (β = 60.69°) cell — confirming both the
mCIF parse and the moment-frame metric. BNS groups and operation counts
(P2₁'/m' → 4, Cm'cm' → 16) match.

**Still approximate:** we do not reproduce GSAS-II's absolute Fc² scale (TOF,
instrument, and normalization conventions differ), and magnetic *powder*
refinement (Phase 7) is not yet wired — only magnetic single-crystal.

## 4. Honest limitations

- **Rietveld comparison scope.** GSAS-II's own fit here is a two-phase TOF
  Rietveld with instrument profile functions (difC, α/β/σ coefficients),
  background, and profile terms beyond this minimal engine. We validate the
  shared foundations and self-consistency, **not** GSAS-II's wR (11.96 %).
- **Simplified physics (by design):** simplified structure-factor equation and a
  small (swappable) scattering table; isotropic ADPs only in calculation;
  Gaussian/pseudo-Voigt profiles with constant/polynomial background;
  constant-wavelength profiles only (TOF profile not modelled); local LM only
  (no global search).
- **Magnetic:** the model, projection, structure factor, and single-crystal
  moment refinement (with UI) are implemented and validated (§3). Magnetic
  *powder* refinement (Phase 7) is not yet wired. The non-orthogonal moment-frame
  convention (normalized crystal axes) is a documented simplification, validated
  against GSAS-II moment magnitudes.

Full detail in [LIMITATIONS.md](./LIMITATIONS.md). The scope statement appears
in the app UI, README, and limitations doc.

---

## 5. Test summary (current: 2026-07-19)

```
Test Files  153 passed | 9 skipped (162)
Tests       1072 passed | 59 skipped (1131)
```

Covering: linear algebra, unit-cell/metric/volume (GSAS golden), symmetry
parsing/multiplicity/absences (GSAS golden), scattering tables (GSAS golden),
nuclear structure factors (analytic golden), reflection generation, LM optimizer
+ constraints, magnetic projection & frames, CIF parsing (GSAS files), single-
crystal & powder workflow refinement, project round-trip, and plot math.

---

## 6. What has landed since (and what remains)

Since this report was first written: magnetic powder refinement (k = 0 and
k ≠ 0), the TOF back-to-back-exponential profile (the two-phase Mn₃Ga/MnO demo
converges at wR ≈ 3.9 %), the single-crystal F² workbench, refined CIF/mCIF
export with esds, one-click FullProf / GSAS-II cross-check export, opt-in
WebGPU structure-factor kernels, the real-space PDF track (PDFfit2-validated,
with the symmetry-mode distortion workflow), a validated mPDF core, and the
32-tool MCP agent layer. Remaining highlights (full ordering in
[ROADMAP.md](./ROADMAP.md)):

1. Single-crystal-mode and multi-phase FullProf `.pcr` export (powder is done).
2. Representation analysis and the star of k / multi-k magnetic workflow.
3. The mPDF page and the symmetry-constrained local-spin model (PDF roadmap P5).
