# Agent tools, skills, and LLM-guided refinement

Every scientific capability of the workbench is a pure TypeScript function over
plain data in [`src/core/**`](../src/core). That makes the same functions usable
by an agent: an MCP server exposes them as tools, so an agent can run a
refinement and reason about the result, not just execute steps.

The layer grows with the science. A capability becomes a tool once it is
validated, milestone by milestone — never as an "agent mode" bolted on at the
end ([ROADMAP.md §5](./ROADMAP.md)).

## Run the MCP server

The server speaks MCP over stdio ([`src/mcp/`](../src/mcp)). One command
bundles the core and starts it, so a client always runs the current source:

```bash
npm run mcp                # = node scripts/build-mcp.mjs --serve
```

**Claude Code** picks the server up from the repository's
[`.mcp.json`](../.mcp.json) and asks once before starting it. Run
`npm install` first.

**Claude Desktop** and other clients need the absolute path. They often launch
servers in `/` or the home folder, so name the data folder too:

```json
{
  "mcpServers": {
    "materia": {
      "command": "node",
      "args": ["/abs/path/web-refinement/scripts/build-mcp.mjs", "--serve"],
      "env": { "MATERIA_ROOTS": "/abs/path/web-refinement" }
    }
  }
}
```

### How data travels

The tools pass whole domain objects. A parsed powder pattern is about 200 k
characters of JSON, and every refinement needs it back. A model cannot carry
that, so the transport ([`host.ts`](../src/mcp/host.ts),
[`refs.ts`](../src/mcp/refs.ts)) adds four things. The handlers never see them.

- **Refs.** The server stores every tool output. The response is a compact view:
  bulky parts come back as `{"ref": "#3/pattern", …summary}`. Any argument may
  be such a ref, and the server substitutes the stored value. Each object result
  also carries `"ref": "#n"` for the whole output.
- **`path`.** The parse tools read a file on the server instead of taking its
  text. Paths are confined to the data folders: `MATERIA_ROOTS` (a path list),
  else the working directory. File reading stays off when that is `/` or the
  home folder.
- **`free`.** Refining tools take parameter ids or globs, such as
  `["scale", "bkg*", "cell_*"]`. Exactly those refine; every other parameter is
  held fixed. A pattern that matches nothing is an error that lists the ids.
- **`read_ref`.** It shows the value behind a ref, with `start`/`end` windows for
  long arrays.

Refining tools return `parameters` with the refined values, so one call's
output feeds the next without copying numbers. A test drives a whole powder
loop through a real MCP client and holds every message under a size budget
([`host.test.ts`](../src/mcp/host.test.ts)).

## Tools

Each tool is one capability: a pure JSON → JSON wrapper over tested core code.
A tool never calls another tool; multi-step procedures belong to skills.

The tables below are generated from [`src/mcp/registry.ts`](../src/mcp/registry.ts)
by `npm run gen:tooldoc`; `registry.test.ts` fails if a registered tool is missing. The
full descriptions at the end are the text an agent reads when it picks a tool.

<!-- TOOLS:BEGIN (generated — edit src/mcp/registry.ts, then npm run gen:tooldoc) -->
**Structure, data and instrument**

| Tool | What it does |
|---|---|
| `parse_structure` | Parse structure (CIF/mCIF) |
| `parse_powder_data` | Parse powder pattern |
| `parse_instrument` | Parse instrument file |
| `reflection_list` | Reflection list (hkl, d, multiplicity) |
| `bond_geometry` | Bond lengths (sanity check) |
| `analyze_site_symmetry` | Site symmetry, Wyckoff & refinable DOF |

**Powder refinement**

| Tool | What it does |
|---|---|
| `build_refinement` | Build refinement parameter set |
| `refine_powder` | Refine (constrained least squares) |
| `evaluate_pattern` | Evaluate pattern (no refinement) |
| `simulate_pattern` | Simulate pattern (structure only) |
| `rank_next_parameters` | Rank next parameters (sensitivity) |

**Judging a refinement**

| Tool | What it does |
|---|---|
| `assess_refinement` | Assess refinement (expert judgment) |
| `suggest_next_steps` | Suggest next steps |
| `interpret_structure` | Interpret structure (materials science) |

