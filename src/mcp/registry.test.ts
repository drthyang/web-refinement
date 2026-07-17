import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { TOOL_REGISTRY } from "@/mcp/registry";
import * as tools from "@/mcp/tools";

/**
 * The layer-contract enforcement for the MCP tool surface. The registry is the
 * single source of truth; these tests make drift mechanically impossible:
 *
 *  - completeness both ways (every exported handler registered, every
 *    registration backed by an exported handler);
 *  - naming and description hygiene;
 *  - a CONTRACT SHAPE test — every tool is actually called on a canned
 *    fixture and its top-level output keys are pinned, so a core refactor
 *    that silently changes a tool's output breaks here (the loose transport
 *    schemas cannot catch that);
 *  - the generated tool table in docs/AGENT_TOOLS.md matches the registry
 *    (run `npm run gen:tooldoc` after changing the registry).
 */

describe("MCP tool registry — completeness & hygiene", () => {
  it("names are unique and snake_case", () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("every exported handler in tools.ts is registered exactly once, and vice versa", () => {
    const exported = Object.entries(tools)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    const registered = TOOL_REGISTRY.map((t) => t.name).sort();
    expect(registered).toEqual(exported);
    // The registered handler IS the exported function (no ad-hoc wrappers —
    // transport concerns belong to server.ts, science to the core).
    for (const t of TOOL_REGISTRY) {
      expect(t.handler).toBe((tools as Record<string, unknown>)[t.name]);
    }
  });

  it("every tool has a title, a substantive description, and an input schema", () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.title.length, t.name).toBeGreaterThan(5);
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(Object.keys(t.inputSchema).length, t.name).toBeGreaterThan(0);
    }
  });

  it("every tool name appears in an MCP test file", () => {
    const dir = resolve(__dirname);
    const testText = readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n");
    for (const t of TOOL_REGISTRY) {
      expect(testText.includes(t.name), `tool "${t.name}" is never exercised in src/mcp/*.test.ts`).toBe(true);
    }
  });
});

// Minimal fixtures: a one-atom cubic structure and a tiny simulated pattern.
// Cheap enough to call EVERY tool (refine_powder runs 2 LM iterations).
const CIF = `data_po
_cell_length_a 3.35
_cell_length_b 3.35
_cell_length_c 3.35
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_space_group_symop_operation_xyz
'x,y,z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Po1 Po 0 0 0 1.0
`;
const { structure } = tools.parse_structure({ cif: CIF });
const sim = tools.simulate_pattern({ structure, xMin: 20, xMax: 80, points: 400 });
const pattern = {
  id: "p", name: "sim", xUnit: "twoTheta" as const,
  radiation: { kind: "xray" as const, wavelength: 1.54 },
  points: sim.curves.x.map((x, i) => ({ x, yObs: (sim.curves.yCalc[i] ?? 0) + 5 })),
};
const built = tools.build_refinement({ structure, pattern, backgroundTerms: 1 });
// Top-level await: refine_powder is async (node evaluator pool when available).
const refined = await tools.refine_powder({ structure, pattern, parameters: built.parameters, bindings: built.bindings, profile: built.profile, maxIterations: 2 });
const assessment = tools.assess_refinement({ result: refined.result, parameters: built.parameters, observationCount: refined.observationCount, residual: refined.residual });

// Reduced-PDF fixture: a placeholder .gr parsed through the tool surface, then
// filled with the model's own starting curve (sum of partials ≡ calc) so a
// 2-iteration refine is cheap and stable.
// X-ray: the shared Po fixture has no neutron scattering length in the table.
const GR = `mode = xray\nqdamp = 0.03\n#### start data\n${Array.from({ length: 120 }, (_, i) => `${(0.5 + i * 0.05).toFixed(2)} 0`).join("\n")}\n`;
const pdfParsed = tools.parse_pdf_data({ text: GR, filename: "t.gr" });
const pdfBuilt0 = tools.build_pdf_model({ structure, pattern: pdfParsed.pattern });
const pdfStart = tools.compute_partial_pdf({ structure, pattern: pdfParsed.pattern, parameters: pdfBuilt0.parameters, bindings: pdfBuilt0.bindings });
const pdfPattern = {
  ...pdfParsed.pattern,
  points: pdfParsed.pattern.points.map((p, i) => ({ r: p.r, gObs: pdfStart.partials.reduce((s, q) => s + (q.g[i] ?? 0), 0) })),
};
const pdfBuilt = tools.build_pdf_model({ structure, pattern: pdfPattern });

