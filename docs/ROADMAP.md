# Roadmap

The single, authoritative plan for the Web Refinement Workbench. It supersedes
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

What genuinely works today (293 passing tests; real-data validated):

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
- **Needed:** scoring by magnetic *intensity* (Le Bail), not just position;
  incommensurate / multi-k handling; a commensurate/incommensurate flag.
- **Validation gate:** ✅ recovers k for a known AFM at a zone boundary; Γ returns
  no match for genuinely magnetic peaks. Intensity-scored gate still open.
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
  Bradley & Cracknell (1972) §3.7.
- **Needed:** a **representation-analysis** route (irreps of G_k →
  basis vectors), the BasIreps/SARAh capability; standard **BNS/OG labels**
  via a lookup table so a candidate reads "P2₁'/m'" rather than a primed-operation
  list; and the **star of k** (multi-arm domains).
- **Validation gate:** little group + allowed moments match Bilbao/ISODISTORT for
  known cases; k = 0 path reproduces today's candidate set.
- **Tool exposed:** `enumerate_magnetic_symmetry(parent, k) → candidate groups +
  moment bases (+ standard labels)`.

### M4 — Magnetic structure refinement ⬜

- **Goal:** refine **moment basis-mode amplitudes** (never raw M_x/M_y/M_z) for
  each M3 candidate against magnetic data, and rank candidates by fit *and*
  physical plausibility.
- **Exists:** k = 0 magnetic powder + single-crystal moment refinement; candidate
  comparison; a moment-magnitude recovery test.
- **Needed:** parameterize refinement over the irrep/basis amplitudes from M3;
  magnetic supercell handling and Fourier-coefficient moment models
  (sine / helical / conical) for k ≠ 0; use F1's global search to resolve
  sign/phase ambiguity; candidate ranking with correlation-aware diagnostics.
- **Validation gate:** recover a known basis-mode amplitude for k ≠ 0; ranked
  candidates put the true magnetic structure first on a golden case.
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
  `generate_report` (M5) · `diagnose` (correlations, singular directions).
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
throughout. Agent tools exposed per-milestone.

**Deferred until the core is correct:** WebAssembly / WebGPU acceleration for
structure-factor summation, profile convolution, and the normal-equations solve.
Superspace (3+d) modulated structures and full structure *solution* (charge
flipping) are beyond this arc.

**Every milestone ships with:** passing tests (golden values where an external
reference exists), updated docs, a working local app, and no broken intermediate
state. A capability is "validated" only when [`VALIDATION.md`](./VALIDATION.md)
records a test or external comparison. Scope honesty (validated vs approximate)
is non-negotiable — see [`LIMITATIONS.md`](./LIMITATIONS.md).
