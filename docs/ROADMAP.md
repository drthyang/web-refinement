# Roadmap

The single, authoritative plan for Materia Workbench. It supersedes
the earlier `ROADMAP`, `POWDER_ROADMAP`, and `MATURITY_PLAN` docs (the last two
are kept for their granular detail in [`archive/`](./archive/)).

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## 1. Vision

Build a **traditional refinement package** — weighted non-linear least squares,
Rietveld and single-crystal, atomic then magnetic — that runs entirely in the
browser on a pure-TypeScript, framework-free core. Then expose every capability
as an **agent tool / skill**, so the same validated functions can be driven
either by a person in the UI or by an agent reasoning about a structure.

Two principles hold throughout:

- **Correctness first, in TypeScript.** No WebAssembly/WebGPU, no global-search
  shortcuts, and no feature claimed "validated" until a test or external
  comparison records it. `src/core/**` stays pure and side-effect-free — which
  is exactly what makes it both testable *and* tool-callable.
- **One engine, many workflows.** A constrained weighted least-squares engine is
  the foundation; single-crystal, powder, atomic, and magnetic all plug into it.
  Everything else is a parameterization or a corrections term on top.

The north-star design rules live in
[`../knowledge/refinement_fitting_algorithms_knowledge.md`](../knowledge/refinement_fitting_algorithms_knowledge.md):
never refine everything at once, never ignore parameter correlations, refine
only symmetry-allowed parameters, use global search only for starting models.

### The build sequence, in one line

> **Foundations (F1 robust engine · F2 symmetry constraints)** →
> **M1 atomic structure refinement** → **M2 magnetic k-vector search** →
> **M3 magnetic space-group analysis** → **M4 magnetic structure refinement** →
> **M5 ship the results**, with the **agent-tools/skills layer** exposed
> incrementally as each milestone lands.

---

## 2. Current state (honest baseline)

What genuinely works today (536 passing tests; real-data validated):

- **Refinement engine** — Levenberg–Marquardt with diagonal preconditioning,
  SVD-truncated pseudo-inverse, per-cycle shift limiting, bound projection,
  exact one-evaluation Jacobian columns for linear parameters, and
  covariance/esd + correlation/singular-direction reporting.
  ([`refinement/engine.ts`](../src/core/refinement/engine.ts))
- **Staged structure refinement** — the expert unlock order
  (scale → background → cell → profile → ADP → positions) driven by
  [`workflow/structureRefinement.ts`](../src/core/workflow/structureRefinement.ts).
  Genuine Rietveld structure refinement, not just scale/width/cell.
- **Symmetry-adapted parameters** — a single null-space method emits the allowed
  modes for positions, anisotropic ADPs, magnetic moments, and the cell metric
  from the parsed operation list
  ([`crystal/siteConstraints.ts`](../src/core/crystal/siteConstraints.ts) and siblings).
- **Powder physics** — Chebyshev / cosine (Fourier) / power-series backgrounds,
  Caglioti U/V/W width, zero-shift, pseudo-Voigt, Le Bail extraction, multi-phase,
  March–Dollase preferred orientation, Debye–Scherrer absorption, TOF↔d +
  `.instprm` parsing.
- **Scattering tables** — neutron `b` (52 elements), Cromer–Mann X-ray
  (14 elements), and the **full ITC-C magnetic form-factor table** (⟨j0⟩ for
  97 ions, ⟨j2⟩ for 95, generated from the public-domain CrysFML data) centralized
  in [`scattering/`](../src/core/scattering/) behind replaceable interfaces, so
  spin-only *and* dipole (`g ≠ 2`) magnetic form factors are ready for M4. See
  [`SCATTERING_TABLES.md`](./SCATTERING_TABLES.md).
- **Magnetic (k = 0)** — moment projection, magnetic structure factor, magnetic
  powder + single-crystal refinement, and honest **k = 0 magnetic space-group
  candidate generation** (GF(2) homomorphism enumeration) with candidate
  comparison ([`magnetic/magneticGroups.ts`](../src/core/magnetic/magneticGroups.ts)).