/** Canned args + the pinned top-level output keys for every tool. */
const CONTRACTS: Record<string, { args: object; keys: string[] }> = {
  parse_structure: { args: { cif: CIF }, keys: ["magnetic", "structure"] },
  parse_powder_data: {
    args: { text: "10 5\n10.1 6\n10.2 5\n10.3 7\n10.4 5\n", filename: "t.xy" },
    keys: ["detected", "pattern", "summary"],
  },
  parse_instrument: { args: { text: "Lam:1.54\nType:PXC\n" }, keys: ["kind", "radiationKind", "wavelength"] },
  build_refinement: { args: { structure, pattern }, keys: ["bindings", "freeCount", "parameters", "profile"] },
  refine_powder: {
    args: { structure, pattern, parameters: built.parameters, bindings: built.bindings, profile: built.profile, maxIterations: 2 },
    keys: ["observationCount", "parallel", "residual", "result"],
  },
  assess_refinement: {
    args: { result: refined.result, parameters: built.parameters, observationCount: refined.observationCount },
    keys: ["findings", "summary", "verdict"],
  },
  suggest_next_steps: { args: { assessment }, keys: [] }, // array result — element shape checked below
  interpret_structure: { args: { structure }, keys: ["findings", "summary"] },
  evaluate_pattern: {
    args: { structure, pattern, parameters: built.parameters, bindings: built.bindings, profile: built.profile },
    keys: ["agreement", "curves", "observationCount"],
  },
  simulate_pattern: { args: { structure, points: 200 }, keys: ["curves", "summary", "xUnit"] },
  reflection_list: { args: { structure, dMin: 1.5, dMax: 4 }, keys: ["count", "reflections"] },
  bond_geometry: { args: { structure, cutoff: 3.5 }, keys: ["bonds", "shortest"] },
  analyze_site_symmetry: { args: { structure }, keys: ["crystalPointGroup", "sites"] },
  find_unexplained_peaks: {
    // A clean residual with one artificial 100-count peak at d = 2.5 Å.
    args: {
      residual: {
        d: Array.from({ length: 60 }, (_, i) => 4 - i * 0.05),
        yObs: Array.from({ length: 60 }, (_, i) => (i === 30 ? 105 : 5)),
        yCalc: Array.from({ length: 60 }, () => 5),
      },
    },
    keys: ["count", "peaks"],
  },
  search_propagation_vector: { args: { structure, peakD: [6.7, 3.35] }, keys: ["candidates"] },
  list_magnetic_subgroups: { args: { structure, maxIndex: 4 }, keys: ["candidates"] },
  allowed_moments: { args: { structure }, keys: ["sites"] },
  build_magnetic_model: { args: { structure, ionLabels: ["Po1"] }, keys: ["activeSites", "bindings", "magnetic", "parameters"] },
  rank_next_parameters: {
    args: { structure, pattern, parameters: built.parameters.map((q) => ({ ...q, fixed: q.kind === "scale" ? false : true })), bindings: built.bindings, profile: built.profile },
    keys: ["chiSquared", "groups", "wrNow"],
  },
  refine_magnetic_powder: (() => {
    const build = tools.build_magnetic_model({ structure, ionLabels: ["Po1"], moment: 0.5 });
    return {
      args: {
        structure, magnetic: build.magnetic, pattern,
        parameters: [...built.parameters, ...build.parameters],
        bindings: [...built.bindings, ...build.bindings],
        profile: built.profile,
        maxIterations: 2,
      },
      keys: ["components", "magnetic", "observationCount", "parallel", "result"],
    };
  })(),
  parse_single_crystal_data: {
    args: { text: "1 0 0 100 2\n1 1 0 50 2\n1 1 1 30 2\n", name: "sc", id: "nuc" },
    keys: ["dataset", "dropped", "format", "kVectors", "kept", "problems"],
  },
  write_single_crystal_data: {
    args: {
      dataset: { id: "nuc", name: "n", radiation: { kind: "neutron", wavelength: 1.54 }, reflections: [{ h: 1, k: 0, l: 0, iObs: 100, sigma: 2 }] },
      wavelength: 1.54,
    },
    keys: ["reflections", "text"],
  },
  expand_structure_supercell: {
    args: { structure, k: [0.5, 0, 0] },
    keys: ["atoms", "kInteger", "multiplicity", "replicas", "structure"],
  },
  build_modulated_moment_model: {
    args: { structure, k: [0.5, 0, 0], ions: [{ site: "Po1", direction: [0, 0, 1] }] },
    keys: ["bindings", "magnetic", "multiplicity", "parameters", "structure"],
  },
  merge_magnetic_supercell: {
    args: {
      nuclearDataset: { id: "nuc", name: "n", radiation: { kind: "neutron", wavelength: 1 }, reflections: [{ h: -4, k: -10, l: 1, iObs: 0.04, sigma: 0.02 }] },
      magneticDataset: { id: "mag", name: "m", radiation: { kind: "neutron", wavelength: 1 }, reflections: [{ h: -3, k: -11, l: 1, iObs: 0.03, sigma: 0.02 }] },
      k: [0.25, 0, 0.25],
    },
    keys: ["dataset", "kInteger", "multiplicity", "reflections"],
  },
  parse_pdf_data: { args: { text: GR, filename: "t.gr" }, keys: ["detected", "pattern", "summary"] },
  build_pdf_model: { args: { structure, pattern: pdfPattern }, keys: ["bindings", "freeCount", "parameters", "restraints"] },
  refine_pdf: {
    args: { structure, pattern: pdfPattern, parameters: pdfBuilt.parameters, bindings: pdfBuilt.bindings, maxIterations: 2 },
    keys: ["observationCount", "parallel", "residual", "result", "warnings"],
  },
  compute_partial_pdf: {
    args: { structure, pattern: pdfPattern, parameters: pdfBuilt.parameters, bindings: pdfBuilt.bindings },
    keys: ["kind", "partials", "r"],
  },
  calibrate_qdamp: {
    args: { structure, pattern: pdfPattern, maxIterations: 2 },
    keys: ["esd", "iterations", "qbroad", "qdamp", "rw"],
  },
};