**Magnetic structures**

| Tool | What it does |
|---|---|
| `find_unexplained_peaks` | Find unexplained residual peaks |
| `search_propagation_vector` | Search propagation vector k |
| `list_magnetic_subgroups` | List magnetic subgroup candidates |
| `allowed_moments` | Allowed moment directions per site |
| `build_magnetic_model` | Build symmetry-allowed magnetic model |
| `refine_magnetic_powder` | Refine nuclear + magnetic (staged) |

**Single crystal**

| Tool | What it does |
|---|---|
| `parse_single_crystal_data` | Parse single-crystal reflections |
| `write_single_crystal_data` | Write single-crystal .int |
| `expand_structure_supercell` | Expand structure to magnetic supercell |
| `build_modulated_moment_model` | Build k-modulated supercell moments |
| `merge_magnetic_supercell` | Merge nuclear + magnetic to supercell |

**Pair distribution function (PDF)**

| Tool | What it does |
|---|---|
| `parse_pdf_data` | Parse reduced PDF G(r) |
| `build_pdf_model` | Build PDF parameter set |
| `refine_pdf` | Refine against G(r) (real space) |
| `refine_pdf_boxcar` | Boxcar scan over r (PDF) |
| `sample_posterior` | Sample Bayesian posterior (MCMC) |
| `compute_partial_pdf` | Partial PDF decomposition |
| `calibrate_qdamp` | Calibrate Qdamp/Qbroad from a standard |

**Magnetic PDF**

| Tool | What it does |
|---|---|
| `build_mpdf_model` | Build magnetic-PDF parameter set |
| `refine_mpdf` | Refine magnetic PDF (real space) |
| `compute_mpdf_components` | Separate nuclear vs magnetic G(r) |

**Symmetry modes**

| Tool | What it does |
|---|---|
| `build_distortion_modes` | Build distortion-mode parameters |
| `build_symmetry_modes` | Enumerate symmetry modes from the space group |

<details>
<summary>Full descriptions — the text an agent reads for each tool</summary>

**`parse_structure`** — Parse CIF/mCIF text into a StructureModel (cell, sites, space group) and any magnetic model. The entry point: feed its `structure` to build_refinement / interpret_structure.

**`parse_powder_data`** — Auto-detect and parse powder data (xye/xy/dat/GSAS/FullProf/ILL). Returns the pattern, a summary (points, unit, range, radiation), and how the format was detected (source + confidence).

**`parse_instrument`** — Parse an instrument-parameter file (GSAS-II .instprm, classic GSAS .prm, FullProf .irf) into a CW or TOF calibration. Pass the result to build_refinement/refine_powder so the wavelength and profile are right.

**`build_refinement`** — Build the SYMMETRY-ALLOWED parameter set, bindings, and profile for a structure + pattern. Only symmetry-allowed parameters are created, so an agent cannot free a forbidden one. Feed `parameters`/`bindings`/`profile` to refine_powder.

**`refine_powder`** — Run the deterministic Levenberg–Marquardt refinement of the FREED parameters (fix a parameter by setting its `fixed:true`). Returns refined values, esds, agreement (wR/GoF), the SVD/correlation/at-bound diagnostics, the observation count, and the residual — everything assess_refinement needs — plus `parameters`: the input set carrying the refined values, ready for the next block. The agent decides what to free; it never sets values.

**`assess_refinement`** — The judgment tool. Turn a refinement result into a structured expert read: a trust VERDICT (Toby GoF bands) plus ranked FINDINGS — dangerous correlations (with the physical reason), at-bound/unphysical parameters, ill-conditioning, over/under-parameterization, and UNEXPLAINED RESIDUAL PEAKS (the missing-phase / magnetic-order signal). Pass the refine_powder outputs straight in.

**`suggest_next_steps`** — The decision tool. Given an assessment, return ranked next ACTIONS (sequencing the constrained refinement — never inventing values): fix an unphysical value, hold an at-bound parameter, break a correlation, hunt an impurity/magnetic phase, or validate a good fit before extending it.

