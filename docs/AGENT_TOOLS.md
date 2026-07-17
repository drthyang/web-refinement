# Agent tools, skills, and LLM-guided refinement

Two related directions build on the same foundation: the pure, side-effect-free
refinement core in [`src/core/**`](../src/core). Because every capability is a
plain TypeScript function over plain data (no DOM, no globals), the same
functions that back the UI can be driven by an agent — and an agent can *reason*
about the refinement rather than just execute it.

> Design rule (see [ROADMAP](./ROADMAP.md)): expose every validated capability as
> a tool/skill *incrementally, as each milestone lands* — never a wholesale
> "agent mode" bolted on at the end.

---

## 0. The layer contract

Three layers, each with one owner and one invariant. The maintainability of
the whole agent surface rests on keeping these boundaries mechanical:

| Layer | Owns | Form | Invariant |
|---|---|---|---|
| **Tools** | one capability (mechanism) | pure JSON → JSON handler + schema, registered in [`src/mcp/registry.ts`](../src/mcp/registry.ts) | a handler never calls another handler; no sequencing, no judgment prose |
| **Skills** | an expert procedure | SKILL.md referencing tools by name | branches only on *structured* outputs of the judgment tools, never on vibes |
| **Orchestration** | conversation, files, when to invoke | the agent runtime (Claude Code, Claude Desktop, any MCP client) | not built here — staying framework-agnostic is the design |

The sorting rule: *must be correct every time* → core function, exposed as a
tool (e.g. the staged anti-collapse recipe inside `refine_magnetic_powder`).
*Known-good sequence with checkpoints* → skill. *Needs user context* →
orchestration. Anything that must be reliable gets pushed **down** a layer,
never encoded as prompt text.

Enforcement (see `src/mcp/registry.test.ts`): two-way registry completeness,
naming/description hygiene, a contract test that calls every tool on canned
fixtures and pins its output shape, and doc-table sync via `npm run gen:tooldoc`.

## 1. The app's core as agent tools

The tool layer is a thin, typed surface over `src/core/**` — no new science,
just callable wrappers. The **shipped tools** are listed in the generated
table under "Running the MCP server" below. Next candidate slices, in
priority order:

| Slice | Tools | Wraps |
|---|---|---|
| Exports & project | `export_cif` / `export_mcif`, `export_bundle`, `magnetic_report`, `save_project` / `load_project` | `core/export`, `core/project` |
| Single crystal | `parse_single_crystal_data`, `build_single_crystal_refinement`, `refine_single_crystal` | `parsers/shelxHkl`, `workflow/singleCrystalRefinement` |
| Absorption | `attenuation_coefficient`, `transmission_correction`, `index_crystal_faces` | `core/absorption` |

Plus one non-tool item: expose `knowledge/*.md` and
[REFINEMENT_PROCEDURE.md](./REFINEMENT_PROCEDURE.md) as **MCP resources** so an
agent can consult the domain knowledge the tools assume.

Properties that make these good tools (already true of the core):

- **Deterministic and pure** — same input, same output; trivially cacheable and
  testable. `src/core/**` stays free of side effects for exactly this reason.
- **Structured diagnostics** — `refine_powder` already returns SVD near-null
  directions, high parameter correlations, and at-bound parameters. An agent
  reads these to decide the next move, not just a scalar wR.
- **Serializable domain types** — models are methods-free data (the same
  constraint the Web Worker protocol already enforces), so they cross a
  tool/RPC boundary unchanged.

**Delivery options** (not mutually exclusive):
- An **MCP server** exposing the tools for any MCP-capable client.
- **Claude Agent SDK** tool definitions for programmatic agents.
- A small in-browser tool registry so a chat panel in the app can call the same
  functions the buttons do.

## 2. Skills (higher-level workflows)

Tools are primitives; **skills** are the expert procedures that compose them —
mirroring [`docs/REFINEMENT_PROCEDURE.md`](./REFINEMENT_PROCEDURE.md) and the
staged plan. Candidate skills:

