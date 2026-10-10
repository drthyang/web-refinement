# Changelog

Notable changes to MATERIA, newest first. Releases are tagged `vX.Y.Z` on `main`.
While the major version is 0, a minor release adds a feature or changes how the
tool is used (file formats, saved projects, CLI flags, API, URLs), and a patch
release fixes bugs.

## [Unreleased]

### Added

- **The Agent on LM Studio.** A fourth way to reach a model: a local model on
  your LM Studio server (0.4.1 or later, with CORS on), listed from the server
  with each model's loaded context.

### Removed

- **The Agent's Claude Code mode**, with the `materia-live` MCP server, its
  `mcp:live` / `build:mcp-live` scripts and its `.mcp.json` entry. The Agent
  now starts on your own API key; a saved Claude Code choice falls back to it.
  The `materia` MCP server is unchanged.

## [0.3.0] - 2026-10-09

### Added

- **The in-app Agent** (#37). A model beside the workbench reads the live powder
  or PDF analysis, judges it with MATERIA's analysis tools, and makes changes
  through the page's own controls. Every change waits for your approval and
  becomes a History step tagged as the agent's, so it can be undone. No tool
  types in a parameter value: the model chooses what to free and when to refine,
  and the least-squares engine sets every value. Four ways to reach a model:
  Claude Code (the `materia-live` MCP server), your Anthropic API key, a local
  proxy on the dev server, or a local model on your Ollama server.
- **Step history** (#13, #14, #24, #26). Go back to any refinement step on the
  powder, single-crystal and PDF pages. The history is a tree, autosaved and
  saved with the project; the step you are on shows beside the back/forward
  arrows.
- **Validation views** (#36): a verdict, residual analysis (powder) and analysis
  of variance (single crystal).
- **S(Q) error propagation** (#28): S(Q) error ribbons, and exact propagation of
  the S(Q) uncertainties to G(r).
- **The cell and space-group gate** (#15): `check_cell_symmetry` refines the cell
  with a Le Bail fit, then checks that every leftover peak indexes and every
  forbidden reflection carries no intensity.
- **MCP tools an LLM can drive** (#10, #12, #16, #25, #30): data travels by
  reference, files by path, and `free` takes globs; the `export_bundle` tool;
  worked examples of an LLM driving the tools, replayed in CI.
- **Layouts** for iPhone, iPad, MacBook and 1K/2K/4K screens (#19). The
  refinement result folds into one collapsible section (#20).
- Refinement convergence is reported as max shift/esd (#23).
- The Mn₃Ga demo opens on a fit window; the MCP magnetic refinement takes moment
  restarts; a compact history card (#21).

### Fixed

- Magnetic dipole form factor: the sign of the ⟨j₂⟩ term (#22).
- Scattering tables, space-group settings, CIF types and reflection truncation
  (#27); CIF tokens, label case, isotopes and symbol-less export (#32).
- FullProf and GSAS-II exports use the right conventions and carry the full
  refined model; TOF sig-q is linear in d (#29). Cross-check bundles carry the
  refined structure (#12).
- Each profile peak fades to zero at its support edge (#18).
- Le Bail: the TOF peak shape, the net-intensity partition, and impurity phases
  in the cell gate (#33).
- A staged refinement that re-fixes a parameter keeps a fit of the values it
  returns (#35).
- The assessment words a held out-of-range value as an input, not a refined one
  (#31).
- Reopening a PDF project restores its last result, and Reset behaves the same
  on every page (#14).