**`interpret_structure`** — The materials tool. Read a refined structure for engineering/discovery signals: crystallite size & microstrain (microstructure), partial occupancy (off-stoichiometry / vacancies / doping), large displacement parameters (disorder), magnetic order, and bond-length sanity — each paired with its materials meaning.

**`evaluate_pattern`** — Compute the calculated pattern and agreement (wR/GoF) at the CURRENT parameter values — no refinement. The cheap what-if tool: tweak a value, evaluate, compare. Pass a magnetic model to get the nuclear and magnetic components separately (what do the moments alone contribute?).

**`simulate_pattern`** — Simulate the powder pattern of a structure on an instrument before any data exists — planning, phase identification by eye, generating a reference. Grid defaults: CW 5–120° 2θ; TOF the d = 0.6–6 Å band of the calibration. Pass a magnetic model to include (and separate out) the magnetic contribution.

**`reflection_list`** — Unique hkl families with d-spacing and multiplicity for a structure, optionally with the instrument-frame position (2θ or TOF µs). Set absences:false to keep nuclear-extinct families — that is where AFM magnetic satellites live, and how you match an unexplained peak to a candidate hkl.

**`bond_geometry`** — Nearest-neighbour bond lengths (Å) up to a cutoff from the symmetry-expanded structure, sorted shortest first. The physical-plausibility check after refining positions: an impossibly short contact means the refinement went somewhere unphysical.

**`analyze_site_symmetry`** — Per-site symmetry: for each atom, its Wyckoff label (e.g. "6h", for the built-in space groups), multiplicity, point-group site symmetry, and the symmetry-allowed refinable degrees of freedom — free positional coordinates (0–3), anisotropic-ADP components (0–6), and magnetic-moment components (0–3). The parameterization guardrail: read this BEFORE freeing coordinates or moments so you never fight a symmetry constraint — an atom on a fixed special position has 0 free coordinates, and a site with `allowedMomentComponents: 0` cannot carry a moment. Also reports the crystal's overall point group.

**`find_unexplained_peaks`** — Find peaks in the residual (obs − calc) that the nuclear model does not explain — the magnetic-order / impurity-phase signal. Robust MAD-based thresholding; returns d-spacings ranked by height. A handful of peaks suggests magnetic satellites; dozens mean the nuclear fit itself is poor.

**`search_propagation_vector`** — Rank candidate commensurate propagation vectors k (denominators 2/3/4/6) by how many unexplained peak d-spacings their satellites G ± k explain. Feed the d values from find_unexplained_peaks; the winning k goes to list_magnetic_subgroups.

**`list_magnetic_subgroups`** — Enumerate the maximal magnetic subgroup candidates of the parent space group for a propagation vector k: conjugacy-class representatives with BNS identification, subgroup index, and domain count. The chosen candidate's `operations` feed allowed_moments and build_magnetic_model.

**`allowed_moments`** — The site-symmetry analysis: which moment directions the magnetic group allows on each site (null space of the magnetic stabilizer, with the k-phase). Dimension 0 = moment symmetry-forbidden; the basis spans exactly what a refinement may vary. Matches GSAS-II's per-site moment rules.

**`build_magnetic_model`** — Build the magnetic model + moment-mode parameters for chosen ion sites under a magnetic subgroup: amplitudes over the symmetry-ALLOWED directions only, co-located (occupancy-disorder) ions tied to one moment, split orbits as independent sublattices. The refinement cannot leave the allowed space by construction. For a k with two distinct arms (−k ≢ k: ¼-, ⅓-type or incommensurate) every mode carries a cosine AND a sine (quadrature) amplitude — complex Fourier coefficients, the representation helices/cycloids need (`fourier: true`); `phaseGaugeParameterId` names the one sine amplitude that must stay FIXED (the global modulation phase is unobservable). Read `propagation` for the k classification. Feed the outputs to refine_magnetic_powder.

**`rank_next_parameters`** — The next-step diagnostic: rank the currently-FIXED parameter groups by the χ² improvement freeing them is expected to buy (Gauss–Newton estimate from probed Jacobian columns at the current values). Read `predictedWr` vs `wrNow` for absolute progress — on a converged model every group promises nothing. A LOCAL probe: align the pattern first; badly displaced peaks under-credit the cell/zero groups.