- **`refine-structure`** — the guided sequence: seed scale → background → cell →
  profile → ADP → positions, checking diagnostics between stages and stopping on
  divergence. (The staged engine already encodes the order; the skill adds the
  judgement and narration.)
- **`diagnose-fit`** — read wR/GoF + correlations + at-bound params and explain
  what's wrong (over-parameterized, wrong background, bad starting cell, …).
- **`choose-background`** — try Chebyshev/cosine/power-series bases and term
  counts, report which fits best without over-fitting.
- **`search-magnetic-space-groups`** — generate k = 0 candidates, refine each,
  rank by fit + physical moment sizes (roadmap M2–M4).

Skills are the natural unit for the incremental exposure rule: each milestone
ships a skill that packages the newly-validated capability.

## 3. LLM AI-guided refinement

The refinement engine is deliberately *not* a black-box global optimizer — it
requires expert sequencing (never refine everything at once; watch correlations;
free only symmetry-allowed parameters). That expert loop is what an LLM can
drive, using the tools above:

```
observe   → evaluate_pattern → wR, GoF, residual shape, diagnostics
decide    → which parameters to free next / which stage / which background
act       → refine_powder(selected params, stage, fit range)
check     → converged? correlations acceptable? params at bounds? physical?
repeat / backtrack
```

What makes this tractable here specifically:

- The engine already surfaces the signals a human refiner uses — **correlations,
  near-null directions, at-bound parameters, per-cycle χ²/wR history** — so the
  model reasons over real diagnostics, not guesses.
- **Symmetry constraints are enforced by the core**, so an agent literally cannot
  free a forbidden parameter — the search space is pre-pruned to the physical one.
- The knowledge base in
  [`knowledge/refinement_fitting_algorithms_knowledge.md`](../knowledge/refinement_fitting_algorithms_knowledge.md)
  is the written policy an LLM refinement guide should follow.

**Scope / guardrails (important):** the LLM *plans and sequences*; the numerical
optimization stays in the deterministic Levenberg–Marquardt engine. The agent
chooses which parameters to free and when, reads diagnostics, and narrates — it
never invents parameter values or bypasses the constrained least-squares. Every
agent-driven result is reproducible by replaying the same tool calls, and (as
everywhere in this project) is not "validated" until a test or external
comparison records it.

## Running the MCP server

Milestone 1 ships an MCP (stdio) server over the pure core, in
[`src/mcp/`](../src/mcp). Build the self-contained bundle and point any
MCP-capable client at it:

```bash
npm run build:mcp          # → dist/mcp-server.mjs (esbuild inlines the core)
node dist/mcp-server.mjs   # speaks MCP over stdio
```