- **Validation** — GSAS-II golden values; the real GaNb₄Se₈ 28-ID synchrotron
  XRD regression reaches wR ≈ 36.5% (see [`archive/POWDER_ROADMAP.md`](./archive/POWDER_ROADMAP.md)).

The rest of this document is what is **not** done, ordered.

---

## 3. Foundations — the two bottlenecks (gate everything)

These are coupled: **F2 produces the reduced parameter vector that F1
optimizes.** A special-position atom must never refine raw x/y/z independently;
F2 hands F1 the symmetry-allowed modes, F1 solves them robustly. Both must be
solid before the milestones can be trusted.

### F1 — Robust refinement algorithm

The engine is capable but still fragile on hard real data. Close these, in order:

1. **Analytic derivatives for the crystallographic model** ⬜ — the single
   biggest stability + speed win. Today every non-linear parameter uses a central
   finite difference (2 model evaluations/column). Add exact columns for
   coordinates, occupancies, B_iso, cell, profile width, zero-shift, and moment
   components (analytic where practical, validated against finite differences).
2. **Reflection-window evaluation + dependency caching** ⬜ — accumulate each
   reflection only over its local `±n·FWHM` window, and invalidate caches by
   dependency (cell → d-spacings; positions → structure factors; scale → reuse
   everything). Turns dense global sums into sparse local ones; prerequisite for
   larger problems and for analytic Jacobian columns.
3. **Robust automatic starting values** ⬜ — auto-scale (✅), plus
   auto-background from the data's lower envelope and a zero-shift/peak-position
   sanity check, so refinement does not start in a false basin.
4. **Dual convergence + automated staged controller** 🚧 — converge on *both*
   Δχ² and max parameter shift; the staged controller exists
   ([`refinement/staged.ts`](../src/core/refinement/staged.ts)) but should reject
   parameter additions that raise esds or blow up correlations.
5. **Automated next-parameter diagnostic** ⬜ — rank inactive parameter groups by
   expected χ² improvement (perturb ±δ, measure residual sensitivity). This is
   also the **first agent-in-the-loop hook** (see §5).
6. **Optional global search for starting models** ⬜ — Monte Carlo / simulated
   annealing, *only* to generate candidates (bad initial model, magnetic
   sign/phase ambiguity), never as the main engine. Feeds M2 and M4.

*Validation gate:* the GaNb₄Se₈ regression tightens toward the GSAS-II wR;
analytic-vs-finite-difference Jacobian agreement test; SVD duplicate-parameter
suppression test.

### F2 — Symmetry-constrained parameterization

The null-space constraint machinery is correct but is only ever as good as the
**parsed CIF operation list**. To make constraints trustworthy and complete:

1. **Built-in space-group tables** 🚧 — generators + Hermann–Mauguin/number
   lookup, replacing CIF-only symmetry. **Landed:** a group-closure engine
   (`generators → full operation list`) and a verified seed table — P1, P-1,
   P2₁/c, F-4̄3m, Fm-3̄m — with `buildSpaceGroup(id)` and a `completeSpaceGroup`
   hook that closes partial CIF op-lists ([`crystal/spaceGroups.ts`](../src/core/crystal/spaceGroups.ts)).
   Validated by group order, the closure property, special-position
   multiplicities, and an exact operation-set match to the real F-4̄3m CIF.
   **Remaining:** **Wyckoff-position enumeration** (letters, site symmetry,
   canonical coordinates), full 230-group coverage, and standard settings.
2. **Systematic-absence generation** ⬜ — derive allowed reflections from the
   group rather than only from the supplied operation list. (The per-operation
   absence test already exists in [`crystal/symmetry.ts`](../src/core/crystal/symmetry.ts);
   this drives it from the built-in group.)
3. **Unified constraint-transform layer** 🚧 — document and consolidate the
   existing "emit reduced modes" mechanism as *the* single constraint path
   (`raw = transform(free)`), covering positions, ADPs, occupancy ties/groups,
   moments, and rigid bodies.