**`refine_magnetic_powder`** — Co-refine nuclear + magnetic against a powder pattern. Staged by default: scale + background converge with moments and profile held, then everything requested is freed — a flat co-refinement from a poor moment start can collapse the scale against exploding moments. Combine the nuclear parameters/bindings from build_refinement with the moment set from build_magnetic_model. Returns the result, the refined `parameters` (ready for the next call), the refined magnetic model, and separated nuclear/magnetic component curves.

**`parse_single_crystal_data`** — Parse single-crystal integrated intensities — a FullProf .int, a SHELX HKLF 4 .hkl, a .fcf CIF reflection loop, or a plain h k l I σ list — into a SingleCrystalDataset. ALWAYS pass `name`: .int and .fcf are detected from the text, but HKLF 4 is fixed-column and looks exactly like a free-format list, so only the .hkl filename selects the column-exact reader (whitespace-splitting an HKLF 4 row reads σ as the intensity once F² ≥ 10000.00 fills its field). `format` reports which reader ran. Parse the nuclear and magnetic files, then merge_magnetic_supercell into one dataset for the magnetic refinement. A 0 0 0 row (the forward beam, not a Bragg reflection) is skipped by default — pass skipForwardBeam:false for a fundamental-indexed MAGNETIC file, where 0 0 0 is the satellite at k itself.

**`write_single_crystal_data`** — Serialize a SingleCrystalDataset to a FullProf .int file (h k l F² σ cod through the declared Fortran format). Pass kVectors + per-reflection kIndex for the propagation-vector variant (satellite = H + k_nv; pending external FullProf validation). Round-trips with parse_single_crystal_data.

**`expand_structure_supercell`** — Expand a nuclear structure into the magnetic supercell of a commensurate k — an exact geometric regrouping (full orbits explicit, replicated per cell, P1; positions/occupancies/ADPs verbatim). Pair with merge_magnetic_supercell: the merged reflections refine against this structure with the nuclear scaffold frozen. The refined scale becomes k_base/N² (N = cells per supercell), identically for nuclear and magnetic intensities.

**`build_modulated_moment_model`** — Build the k-modulated magnetic model on the expanded supercell: one amplitude per sublattice drives every replica of its parent site through cos(2πk·L + φ), so replica moments are tied by the modulation and magnetic ions sit exactly at the nuclear positions. Returns the expanded structure + magnetic model + parameters/bindings; add a scale and a magneticScale tied to it, then refine against the merged supercell dataset.

