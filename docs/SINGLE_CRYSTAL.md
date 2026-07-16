# Single-crystal refinement (M7)

The integrated-Bragg half of the "Rietveld *and* single-crystal" vision
([`ROADMAP.md`](./ROADMAP.md) §M7). It refines a structure against measured
single-crystal reflection intensities through the **same engine, symmetry
constraints, and scattering tables** as the powder path — only the observable
and its corrections differ. This document records what has landed, the design
logic that keeps it consistent with the rest of the app, and the forward plan
for an advanced absorption-correction tool.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## 1. Design logic — one engine, one constraint layer

The non-negotiable rule (Roadmap §1): a special-position atom is reduced to its
symmetry-allowed modes **once**, and both data types consume that reduction. The
single-crystal spec therefore calls the *same* constraint functions the powder
spec does:

| Concern | Shared function | Powder caller | Single-crystal caller |
| --- | --- | --- | --- |
| Independent cell parameters | `independentCellParameters` | `buildStructureRefinement` | `buildSingleCrystalSpec` |
| Symmetry-adapted positions | `allowedPositionShifts` | ″ | ″ |
| Symmetry-adapted anisotropic ADP | `allowedAnisotropicAdpModes` | ″ | ″ |
| Parameter → model application | `applyParameters` (`workflow/apply.ts`) | powder problems | single-crystal problem |
| Least-squares solve | `refine` (`refinement/engine.ts`) | all | all |

What differs is only the **observable and its corrections**, isolated in
`core/diffraction/singleCrystalFactors.ts` and assembled in
`core/workflow/singleCrystalRefinement.ts`.

### Units & conventions (kept identical across the app)

- **Intensities are F², not |F|.** Reflection intensities (`iObs`) and the model
  output are on the F² scale, matching SHELX HKLF 4 and `.fcf` LIST 4, GSAS-II
  `Fo²`, and the powder integrated intensities.
- **Scale multiplies F²** (SHELX "OSF"), same semantics as the powder histogram
  scale.
- **ADP:** isotropic `B` (Å², `T = exp(−B·s²)`) and symmetry-adapted anisotropic
  `U` (Å²) tensors — the identical `bIso`/`uAniso` parameter kinds and Debye–
  Waller code as powder.
- **Angles** in degrees at the UI/report boundary; radians internal.
- **Parameter-freeing convention:** scale (and extinction) free on the first
  "Refine"; structural rows (positions, ADP, occupancy) and the cell start
  **fixed**, freed per row or by the staged sequence in the expert order
  scale → cell → ADP → positions — the same "safe first click" behavior as
  `buildPowderSpec`.

---

## 2. What has landed ✅

### Reflection data reduction — `core/diffraction/merge.ts`
- **Laue-class equivalence** from the space-group operations (rotation parts,
  closed under Friedel inversion — exact for non-anomalous |F|²).
- **`mergeEquivalents`** collapses equivalents to a unique set at canonical
  representatives, weighted-mean intensity, merged σ = max(propagated, sample
  scatter), and reports **R_int**, **R_sigma**, **redundancy**.
- Validated: Friedel merging under P‑1, the full 48-rotation m‑3m Laue class for
  Fm‑3m, R_int = 0 for equal equivalents / 0.10 for a known discrepant pair, and
  a cubic {200} family collapsing to one unique reflection
  ([`merge.test.ts`](../src/core/diffraction/merge.test.ts)).

### Reflection I/O — `parsers/shelxHkl.ts`
- **SHELX HKLF 4** fixed-column parser (`3I4,2F8,I4` → h k l F² σ batch), with a
  whitespace fallback for hand-edited files and the `0 0 0` terminator honored.
- **`.fcf` / CIF reflection loops** (LIST 4 F² and LIST 6 F, the latter squared
  with σ propagation), column order taken from the loop header.
- Validated against fixed-column, batched, free-format, and both LIST variants
  ([`shelxHkl.test.ts`](../src/parsers/shelxHkl.test.ts)). The pre-existing
  free-form `parsers/hkl.ts` remains for the simple `h k l I σ` case.

### FullProf `.int` reader + writer ✅ — `parsers/fullprofInt.ts` (Phase 3)
- **Reader** (`parseFullProfInt`) for the `ABS(Irf)=4` integrated-intensity file:
  title / declared Fortran format / `R_lambda Itypdata Ipow` header, then
  fixed-width `h k l [nv] I σ [cod]` rows via the declared widths. **Propagation-
  vector variant**: a four-integer format (`4i…`) signals an `nv` column; the
  reader consumes the k-count + `nv k1 k2 k3` block and tags each reflection with
  its 1-based `kIndex` (satellite = **H + k_nv**, the addition convention). The
  writer's `-0` index artifact is normalised to `0`.
