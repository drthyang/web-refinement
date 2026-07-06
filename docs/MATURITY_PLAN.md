# Maturity Plan

The road from this early workbench toward the capability level of GSAS-II,
Jana2020, and FullProf (see [COMPARISON.md](./COMPARISON.md)). Ordered by
value-to-effort, with the correctness-first, tested-in-TypeScript discipline
kept throughout. Each item names the concrete deliverable and its validation.

## Recently completed (this iteration)

- **Multi-phase powder** — sum phase contributions with per-phase scale/cell
  (`core/workflow/multiPhase.ts`); tested on a 2-phase Mn₃Ga+MnO pattern.
- **Le Bail intensity extraction** — `core/workflow/leBail.ts`; reconstructs the
  pattern and extracts per-reflection |F|².
- **Anisotropic displacement parameters** in the structure factor.
- **March-Dollase preferred orientation** — `marchDollase` in `intensity.ts`.
- **Magnetic powder refinement (Phase 7)** — combined nuclear+magnetic profile
  with separable components (`core/workflow/magneticPowder.ts`).
- **Grouped (equal-value) parameter constraints** (Phase 8).
- **TOF ↔ d conversion + instrument-file parsing** (`instrument.ts`), validated
  against the POWGEN calibration.
- **Magnetic candidate generation (k=0) + comparison** — the in-app analogue of
  the Bilbao→refine→rank workflow.

## Near term (highest value-to-effort)

1. **Built-in space-group tables (230) with standard settings.** Replace
   CIF-only symmetry with generators + Hermann-Mauguin lookup, Wyckoff
   positions, and automatic symmetry-constrained parameters. *Validate against
   International Tables generators.*
2. **Thompson-Cox-Hastings pseudo-Voigt + Caglioti U/V/W** and **Chebyshev /
   shifted-Chebyshev background.** *Validate FWHM(2θ) and background against
   analytic forms.*
3. **Full TOF profile** (back-to-back exponentials ⊗ pseudo-Voigt, α/β/σ) so the
   bundled POWGEN data can be fit end-to-end and compared to the GSAS-II wR.
4. **Analytic structure-factor derivatives** for the Jacobian (replaces finite
   differences) — the key performance and stability win.
5. **Multi-histogram / joint refinement** — one model, several datasets (e.g.
   X-ray + neutron), shared vs per-histogram parameters.

## Medium term

6. **Restraints library** — bond-length/angle soft constraints, and rigid
   bodies, with the geometry engine already in `crystal/geometry.ts`.
7. **Absorption & extinction** corrections.
8. **Spherical-harmonic preferred orientation / texture.**
9. **Built-in magnetic space-group tables (1651 BNS/OG)** with standard labels,
   so candidate generation reports "P2₁'/m'" rather than a primed-operation list,
   and cross-checks Bilbao/ISODISTORT identifiers.
10. **Non-zero / incommensurate propagation vectors** — magnetic supercell
    handling, then Fourier-coefficient (sine/helical/conical) moment models.

## Longer term

11. **Representation analysis** (irreducible representations of the propagation-
    vector group) as an alternative to the magnetic-space-group route — the
    BasIreps/SARAh capability.
12. **Superspace (3+d)** for incommensurate modulated nuclear structures.
13. **Structure solution** — charge flipping / simulated annealing.
14. **Scripting API** — a headless TypeScript/JS API mirroring GSASIIscriptable
    for batch and parametric/sequential refinement.
15. **WebAssembly / WebGPU acceleration** for structure-factor summation, profile
    convolution, and the normal-equations solve, once the TS core is analytic and
    broad.

## Guardrails

Every item ships with: passing tests (golden values where an external reference
exists), updated docs, and a working app with no broken intermediate state — the
same discipline as the phases so far. Scope claims stay honest: a feature is
"validated" only when [VALIDATION.md](./VALIDATION.md) records a test or external
comparison for it.