**`merge_magnetic_supercell`** — Merge a nuclear + magnetic single-crystal reflection pair (both indexed in the nuclear cell, the FullProf single-k convention where the magnetic file's h k l is the fundamental of a satellite at hkl+k) into one dataset in the magnetic supercell, where k becomes an integer reciprocal-lattice vector. Feed the result to a magnetic structure refinement. k must be commensurate and axis-diagonal.

**`parse_pdf_data`** — Parse a reduced pair-distribution-function file (.gr/.sq/.fq — diffpy PDFgetX3 or Mantid dialect) or a PDFgui fit export (.fgr) into a PdfPattern with its total-scattering metadata (Qmax, Qdamp, composition). For .fgr, `signal` picks the curve: 'observed' (default, Gcalc+Gdiff) or 'difference' (the fit residual — the mPDF signal for a neutron nuclear fit). The real-space entry point: feed `pattern` to build_pdf_model / refine_pdf.

**`build_pdf_model`** — Build the SYMMETRY-ALLOWED PDF parameter set for a structure (plus optional extra phases) against an observed G(r): the PDF scale (seeded to the least-squares optimum), the Qdamp/Qbroad instrument envelope (seeded from the header, fixed), correlated-motion δ1/δ2 and sratio/rcut, the particle-diameter envelope, and the symmetry-reduced cell/positions/ADPs/occupancies. Feed `parameters`/`bindings`/`restraints` to refine_pdf. CHECK `warnings`: it names any site with no displacement parameter (B_iso = 0, e.g. a CIF with no U_iso/B_iso column) — that gives delta-sharp G(r) peaks and a collapsed scale, so the fit converges on a meaningless model. Set a B_iso before refining.

**`refine_pdf`** — Run the deterministic least-squares PDF refinement of the FREED parameters against an observed G(r) — real-space Rietveld with uniform weights (G(r) errors are correlated; Rw is a relative indicator). Flat co-refinement or the staged sequence (scale → cell → ADP → δ1 → positions); single- or multi-phase; restrict with `fitRange` (low r below r_poly is reduction artifact). Returns refined values, esds, agreement, diagnostics, the refined `parameters` (ready for the next call), the r-space residual, and — in `warnings` — any correlated-motion model conflict or missing-ADP defect that makes the reported convergence meaningless.

**`refine_pdf_boxcar`** — Run a BOXCAR (sliding-window) PDF refinement: refit the freed parameters inside a fixed-width r-window slid across the data, each box seeded from the previous one, and report how every parameter drifts with the box center. This is the r-resolved read of a structure — a value that changes with the box center means the LOCAL structure (low r) differs from the AVERAGE one (high r), which a single whole-range fit averages away. Every box has exactly `width`; a trailing span too short for a full box is not fitted (reported in `warnings`). Each box is seeded from the previous one, which makes the series PATH-DEPENDENT — set `restarts` to re-search each box from randomly perturbed starts and keep the best, so a drift is not one box's local minimum inherited by the rest. Read a value only where its box fitted well (`boxes[].rWeighted`, `boxes[].status`) and where the esd is small compared with the drift — narrow boxes hold few points, so esds grow as the box shrinks. Hold Qdamp/Qbroad fixed: they are instrument constants, not functions of r.

**`build_mpdf_model`** — Build the magnetic-PDF (mPDF) parameter set: the nuclear PDF rows (scale seeded from the nuclear curve) plus the four mPDF rows — ordered scale, paramagnetic scale, magnetic peak σ, and the short-range-order correlation length ξ — and the symmetry-allowed moment modes from build_magnetic_model. The mPDF rows start FIXED because `mpdfOrdScale` is degenerate with the moment magnitude; free the moments OR the ordered scale, not both. Feed `parameters`/`bindings`/`magnetic` to refine_mpdf. COMMENSURATE k ONLY (every component a rational with denominator ≤ 12): an incommensurate k has no periodic spin box and is REJECTED, not approximated. CHECK `warnings`: non-neutron data, an empty spin field, and any site with no displacement parameter (B_iso = 0) all make the result meaningless.

**`refine_mpdf`** — Co-refine the nuclear G(r) and the magnetic d_mag(r) against one observed NEUTRON PDF — the real-space counterpart of refine_magnetic_powder (Frandsen & Billinge 2015 unnormalized mPDF, added into the same residual). Flat co-refinement or the staged sequence (scale → cell → ADP → δ1 → moments → positions); restrict with `fitRange`. Returns refined values, esds, agreement, diagnostics, the refined `parameters` (ready for the next call), the refined magnetic model, and separated nuclear/magnetic component curves. COMMENSURATE k ONLY — an incommensurate k is rejected (refine it against Bragg satellites with refine_magnetic_powder instead). X-ray patterns get no magnetic term (reported in `warnings`).

**`compute_mpdf_components`** — Split the calculated G(r) into its nuclear and magnetic parts at the CURRENT parameter values, without refining. Use it to check whether a candidate spin model produces enough magnetic signal to fit. `magneticFraction` is the RATIO peak|magnetic| / peak|nuclear| — 0.01 is 1%, and below about that the moments are effectively unconstrained by the data (a strongly magnetic neutron PDF runs 0.1–1). Always read it with `nuclearPeak`/`magneticPeak`: the ratio is reported as 0 when the nuclear peak is zero, which means a degenerate nuclear model, not weak magnetism.

**`sample_posterior`** — Draw Bayesian posterior samples over the FREED parameters of a PDF fit with an affine-invariant ensemble MCMC sampler — the full parameter distribution where refine_pdf gives a point estimate. Reports per-parameter median / 68% / 95% credible intervals, convergence diagnostics (R-hat, ESS, acceptance), sample correlations, and — when `linearizedEsd` from a prior refine_pdf is supplied — `esdRatio` (posterior std / least-squares esd: ≈1 validates the esds, ≫1 means they were overconfident from correlation or non-Gaussianity). The default `marginalized` noise model integrates out the unknown G(r) error scale (uniform weights are not honest sigmas), so widths are meaningful. Run refine_pdf FIRST and seed `parameters` at the converged values. Bounded per call: if `converged` is false, pass the returned `resume` token to a follow-up call to continue the same chain.

**`compute_partial_pdf`** — Decompose the calculated G(r) for interpretation — which chemistry (element pair) or which phase makes which peak. Single phase → Faber–Ziman element-pair partials; with extraPhases → per-phase contributions. The curves sum exactly to the total calc.

**`calibrate_qdamp`** — Calibrate the instrument resolution envelope from a measured STANDARD (Ni / Si / LaB₆ — a sample with a known structure): frees only the PDF scale + Qdamp + Qbroad, holds the certified structure, and returns the calibrated constants (with esds) to carry into sample fits as fixed values.

**`build_distortion_modes`** — Decompose a low-symmetry CHILD structure against its high-symmetry PARENT (same lattice; origin shift searched automatically) into refinable DISTORTION-MODE amplitudes — the AMPLIMODES/ISODISTORT paradigm. Modes are tagged with their Brillouin-zone star (`star`: Γ, X, H, or a literal k) from the parent centerings the child breaks, and the observed distortion is split into one frozen (order-parameter) mode per star. Use `structure`/`parameters`/`bindings` with refine_pdf or refine_powder instead of per-coordinate positions: same engine, fewer and more informative parameters (the frozen modes come free).

**`build_symmetry_modes`** — Enumerate the symmetry-adapted displacement modes of a structure FROM ITS OWN SPACE GROUP — no parent/child CIF pair. Every asymmetric site contributes its symmetry-allowed shift directions, orthonormalized as whole-cell Å amplitudes seeded at 0 (activating modes never changes the curve; they enter fixed and are freed deliberately). Rigid-translation (acoustic) combinations — exactly unobservable in G(r) or |F|² — are projected out (`acousticExcluded`), so freeing every mode is always a well-posed fit. These are the symmetry-CONSERVING (Γ) modes: the same DOF as per-coordinate positions in a physically informative basis. Use `structure`/`parameters`/`bindings` with refine_pdf or refine_powder.

</details>
<!-- TOOLS:END -->

**The judgment tools.** `assess_refinement`, `suggest_next_steps` and
`interpret_structure` turn a refinement result into a verdict, ranked next
actions and a materials reading. They are pure, tested core code in
[`src/core/diagnostics/`](../src/core/diagnostics), so an in-app chat panel
could call the same functions.

**How the tools are tested.**
- A contract test calls every tool on canned inputs and pins the shape of its
  output ([`registry.test.ts`](../src/mcp/registry.test.ts)).
- A simulate → evaluate loop checks the analysis tools without any data files
  ([`tools.test.ts`](../src/mcp/tools.test.ts)). The same file runs the whole
  expert loop on the real GaNb₄Se₈ dataset when the git-ignored `data/` folder
  is present.
- End-to-end agent loops for PDF and magnetic PDF use the registry only
  ([`pdfAgentLoop.test.ts`](../src/mcp/pdfAgentLoop.test.ts),
  [`mpdfAgentLoop.test.ts`](../src/mcp/mpdfAgentLoop.test.ts)).

## The layer contract

The agent surface has three layers. Each has one owner and one invariant, and
keeping those boundaries mechanical is what keeps the surface maintainable.

| Layer | Owns | Form | Invariant |
|---|---|---|---|
| **Tools** | one capability | a pure JSON → JSON handler plus schema, registered in [`src/mcp/registry.ts`](../src/mcp/registry.ts) | a handler never calls another handler; no sequencing, no judgment prose |
| **Skills** | an expert procedure | a `SKILL.md` that names tools | branches only on the *structured* outputs of the judgment tools |
| **Orchestration** | the conversation, files, when to invoke | the agent runtime (Claude Code, Claude Desktop, any MCP client) | not built here; staying framework-agnostic is the design |

Where a piece of work belongs:
- It must be correct every time → a core function, exposed as a tool. Example:
  the staged anti-collapse recipe inside `refine_magnetic_powder`.
- It is a known-good sequence with checkpoints → a skill.
- It needs the user's context → orchestration.

Anything that must be reliable moves **down** a layer; it is never encoded as
prompt text.

`registry.test.ts` enforces the contract: the registry and the handlers match
both ways, names and descriptions follow the conventions, every tool's output
shape is pinned, and every registered tool appears on this page.

## Skills

A skill composes tools into an expert procedure. One ships in this repository:
[`.claude/skills/my-rietveld-workflow/`](../.claude/skills/my-rietveld-workflow/SKILL.md),
the maintainer's own powder Rietveld procedure: a fixed freeing sequence, gates
between stages, and acceptance criteria. It covers constant-wavelength and TOF
data, single- and multi-phase, and hands magnetic structures on to the
magnetic-analysis flow.

**Planned skills**
- `refine-structure` — the guided sequence scale → background → cell → profile
  → ADP → positions, checking diagnostics between stages and stopping on
  divergence. The staged engine already encodes the order; the skill adds the
  judgment and the narration.
- `diagnose-fit` — read wR/GoF, correlations and at-bound parameters, and
  explain what is wrong: over-parameterization, a wrong background, a bad
  starting cell.
- `choose-background` — compare background bases and term counts, and report
  which fits best without over-fitting.
- `search-magnetic-space-groups` — generate candidates, refine each, and rank
  them by fit and by physical moment sizes (roadmap M2–M4).

Each milestone should ship a skill that packages its newly validated capability.

## LLM-guided refinement

Refinement is an expert loop, not a black-box global optimization: never refine
everything at once, watch the correlations, free only symmetry-allowed
parameters. An LLM can drive that loop with the tools above:

```
observe   → evaluate_pattern → wR, GoF, residual shape, diagnostics
decide    → which parameters to free next / which stage / which background
act       → refine_powder(selected params, stage, fit range)
check     → converged? correlations acceptable? params at bounds? physical?
repeat / backtrack
```

Three things make this tractable here:
- The engine returns the signals a human refiner uses: correlations, near-null
  directions, at-bound parameters and the per-cycle χ²/wR history.
- The core enforces symmetry constraints, so an agent cannot free a forbidden
  parameter.
- [`knowledge/refinement_fitting_algorithms_knowledge.md`](../knowledge/refinement_fitting_algorithms_knowledge.md)
  is the written policy the agent should follow.

**Guardrails.** The LLM plans and sequences; every numerical solve stays in the
deterministic Levenberg–Marquardt engine. The agent chooses what to free and
when, reads the diagnostics and explains them. It never invents parameter
values or bypasses the constrained least squares. Replaying the same tool calls
reproduces the result, and nothing counts as validated until a test or an
external comparison records it.

## Planned

Tool slices, in priority order (names are provisional):

| Slice | Tools | Wraps |
|---|---|---|
| Exports and project files | `export_cif` / `export_mcif`, `export_bundle`, `generate_report`, `save_project` / `load_project` | `core/export`, `core/project` |
| Single-crystal refinement | `build_single_crystal_refinement`, `refine_single_crystal` | `workflow/singleCrystalRefinement` |
| Absorption | `attenuation_coefficient`, `transmission_correction`, `index_crystal_faces` (or one `correct_absorption`) | `core/absorption` |
| Microstructure | `extract_size_strain` | `diffraction/microstructure` |

Other planned work:
- Expose `knowledge/*.md` as **MCP resources**, so an agent can read the domain
  knowledge the tools assume.
- Richer per-tool JSON schemas.
- Assessment variants for single-crystal data (in the R1/wR2/GooF convention)
  and for magnetic refinements.
- An in-browser tool registry, so a chat panel calls the same functions the
  buttons do. Claude Agent SDK tool definitions are another delivery option.

The order across the whole project is in [ROADMAP.md §5](./ROADMAP.md).