- **Malformed-file rejection**: every skipped row is recorded as
  `{line, expected, found}`; `{strict:true}` throws `line N: expected …, found …`
  (used by the paired-load path).
- **Writer** (`writeFullProfInt`) re-emits through the declared format —
  byte-identical round-trip on writer output, semantic round-trip on real files;
  throws when a value overflows its field. Used by the `.int` export and the MCP
  `write_single_crystal_data` tool.
- **Pairing convention**: a `<name>_mag.int` loaded while a nuclear dataset is
  present routes to the magnetic partner (App `onLoadData`), so a `_nuc`/`_mag`
  pair loads as one session; the header **`.int` export** writes the pair back
  with the same suffixes.
- **Magnetic-supercell merge** (`core/magnetic/magneticSupercell.ts`) — the field
  convention for single-k magnetic refinement. Both `_nuc.int` and `_mag.int` are
  indexed in the **nuclear** cell (the magnetic file's `h k l` is the fundamental
  of a satellite at `hkl + k`). `mergeToMagneticSupercell` converts both into the
  magnetic **supercell**, where k is an integer reciprocal-lattice vector:
  nuclear `(h,k,l) → (n·h)`, magnetic `→ (n·h) + K` with `nᵢ` the denominators of
  k and `Kᵢ = nᵢ·kᵢ`. The merged single dataset is then refined against the
  magnetic structure in the supercell. MCP: `merge_magnetic_supercell`. **UI**: with
  a `_nuc`/`_mag` pair loaded, the single-crystal page's "Merge to magnetic
  supercell" card takes k and replaces the active dataset with the merged one — the
  one magnetic co-refinement workflow (nuclear and magnetic peaks share ONE scale,
  same measurement, so there is nothing to weight between them). **Requires** the
  **supercell** structure loaded to refine (as FullProf's `.pcr` defines it) — a
  nuclear-cell structure would score the satellites against spurious nuclear |F|².
  Robustness: the moment fit uses `refineMagneticSingleCrystalMultiStart` (the
  single-dataset sibling of the powder escape-min path — freeze nuclear → seeded
  moment multi-start → final LM → ±m canonicalize), with the magnetic scale tied to
  the nuclear scale, validated on a synthetic AFM supercell
  ([`magneticSupercellRefine.test.ts`](../src/workers/magneticSupercellRefine.test.ts)).
- Validated: nuclear + k-variant parse, `-0` normalisation, line-numbered
  problems, strict rejection, writer round-trips
  ([`fullprofInt.test.ts`](../src/parsers/fullprofInt.test.ts)). **Real-data
  golden (Eu₃In₂Te₄, k = (¼,0,¼))**: the reader parses the `_nuc`/`_mag`/`_ALL`
  HB-3A files with zero problems, and the merge reproduces the reference
  `_ALL_magcell.int` byte-exactly on every `(h,k,l,I,σ)`
  ([`magneticSupercell.test.ts`](../src/core/magnetic/magneticSupercell.test.ts),
  data-gated on `data/fullprof_int_handles/`).
- **Still pending external validation:** the explicit **k-vector-header** reader
  variant (count + `nv k1 k2 k3` block) — real files use the merge convention
  above rather than the header, so no golden exercises it; export a k-header file
  and cross-check in FullProf before relying on that path.

### Corrections & agreement — `core/diffraction/singleCrystalFactors.ts`
- **Single-crystal Lorentz** `L = 1/sin2θ` (TOF → 1), **polarization**
  (X-ray, shared split with powder), and **secondary extinction** (SHELXL EXTI,
  `y = [1 + 0.001·x·F²·λ³/sin2θ]^(−1/2)`).
- **SHELX F² weights** `w = 1/[σ²(Fo²) + (aP)² + bP]`, `P = [max(Fo²,0)+2Fc²]/3`.
- **Agreement factors** `R1`, `wR2`, `GooF` with the Fo² > nσ observed cutoff.
- Validated by hand computations and perfect-fit zeros
  ([`singleCrystalFactors.test.ts`](../src/core/diffraction/singleCrystalFactors.test.ts)).

### Refinement assembly — `core/workflow/singleCrystalRefinement.ts`
- **`buildSingleCrystalSpec`** — scale, symmetry-reduced cell, per-site ADP,
  symmetry-adapted positions, occupancy, optional extinction; shared-site tying.
- **`buildSingleCrystalRefinementProblem`** — `I_calc = k·L·P·y·|F|²`,
  σ-weighted, straight into the LM engine.
- **`singleCrystalRefinementComparison`** — obs/calc rows with **standardized
  residuals** (Fo²−Fc²)/σ for outlier diagnosis, plus R1/wR2/GooF.
- Validated: scale recovery from a wrong start, displaced-atom recovery with
  wR2/R1 → ~0, residual reporting
  ([`singleCrystalRefinement.test.ts`](../src/core/workflow/singleCrystalRefinement.test.ts)).

### Magnetic single-crystal refinement ✅ — the single-k supercell merge
- **One measurement, one scale.** Nuclear and magnetic Bragg peaks come from the
  same crystal/beam/normalisation, so they share a single overall scale — there is
  no relative scale or weight to tune between them. The commensurate single-k
  structure is refined from ONE FullProf `.int` in the magnetic supercell, formed
  by merging the `_nuc` + `_mag` nuclear-cell files (see the reader/writer entry
  above and `core/magnetic/magneticSupercell.ts`).
- **`buildMagneticSingleCrystalProblem`** (`core/workflow/magnetic.ts`) — the
  single-dataset forward model `I = k·(|F_N|² + |F_M⊥|²)` (unpolarized ⇒ no
  interference); `magneticScale` is tied to the nuclear `scale` so k_M = k_N (else
  the moments come out wrong by √k). |F_M⊥|² is the Halpern–Johnson M⊥Q projection
  with the ⟨j0⟩ form factor and 2.695 fm/µ_B prefactor, on the nuclear fm scale.
- **`refineMagneticSingleCrystalMultiStart`** (computeClient) — the single-dataset
  escape-min sibling of the powder path: freeze nuclear → seeded moment multi-start
  → final LM → ±m canonicalize + degeneracy report. MCP:
  `parse_single_crystal_data`, `merge_magnetic_supercell`, `write_single_crystal_data`.
  UI: the "Merge to magnetic supercell" card in `SingleCrystalWorkbench`, then the
  magnetic-analysis moment fit (refine against the supercell structure).
- Validated (synthetic AFM supercell): moment + shared-scale recovery from a bad
  cold start, determinism, and the even-h-nuclear / odd-h-magnetic separation of a
  merged file ([`magneticSupercellRefine.test.ts`](../src/workers/magneticSupercellRefine.test.ts)).
  Reflection merge validated byte-exactly against the real Eu₃In₂Te₄ golden (see
  the reader/writer entry). Methods: [`REFINEMENT_NOTES.md`](REFINEMENT_NOTES.md) §8.

### Still needed for M7 to be "done"
- ⬜ **UI page** mirroring the powder one (load HKL → confirm space group → merge
  report → free params → refine → Fo vs Fc, R1/wR2/GooF, outlier list).
- ⬜ **Completeness** vs a generated theoretical unique set to a resolution shell
  (the merge stats expose the hook; the generator wiring is pending).
- ⬜ **Twinning** (batch scale factors / TWIN–BASF) and **anomalous dispersion**
  (f′, f″; Friedel-pair splitting for absolute structure).
- ⬜ **Full WGHT scheme** — iterative a,b reweighting on Fc² (currently σ-only in
  the solve; a,b honored in the reported wR2/GooF).
- ⬜ **Absorption correction tool** — the major forward piece, planned in §3.
- ⬜ **Validation gate:** reproduce a published F² refinement (SHELXL/GSAS-II)
  within tolerance on a real HKL file.

---

## 3. Forward plan — advanced absorption correction (WinGX-class and beyond)

The goal: a single-crystal absorption tool in the spirit of WinGX's *ABSPACK/
SORTAV/face-indexed* suite, but **more advanced** — every method under one
consistent model, driven from crystal shape *or* redundancy, with honest error
propagation into the merged σ. Absorption is the correction that most often
limits data quality on heavy-element crystals, so it earns first-class status
rather than a single μR knob.

The transmission we correct is `A* = 1/T`, with `T = (1/V)∫exp[−μ(r_in + r_out)]dV`
over the crystal volume, μ the linear absorption coefficient, and r_in/r_out the
incident/diffracted path lengths for each reflection's geometry.

### 3.1 μ from composition ⬜ (foundation for every analytical method)
- Compute μ (mm⁻¹) from the unit-cell contents and wavelength: `μ = (1/V)·Σ nᵢ·
  σ_abs,ᵢ` using tabulated mass-absorption coefficients μ/ρ (X-ray) or absorption
  cross-sections (neutron, with the 1/v wavelength scaling). New scattering table
  alongside the existing `b`/Cromer–Mann/magnetic tables, same replaceable-
  interface pattern (`core/scattering/`).
- Report μ, μ·r̄ (dimensionless), and a suggested method by regime.

### 3.2 Shape-based analytical (Gaussian grid integration) ⬜ — the WinGX core, done right
- **Face-indexed crystal model:** input crystal faces as {hkl, distance} (the
  bounding planes), building a convex polyhedron. This is the SHELX/WinGX
  "face-indexed numerical" input.
- **Gaussian quadrature** over the polyhedron (the Busing–Levy / de Meulenaer–
  Tompa method): triangulate the volume, integrate `exp[−μ(r_in+r_out)]` on a
  Gauss grid per reflection direction. Adaptive grid density with a stated
  convergence tolerance — the "more advanced" part: the classic 8×8×8 grid is
  fixed; we refine until A* stabilises.
- **Exact geometry from the diffractometer setting** (φ, χ, ω or a supplied
  orientation matrix) so r_in/r_out are physical, not approximated.

### 3.3 Simple-shape closed forms ⬜ (fast path / sanity check)
- **Spherical** (`A*(μR, θ)` from the International Tables C interpolation) and
  **cylindrical** (extending the Debye–Scherrer `cylinderAbsorption` already in
  `diffraction/intensity.ts` to the single-crystal geometry). Useful when the
  crystal is ground to a sphere or is a needle, and as a cross-check on §3.2.

### 3.4 Empirical / multi-scan ⬜ — the redundancy-driven path (SADABS/SORTAV-class)
- **Spherical-harmonic** transmission surface `A*(θ_in, φ_in, θ_out, φ_out)`
  expanded in real symmetric harmonics, fit by **minimizing the disagreement
  between symmetry-equivalent and multiply-measured reflections** — i.e. it plugs
  straight into `mergeEquivalents`, minimizing R_int over the batch/scan-tagged
  data already carried through the parser (`Reflection2.batch`).
- Joint refinement of **per-batch scale factors** with the harmonic coefficients
  (the SADABS model), Tmax/Tmin reported, outliers flagged via the standardized
  residuals the comparison already emits.
- This is where "more advanced" pays off: the empirical surface and the
  analytical μ from §3.1 can be **combined** (analytical shape + residual
  empirical for beam inhomogeneity / absorption by the mount), which most tools
  make an either/or.

### 3.5 Integration & UX ⬜
- A correction returns a per-reflection `A*` multiplied into `iObs` *before*
  merging, with σ propagated, so R_int **measures** the correction's quality —
  the tool's own feedback loop.
- One panel: pick method by regime (μr̄ small → skip / spherical; well-formed
  crystal → face-indexed Gaussian; high redundancy → multi-scan), show
  Tmax/Tmin, R_int before/after, and the transmission surface as a plot.
- **Tool exposed:** `correct_absorption(reflections, {method, crystal|faces|µ}) →
  corrected reflections + Tmax/Tmin + ΔR_int`, composing with `load_hkl` and
  `refine_single_crystal`.

### Sequencing
μ-from-composition (§3.1) → spherical/cylindrical closed forms (§3.3, cheap, and
validate μ) → face-indexed Gaussian (§3.2, the WinGX-parity core) → multi-scan
harmonics (§3.4, needs the batch-scaling refinement) → combined analytical+
empirical (§3.5). Each lands with a golden-value test (International Tables C
spherical A* values; a published face-indexed dataset; a multi-scan R_int drop).

---

## 4. References

- G. M. Sheldrick, *Acta Cryst.* A64 (2008) 112; C71 (2015) 3 — SHELX F²
  refinement, HKLF/FCF formats, EXTI, WGHT.
- R. H. Blessing, *Acta Cryst.* A51 (1995) 33 — data reduction, R_int, empirical
  absorption (SORTAV).
- L. J. Farrugia, *J. Appl. Cryst.* 32 (1999) 837; 45 (2012) 849 — WinGX.
- P. Coppens, in *Crystallographic Computing* (1970) — analytical (Gaussian-grid)
  absorption; W. R. Busing & H. A. Levy, *Acta Cryst.* 10 (1957) 180.
- *International Tables for Crystallography* Vol. C — mass-absorption
  coefficients, spherical/cylindrical A* tables, Laue classes.