Register it with a client, e.g. Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "materia": { "command": "node", "args": ["/abs/path/dist/mcp-server.mjs"] }
  }
}
```

**Tools shipped** — this table is generated from the single source of truth,
[`src/mcp/registry.ts`](../src/mcp/registry.ts), by `npm run gen:tooldoc`;
`registry.test.ts` fails if it drifts. Every tool is one capability, a pure
JSON → JSON wrapper over tested core — a handler never calls another handler,
and multi-step procedures belong to the skill layer.

<!-- TOOLS:BEGIN (generated — edit src/mcp/registry.ts, then npm run gen:tooldoc) -->
| Tool | Title | Description |
|---|---|---|
| `parse_structure` | Parse structure (CIF/mCIF) | Parse CIF/mCIF text into a StructureModel (cell, sites, space group) and any magnetic model. The entry point: feed its `structure` to build_refinement / interpret_structure. |
| `parse_powder_data` | Parse powder pattern | Auto-detect and parse powder data (xye/xy/dat/GSAS/FullProf/ILL). Returns the pattern, a summary (points, unit, range, radiation), and how the format was detected (source + confidence). |
| `parse_instrument` | Parse instrument file | Parse an instrument-parameter file (GSAS-II .instprm, classic GSAS .prm, FullProf .irf) into a CW or TOF calibration. Pass the result to build_refinement/refine_powder so the wavelength and profile are right. |
| `build_refinement` | Build refinement parameter set | Build the SYMMETRY-ALLOWED parameter set, bindings, and profile for a structure + pattern. Only symmetry-allowed parameters are created, so an agent cannot free a forbidden one. Feed `parameters`/`bindings`/`profile` to refine_powder. |
| `refine_powder` | Refine (constrained least squares) | Run the deterministic Levenberg–Marquardt refinement of the FREED parameters (fix a parameter by setting its `fixed:true`). Returns refined values, esds, agreement (wR/GoF), the SVD/correlation/at-bound diagnostics, the observation count, and the residual — everything assess_refinement needs. The agent decides what to free; it never sets values. |
| `assess_refinement` | Assess refinement (expert judgment) | The judgment tool. Turn a refinement result into a structured expert read: a trust VERDICT (Toby GoF bands) plus ranked FINDINGS — dangerous correlations (with the physical reason), at-bound/unphysical parameters, ill-conditioning, over/under-parameterization, and UNEXPLAINED RESIDUAL PEAKS (the missing-phase / magnetic-order signal). Pass the refine_powder outputs straight in. |
| `suggest_next_steps` | Suggest next steps | The decision tool. Given an assessment, return ranked next ACTIONS (sequencing the constrained refinement — never inventing values): fix an unphysical value, hold an at-bound parameter, break a correlation, hunt an impurity/magnetic phase, or validate a good fit before extending it. |
| `interpret_structure` | Interpret structure (materials science) | The materials tool. Read a refined structure for engineering/discovery signals: crystallite size & microstrain (microstructure), partial occupancy (off-stoichiometry / vacancies / doping), large displacement parameters (disorder), magnetic order, and bond-length sanity — each paired with its materials meaning. |
| `evaluate_pattern` | Evaluate pattern (no refinement) | Compute the calculated pattern and agreement (wR/GoF) at the CURRENT parameter values — no refinement. The cheap what-if tool: tweak a value, evaluate, compare. Pass a magnetic model to get the nuclear and magnetic components separately (what do the moments alone contribute?). |
| `simulate_pattern` | Simulate pattern (structure only) | Simulate the powder pattern of a structure on an instrument before any data exists — planning, phase identification by eye, generating a reference. Grid defaults: CW 5–120° 2θ; TOF the d = 0.6–6 Å band of the calibration. Pass a magnetic model to include (and separate out) the magnetic contribution. |
| `reflection_list` | Reflection list (hkl, d, multiplicity) | Unique hkl families with d-spacing and multiplicity for a structure, optionally with the instrument-frame position (2θ or TOF µs). Set absences:false to keep nuclear-extinct families — that is where AFM magnetic satellites live, and how you match an unexplained peak to a candidate hkl. |
| `bond_geometry` | Bond lengths (sanity check) | Nearest-neighbour bond lengths (Å) up to a cutoff from the symmetry-expanded structure, sorted shortest first. The physical-plausibility check after refining positions: an impossibly short contact means the refinement went somewhere unphysical. |
| `analyze_site_symmetry` | Site symmetry, Wyckoff & refinable DOF | Per-site symmetry: for each atom, its Wyckoff label (e.g. "6h", for the built-in space groups), multiplicity, point-group site symmetry, and the symmetry-allowed refinable degrees of freedom — free positional coordinates (0–3), anisotropic-ADP components (0–6), and magnetic-moment components (0–3). The parameterization guardrail: read this BEFORE freeing coordinates or moments so you never fight a symmetry constraint — an atom on a fixed special position has 0 free coordinates, and a site with `allowedMomentComponents: 0` cannot carry a moment. Also reports the crystal's overall point group. |
| `find_unexplained_peaks` | Find unexplained residual peaks | Find peaks in the residual (obs − calc) that the nuclear model does not explain — the magnetic-order / impurity-phase signal. Robust MAD-based thresholding; returns d-spacings ranked by height. A handful of peaks suggests magnetic satellites; dozens mean the nuclear fit itself is poor. |
| `search_propagation_vector` | Search propagation vector k | Rank candidate commensurate propagation vectors k (denominators 2/3/4/6) by how many unexplained peak d-spacings their satellites G ± k explain. Feed the d values from find_unexplained_peaks; the winning k goes to list_magnetic_subgroups. |
| `list_magnetic_subgroups` | List magnetic subgroup candidates | Enumerate the maximal magnetic subgroup candidates of the parent space group for a propagation vector k: conjugacy-class representatives with BNS identification, subgroup index, and domain count. The chosen candidate's `operations` feed allowed_moments and build_magnetic_model. |
| `allowed_moments` | Allowed moment directions per site | The site-symmetry analysis: which moment directions the magnetic group allows on each site (null space of the magnetic stabilizer, with the k-phase). Dimension 0 = moment symmetry-forbidden; the basis spans exactly what a refinement may vary. Matches GSAS-II's per-site moment rules. |
| `build_magnetic_model` | Build symmetry-allowed magnetic model | Build the magnetic model + moment-mode parameters for chosen ion sites under a magnetic subgroup: amplitudes over the symmetry-ALLOWED directions only, co-located (occupancy-disorder) ions tied to one moment, split orbits as independent sublattices. The refinement cannot leave the allowed space by construction. Feed the outputs to refine_magnetic_powder. |
| `rank_next_parameters` | Rank next parameters (sensitivity) | The next-step diagnostic: rank the currently-FIXED parameter groups by the χ² improvement freeing them is expected to buy (Gauss–Newton estimate from probed Jacobian columns at the current values). Read `predictedWr` vs `wrNow` for absolute progress — on a converged model every group promises nothing. A LOCAL probe: align the pattern first; badly displaced peaks under-credit the cell/zero groups. |
| `refine_magnetic_powder` | Refine nuclear + magnetic (staged) | Co-refine nuclear + magnetic against a powder pattern. Staged by default: scale + background converge with moments and profile held, then everything requested is freed — a flat co-refinement from a poor moment start can collapse the scale against exploding moments. Combine the nuclear parameters/bindings from build_refinement with the moment set from build_magnetic_model. Returns the result, the refined magnetic model, and separated nuclear/magnetic component curves. |
| `parse_single_crystal_data` | Parse single-crystal reflections | Parse single-crystal integrated intensities — a FullProf .int (h k l I σ) or a SHELX HKLF4 .hkl — into a SingleCrystalDataset. Parse the nuclear and magnetic files, then merge_magnetic_supercell into one dataset for the magnetic refinement. |
| `write_single_crystal_data` | Write single-crystal .int | Serialize a SingleCrystalDataset to a FullProf .int file (h k l F² σ cod through the declared Fortran format). Pass kVectors + per-reflection kIndex for the propagation-vector variant (satellite = H + k_nv; pending external FullProf validation). Round-trips with parse_single_crystal_data. |
| `expand_structure_supercell` | Expand structure to magnetic supercell | Expand a nuclear structure into the magnetic supercell of a commensurate k — an exact geometric regrouping (full orbits explicit, replicated per cell, P1; positions/occupancies/ADPs verbatim). Pair with merge_magnetic_supercell: the merged reflections refine against this structure with the nuclear scaffold frozen. The refined scale becomes k_base/N² (N = cells per supercell), identically for nuclear and magnetic intensities. |
| `build_modulated_moment_model` | Build k-modulated supercell moments | Build the k-modulated magnetic model on the expanded supercell: one amplitude per sublattice drives every replica of its parent site through cos(2πk·L + φ), so replica moments are tied by the modulation and magnetic ions sit exactly at the nuclear positions. Returns the expanded structure + magnetic model + parameters/bindings; add a scale and a magneticScale tied to it, then refine against the merged supercell dataset. |
| `merge_magnetic_supercell` | Merge nuclear + magnetic to supercell | Merge a nuclear + magnetic single-crystal reflection pair (both indexed in the nuclear cell, the FullProf single-k convention where the magnetic file's h k l is the fundamental of a satellite at hkl+k) into one dataset in the magnetic supercell, where k becomes an integer reciprocal-lattice vector. Feed the result to a magnetic structure refinement. k must be commensurate and axis-diagonal. |
| `parse_pdf_data` | Parse reduced PDF G(r) | Parse a reduced pair-distribution-function file (.gr/.sq/.fq — diffpy PDFgetX3 or Mantid dialect) into a PdfPattern with its total-scattering metadata (Qmax, Qdamp, composition). The real-space entry point: feed `pattern` to build_pdf_model / refine_pdf. |
| `build_pdf_model` | Build PDF parameter set | Build the SYMMETRY-ALLOWED PDF parameter set for a structure (plus optional extra phases) against an observed G(r): the PDF scale (seeded to the least-squares optimum), the Qdamp/Qbroad instrument envelope (seeded from the header, fixed), correlated-motion δ1/δ2 and sratio/rcut, the particle-diameter envelope, and the symmetry-reduced cell/positions/ADPs/occupancies. Feed `parameters`/`bindings`/`restraints` to refine_pdf. |
| `refine_pdf` | Refine against G(r) (real space) | Run the deterministic least-squares PDF refinement of the FREED parameters against an observed G(r) — real-space Rietveld with uniform weights (G(r) errors are correlated; Rw is a relative indicator). Flat co-refinement or the staged sequence (scale → cell → ADP → δ1 → positions); single- or multi-phase; restrict with `fitRange` (low r below r_poly is reduction artifact). Returns refined values, esds, agreement, diagnostics, the r-space residual, and any correlated-motion model conflict in `warnings`. |
| `compute_partial_pdf` | Partial PDF decomposition | Decompose the calculated G(r) for interpretation — which chemistry (element pair) or which phase makes which peak. Single phase → Faber–Ziman element-pair partials; with extraPhases → per-phase contributions. The curves sum exactly to the total calc. |
| `calibrate_qdamp` | Calibrate Qdamp/Qbroad from a standard | Calibrate the instrument resolution envelope from a measured STANDARD (Ni / Si / LaB₆ — a sample with a known structure): frees only the PDF scale + Qdamp + Qbroad, holds the certified structure, and returns the calibrated constants (with esds) to carry into sample fits as fixed values. |
| `build_distortion_modes` | Build distortion-mode parameters | Decompose a low-symmetry CHILD structure against its high-symmetry PARENT (same lattice; origin shift searched automatically) into refinable DISTORTION-MODE amplitudes — the AMPLIMODES/ISODISTORT paradigm. Modes are tagged with their Brillouin-zone star (`star`: Γ, X, H, or a literal k) from the parent centerings the child breaks, and the observed distortion is split into one frozen (order-parameter) mode per star. Use `structure`/`parameters`/`bindings` with refine_pdf or refine_powder instead of per-coordinate positions: same engine, fewer and more informative parameters (the frozen modes come free). |
<!-- TOOLS:END -->

`assess_refinement` / `suggest_next_steps` / `interpret_structure` are the
judgement layer — the "figure out what matters and guide the next step"
surface — and live as pure, tested core in
[`src/core/diagnostics/`](../src/core/diagnostics) (`assessment.ts`,
`interpret.ts`), so the same functions can back a future in-app chat panel.
The whole expert loop runs end to end on the real GaNb4Se8 dataset, and the
analysis primitives are covered data-free by a simulate→evaluate
self-consistency loop (see `src/mcp/tools.test.ts`). Every tool's output
shape is pinned by a contract test in `src/mcp/registry.test.ts`.

## Status

**Milestone 1 shipped:** the MCP tool layer above, with the judgement
(`assess_refinement` / `suggest_next_steps`) and materials-interpretation
(`interpret_structure`) tools that let an agent *reason* about a refinement, not
just execute it — all in tested pure core.

**Next:** package the guidance loop as a *skill* (`refine-structure`,
`diagnose-fit`); add richer per-tool JSON schemas; single-crystal + magnetic
assessment variants (in the single-crystal convention — R1/wR2/GooF, per the
quality-panel boundary); and an in-app tool registry so the chat panel calls the
same functions the buttons do. Tracked in [ROADMAP §7](./ROADMAP.md).