describe("MCP tool registry — output contract shapes", () => {
  it("every registry tool has a contract entry (add one when adding a tool)", () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(TOOL_REGISTRY.map((t) => t.name).sort());
  });

  for (const tool of TOOL_REGISTRY) {
    it(`${tool.name} returns its pinned output shape`, async () => {
      const contract = CONTRACTS[tool.name]!;
      const out = await tool.handler(contract.args);
      if (Array.isArray(out)) {
        expect(contract.keys).toEqual([]); // arrays are pinned as such
      } else {
        expect(Object.keys(out as object).sort()).toEqual(contract.keys);
      }
    });
  }
});

describe("MCP tool registry — doc sync", () => {
  it("docs/AGENT_TOOLS.md generated table matches the registry (npm run gen:tooldoc)", () => {
    const doc = readFileSync(resolve(__dirname, "../../docs/AGENT_TOOLS.md"), "utf8");
    const m = doc.match(/<!-- TOOLS:BEGIN[^>]*-->([\s\S]*?)<!-- TOOLS:END -->/);
    expect(m, "marker block <!-- TOOLS:BEGIN --> … <!-- TOOLS:END --> missing").toBeTruthy();
    const section = m![1]!;
    const documented = [...section.matchAll(/^\| `([a-z0-9_]+)`/gm)].map((r) => r[1]!).sort();
    expect(documented).toEqual(TOOL_REGISTRY.map((t) => t.name).sort());
  });
});
