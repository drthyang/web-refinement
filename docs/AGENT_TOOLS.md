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

## 1. The app's core as agent tools

The goal is a thin, typed tool layer over `src/core/**` — no new science, just a
callable surface. Candidate tools, each a pure function mapping JSON → JSON:

| Tool | Wraps | In → out |
|---|---|---|
| `parse_structure` | `parsers/cif` | CIF text → `StructureModel` (cell, sites, space group) |
| `parse_powder_data` | `parsers/powderData` + `detectFormat` | file text → pattern + detected unit/radiation |
| `parse_instrument` | `parsers/instrument` | `.instprm` → CW/TOF calibration |
| `build_refinement` | `workflow/structureRefinement` | structure + pattern + instrument → parameter set + bindings + staged plan |
| `refine_powder` | `workflow/powder` + `refinement/engine` | parameters (+ fit range, background type, staged) → refined values, esds, agreement, diagnostics, per-cycle history |
| `evaluate_pattern` | `workflow/powder` | parameters → obs/calc/bkg/diff curves + wR/GoF |
| `reflection_ticks` | `diffraction/reflections` | cell + space group → hkl positions |
| `magnetic_candidates` | `workflow/magnetic` | structure + k → allowed magnetic space groups |
| `bond_geometry` | `crystal/geometry` | structure → bond lengths/angles for sanity checks |

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

**Tools shipped:** `parse_structure`, `parse_powder_data`, `parse_instrument`,
`build_refinement`, `refine_powder`, `assess_refinement`, `suggest_next_steps`,
`interpret_structure`, plus the **analysis primitives** `evaluate_pattern`
(obs/calc + wR at the current values — the cheap what-if, with separate
nuclear/magnetic components when a magnetic model is passed),
`simulate_pattern` (structure-only pattern on a CW/TOF instrument),
`reflection_list` (hkl/d/multiplicity, `absences:false` keeps the
nuclear-extinct families where AFM satellites live), and `bond_geometry`
(nearest-neighbour distance sanity). `assess_refinement` /
`suggest_next_steps` / `interpret_structure` are the judgement layer — the
"figure out what matters and guide the next step" surface — and live as pure,
tested core in [`src/core/diagnostics/`](../src/core/diagnostics)
(`assessment.ts`, `interpret.ts`), so the same functions can back a future
in-app chat panel. The whole expert loop runs end to end on the real GaNb4Se8
dataset, and the primitives are covered data-free by a simulate→evaluate
self-consistency loop (see `src/mcp/tools.test.ts`).

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