4. **Setting/origin transforms** ⬜ — convert between standard and non-standard
   settings so external CIFs load into a known frame (needed before M3's subgroup
   derivation is reliable).

*Validation gate:* Wyckoff assignment and special-position constraints match
International Tables for a spread of groups (incl. F-4̄3m used by GaNb₄Se₈).

---

## 4. Milestones — the arc

Each milestone: **goal · what exists · what's needed · validation gate · the
agent tool it exposes.**

### M1 — Atomic structure refinement (robust) 🚧

- **Goal:** reliable, well-diagnosed convergence on any good-starting-model
  nuclear structure + single-crystal or powder data.
- **Exists:** staged Rietveld refinement; symmetry-adapted positions/ADP; real
  GaNb₄Se₈ data at **wR ≈ 10.4%** (close to GSAS-II's 7.34%).
- **Benchmark (GaNb₄Se₈ 298.8 K, identical data):** GSAS-II reaches **wR ≈ 7.34%**.
  Benchmarking against its extracted calc + reflection list ([`gsasBenchmark.test.ts`](../src/core/workflow/gsasBenchmark.test.ts))
  exposed **two major computation bugs**, both now fixed: (1) the nuclear
  structure factor summed over *all* space-group operations, over-counting a
  special position by its site-symmetry order — so with different site symmetries
  (Nb/Se on 3m, Ga on -4̄3m) the *relative* intensities were wrong by up to ~5×
  (our |F|²/GSAS Fc² now matches to <1.5×, guarded by
  [`sfDiagnostic.test.ts`](../src/core/diffraction/sfDiagnostic.test.ts)); and
  (2) the Lorentz factor was left off for this raw 2θ histogram. Fixing both drove
  the staged fit from ~63% to **10.4%**. Also landed toward matching GSAS-II's
  shape functions: a **Thompson–Cox–Hastings pseudo-Voigt** (Gaussian U/V/W +
  Lorentzian X/Y) and **Finger–Cox–Jephcoat** axial asymmetry.
- **Needed (in priority order):** close the last ~3% to 7.34% — wire the TCH+FCJ
  profile and polarization into the staged app flow (they exist in the core);
  then F1 + F2; full TOF profile (back-to-back exponentials) so the POWGEN data
  fits end-to-end; and **refined-structure presentation** (atom table with esds,
  geometry, obs/calc/difference plot, 3D view).
- **Validation gate:** drive `gsasBenchmark.test.ts` wR down toward GSAS-II's
  7.34%; synthetic displaced-atom recovery; multi-histogram (X-ray + neutron)
  joint refinement of one model.
- **Tool exposed:** `refine_structure(model, data, options) → refined model +
  agreement factors + diagnostics`.

### M2 — Magnetic k-vector search 🚧

- **Goal:** given a nuclear structure and observed magnetic reflections (extra
  peaks not indexed by the nuclear cell), find the propagation vector(s) **k**.
- **Exists:** a **commensurate single-k search** ([`magnetic/kSearch.ts`](../src/core/magnetic/kSearch.ts))
  — scans a rational grid + high-symmetry BZ points, predicts satellites at
  G ± k, and ranks candidates by matched-peak count → position RMSD → simplicity.
  Recovers a known k and distinguishes (½,0,0) from (0,0,½) in a non-cubic cell
  ([`kSearch.test.ts`](../src/core/magnetic/kSearch.test.ts)); wired into the
  Candidates step. Standard powder k-search (FullProf `k_search`; Bertaut 1968).
  **Validated end-to-end on real data:** the full M2 pipeline (6 K − paramagnetic
  difference → extra-peak detection → k-search) recovers **k = (½,0,0)** for the
  AWO₄ high-entropy tungstate from real POWGEN neutron data
  ([`realAwo4Magnetic.test.ts`](../src/core/workflow/realAwo4Magnetic.test.ts)).
- **Needed:** scoring by magnetic *intensity* (Le Bail), not just position;
  incommensurate / multi-k handling; a commensurate/incommensurate flag.
- **Validation gate:** ✅ recovers k for a known AFM at a zone boundary (synthetic
  *and* real AWO₄ 6 K neutron data); Γ returns no match for genuinely magnetic
  peaks. Intensity-scored gate still open.
- **Tool exposed:** `search_propagation_vector(nuclear, magnetic_peaks) →
  ranked k candidates`.

### M3 — Magnetic space-group / symmetry analysis 🚧

- **Goal:** given the parent group and k, enumerate the allowed magnetic symmetry
  and the **allowed moment basis** (the parameters M4 will refine).
- **Exists:** k = 0 candidate generation + null-space allowed-moment directions;
  and now the **little group of k** G_k (Rᵀ·k ≡ k mod 1) with its **time-reversal
  (GF(2)) magnetic subgroups** for any commensurate k
  ([`magneticGroups.ts`](../src/core/magnetic/magneticGroups.ts): `littleGroup`,
  `generateMagneticCandidatesForK`), reducing to the k = 0 set at Γ. Reference:
  Bradley & Cracknell (1972) §3.7. **Now also the representation-analysis (irrep)
  route** for abelian little co-groups: a by-construction irrep generator +
  Γ_mag decomposition + basis-mode projection, shown in the Magnetic panel
  ([`irreps.ts`](../src/core/magnetic/irreps.ts)) — the BasIreps/SARAh capability
  for triclinic/monoclinic/orthorhombic, cyclic, and general-k cases.
- **Done since:** standard **BNS/OG labels** — a candidate reads "P2₁'/m' ·
  BNS 11.54 · OG 11.5.63" via exact operation-set matching against the bundled
  ISO-MAG table ([`bnsOg.ts`](../src/core/magnetic/bnsOg.ts), types I/III).
  **The full magnetic subgroup lattice** — every subgroup H ≤ G_k with every
  θ: H → ±1 (not only the maximal index-2 candidates), grouped by index and by
  conjugacy class with domain counts, k-SUBGROUPSMAG-style
  ([`subgroupLattice.ts`](../src/core/magnetic/subgroupLattice.ts)).
  **SARAh-style irrep combinations → named isotropy subgroup** — tick one or
  several irreps; the exact stabilizer of a generic combination is computed and
  identified as the implied OG/BNS group, bridging the two routes
  ([`isotropy.ts`](../src/core/magnetic/isotropy.ts)). **Setting-search
  identification** — non-standard-setting subgroups get their correct standard
  symbol through ITA basis transformations (24 proper axis permutations ×
  ¼-grid origin shifts), with the transformation reported
  (`identifyMagneticGroupAnySetting` in [`bnsOg.ts`](../src/core/magnetic/bnsOg.ts)).
- **Needed:** irrep tables for **non-abelian** little co-groups and the
  **projective small representations** for non-symmorphic BZ-boundary k (the
  decomposition already flags when these are required); the **star of k**
  (multi-arm domains) with the type-IV (anti-translation) groups.
- **Validation gate:** little group + allowed moments match Bilbao/ISODISTORT for
  known cases; k = 0 path reproduces today's candidate set.
- **Tool exposed:** `enumerate_magnetic_symmetry(parent, k) → candidate groups +
  moment bases (+ standard labels)`.

### M4 — Magnetic structure refinement 🚧

- **Goal:** refine **moment basis-mode amplitudes** (never raw M_x/M_y/M_z) for
  each M3 candidate against magnetic data, and rank candidates by fit *and*
  physical plausibility.
- **Exists:** k = 0 magnetic powder + single-crystal moment refinement; candidate
  comparison; a moment-magnitude recovery test. **Now also the k ≠ 0 core:** a
  single-k **Fourier-coefficient magnetic structure factor**
  ([`magnetic/fourierMoment.ts`](../src/core/magnetic/fourierMoment.ts)) that
  carries a *complex* coefficient S_j per site — so SDW (real S), circular helix
  (S_Re ⊥ S_Im, equal magnitude), and elliptical/cycloidal fall out — computes the
  satellite structure factor at H ± k with the per-atom phase and the M⊥
  projection, and refines **symmetry-adapted mode amplitudes** through the LM
  engine. The **validation gate below is met** (helix + two-site SDW amplitude
  recovery, [`fourierMoment.test.ts`](../src/core/magnetic/fourierMoment.test.ts)).
  This closes the gap where the old real-moment path could only do *collinear*
  commensurate structures.
- **Needed:** wire the Fourier model into the powder/single-crystal workflow +
  worker paths (replacing the collinear-only real-moment satellite intensity in
  [`magneticPowder.ts`](../src/core/workflow/magneticPowder.ts)) and connect it to
  the M3 irrep/basis output so amplitudes come from symmetry, not by hand;
  magnetic-supercell bookkeeping and multi-arm (star of k) domains; use F1's
  global search to resolve sign/phase ambiguity; candidate ranking with
  correlation-aware diagnostics (the engine already produces them; the ranker
  ignores them).
- **Validation gate:** ✅ recover a known basis-mode amplitude for k ≠ 0
  (`fourierMoment.test.ts`). Still open: ranked candidates put the true magnetic
  structure first on a golden case.
- **Tool exposed:** `refine_magnetic(candidate, data) → refined moments + fit`;
  the **"magnetic structure determination" skill** chains M2 → M3 → M4.

### M5 — Ship the results 🚧

- **Goal:** reproducible, publishable, machine-readable outputs.
- **Exists:** versioned project JSON round-trip; agreement factors; refinement
  history; assorted exporters.
- **Needed:** **refined CIF / mCIF export** (cell, positions, occ, ADPs, moments
  + esds) that external tools can read; a **report generator** (atom table,
  geometry, plots, correlation/failure-mode summary); and a **headless scripting
  API** mirroring `GSASIIscriptable` — which is also the substrate the agent
  tools sit on (§5).
- **Validation gate:** CIF/mCIF round-trip; an external tool (VESTA/GSAS-II)
  reads the exported files.
- **Tool exposed:** `export_cif(model) `, `generate_report(result)`.

### M6 — Powder microstructure & texture 🚧

- **Goal:** turn the profile and intensities into the *microstructure* a
  materials study reports — quantitative crystallite size, microstrain, and
  preferred orientation / texture — not merely a lower wR.
- **Exists:** isotropic size + microstrain (TCH Lorentzian `X`/`Y`), single-axis
  **March–Dollase** preferred orientation, Debye–Scherrer cylinder absorption
  ([`profile.ts`](../src/core/diffraction/profile.ts),
  [`intensity.ts`](../src/core/diffraction/intensity.ts)); **secondary
  extinction** (SHELXL EXTI, shared with M7). **Now also, landed:**
  - **Size–strain extraction + instrument deconvolution**
    ([`microstructure.ts`](../src/core/diffraction/microstructure.ts)):
    Scherrer ⟨D⟩ = 18000·K·λ/(π·X) and Williamson–Hall ε = π·Y/72000 from the
    refined Lorentzian terms (GSAS-II-consistent), Lorentzian-breadth instrument
    subtraction, esd propagation, and a model-independent Williamson–Hall
    linear-fit variant.
  - **Anisotropic microstrain — Stephens (1999)**
    ([`anisoStrain.ts`](../src/core/diffraction/anisoStrain.ts)): the S_HKL
    quartic-variance model, with the symmetry-allowed terms **computed** by
    projecting the 15 quartic monomials onto the Laue group (Reynolds projector)
    — reproduces Stephens' counts for every class (incl. hexagonal/trigonal)
    from the operations alone. Gaussian broadening added in quadrature.
  - **Anisotropic size — uniaxial/spheroidal**
    ([`anisoSize.ts`](../src/core/diffraction/anisoSize.ts)): X(hkl) = X_⊥ +
    (X_∥−X_⊥)·cos²ψ about a unique axis (ψ from the reciprocal metric), a strict
    generalisation of the isotropic Scherrer term.
  - **Refinement integration**: new `stephensStrain`/`anisoSizePerp`/
    `anisoSizePar` parameter kinds through `applyParameters` → `placePeaks`
    (hkl-dependent, cached invariants), emitted by `buildStructureRefinement` and
    unlocked by a new **microstructure** stage; grouped under "Microstructure" in
    the parameter tables. Design + formulas + references in
    [`MICROSTRUCTURE.md`](./MICROSTRUCTURE.md).
- **Needed:** spherical-harmonic (full ellipsoidal) size; **general texture** —
  a spherical-harmonic ODF beyond single-axis March–Dollase; **microabsorption**
  (Brindley) and flat-plate absorption; a size–strain **report + UI** (⟨D⟩, ε
  with esds, Williamson–Hall plot).
- **Validation gate:** recover a known size/strain from a NIST line-profile
  standard (LaB₆ 660); March–Dollase and Stephens coefficients matched against
  GSAS-II on the same pattern. (Formula-level constants ✅ vs GSAS-II; real-
  standard gate open.)
- **Tool exposed:** `refine_microstructure(model, data)` (✅ core),
  `extract_size_strain(result) → {⟨D⟩, ε}` (✅ core), `refine_texture(model, data)`
  (planned).

### M7 — Single-crystal refinement 🚧

- **Goal:** refine a structure against **integrated single-crystal Bragg
  intensities** (F² or F) through the same engine, symmetry constraints, and
  (for magnetic) moment machinery as powder — the second half of the "Rietveld
  *and* single-crystal" vision (§1).
- **Exists:** the computational core plus the **F² refinement layer** are in
  place and tested. Beyond the original `SingleCrystalDataset` model and
  nuclear/magnetic structure-factor + problem builders
  ([`workflow/singleCrystal.ts`](../src/core/workflow/singleCrystal.ts)), the M7
  build added: **Laue-class equivalent merging** with R_int / R_sigma /
  redundancy ([`diffraction/merge.ts`](../src/core/diffraction/merge.ts));
  **SHELX HKLF 4 + `.fcf`/CIF reflection I/O**
  ([`parsers/shelxHkl.ts`](../src/parsers/shelxHkl.ts)); the **single-crystal
  Lorentz–polarization + secondary-extinction corrections** and **SHELX F²
  weights + R1/wR2/GooF agreement**
  ([`diffraction/singleCrystalFactors.ts`](../src/core/diffraction/singleCrystalFactors.ts));
  and the **full F² refinement spec + problem builder + obs/calc comparison with
  standardized-residual outlier diagnostics**, assembled from the *same*
  symmetry-constraint layer as the powder path
  ([`workflow/singleCrystalRefinement.ts`](../src/core/workflow/singleCrystalRefinement.ts)).
  Validated by scale + displaced-atom recovery (wR2/R1 → ~0) and format/merge
  golden cases. Design logic, units, and the fixed-on-load convention are in
  [`SINGLE_CRYSTAL.md`](./SINGLE_CRYSTAL.md).
- **Needed:**
  - **Workflow + UI** — a single-crystal page mirroring the powder one
    (load hkl → assign/confirm space group → merge report → free parameters →
    refine → F_obs vs F_calc, wR2/R1, GoF), with per-reflection outlier
    diagnostics (the core comparison already returns them).
  - **Completeness** vs a generated theoretical unique set; **twinning**
    (batch/BASF) and **anomalous dispersion** (f′/f″, absolute structure); the
    **iterative WGHT** a,b reweighting in the solve.
  - **Absorption correction tool** — WinGX-class and beyond (μ from composition,
    face-indexed Gaussian-grid analytical, spherical/cylindrical closed forms,
    multi-scan spherical-harmonic empirical driven by R_int). Full forward plan
    in [`SINGLE_CRYSTAL.md`](./SINGLE_CRYSTAL.md) §3.
- **Validation gate:** reproduce a published single-crystal refinement (F²
  wR2 / R1) within tolerance; cross-check against SHELXL / GSAS-II on the same
  hkl file.
- **Tool exposed:** `load_hkl(file)` (✅ parser), `refine_single_crystal(model, hkl)`
  (✅ core), `correct_absorption(reflections, options)` (planned, §3).

*M6 and M7 are extensions of the atomic→magnetic spine (M1–M5), not gates on it:
both reuse the same engine, symmetry, and scattering core, so they can be built
in parallel with — or after — the magnetic arc, whichever a real dataset needs
first.*

---

## 5. Agent-tools, skills & LLM-guided refinement (cross-cutting)

The reason the core is kept pure and JSON-serializable: **each workflow function
becomes a callable tool, and the milestones define the tool surface.** This layer
is not a separate system built at the end — it is exposed incrementally as each
milestone stabilizes. The full design lives in
[`AGENT_TOOLS.md`](./AGENT_TOOLS.md); the summary:

- **Tool surface** mirrors §4: `load_structure` / `load_data` / `build_refinement`
  / `refine_structure` (M1) · `search_propagation_vector` (M2) ·
  `enumerate_magnetic_symmetry` (M3) · `refine_magnetic` (M4) · `export_cif` /
  `generate_report` (M5) · `refine_microstructure` / `extract_size_strain` /
  `refine_texture` (M6) · `load_hkl` / `refine_single_crystal` (M7) ·
  `diagnose` (correlations, singular directions).
  Deliverable as an **MCP server**, **Claude Agent SDK** tool definitions, or an
  in-browser tool registry (a chat panel calling the same functions the buttons do).
- **First agent-in-the-loop hook:** F1.5's automated next-parameter diagnostic —
  an agent can call it to decide what to unlock next, driving the staged
  controller with crystallographic judgment.
- **Skills** chain tools with expert prompts: a *guided Rietveld* skill (M1), a
  *magnetic structure determination* skill (M2 → M3 → M4).
- **LLM AI-guided refinement:** an observe → decide → act → check loop where the
  LLM *plans and sequences* (which parameters to free, which stage, which
  background) while the deterministic Levenberg–Marquardt engine does every
  numeric solve. The engine already surfaces the signals a human refiner uses
  (correlations, near-null directions, at-bound parameters, per-cycle χ²/wR
  history), and symmetry constraints pre-prune the search space to the physical
  one — so the model reasons over real diagnostics and cannot free a forbidden
  parameter. Guardrails and the loop are detailed in [`AGENT_TOOLS.md`](./AGENT_TOOLS.md).
- **Design rules for tools:** pure, deterministic, JSON in/out, and **every tool
  returns diagnostics** (agreement factors, correlations, singular directions) so
  an agent can reason about failure rather than trust a lone R-factor. The M5
  scripting API is the concrete substrate.

---

## 6. Sequencing & guardrails

**Order:** F1 + F2 (coupled, first) → M1 (proves the foundation on real atomic
data) → M2 → M3 → M4 (each gates the next) → M5 formalized last but threaded
throughout. Agent tools exposed per-milestone. **M6 (powder microstructure &
texture)** and **M7 (single-crystal refinement)** are parallel extensions off the
shared core — sequence them by whichever real dataset arrives first, not by a
gate.

**Deferred until the core is correct:** WebAssembly / WebGPU acceleration for
structure-factor summation, profile convolution, and the normal-equations solve.
Superspace (3+d) modulated structures and full structure *solution* (charge
flipping) are beyond this arc.

**Every milestone ships with:** passing tests (golden values where an external
reference exists), updated docs, a working local app, and no broken intermediate
state. A capability is "validated" only when [`VALIDATION.md`](./VALIDATION.md)
records a test or external comparison. Scope honesty (validated vs approximate)
is non-negotiable — see [`LIMITATIONS.md`](./LIMITATIONS.md).
