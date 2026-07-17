import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "@/mcp/registry";

/**
 * The P6 gate for the nuclear PDF track: an agent completes the whole study —
 * parse structure → parse G(r) → build model → staged refine → decompose →
 * calibrate — through the MCP tool surface ONLY (handlers resolved by name
 * from the registry, JSON in/out, no core imports).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(name: string, args: object): any {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.handler(args);
}

const cifFor = (a: number, u: number): string => `data_ni
_cell_length_a ${a}
_cell_length_b ${a}
_cell_length_c ${a}
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
_atom_site_U_iso_or_equiv
Ni1 Ni 0 0 0 1.0 ${u}
Ni2 Ni 0.5 0.5 0 1.0 ${u}
Ni3 Ni 0.5 0 0.5 1.0 ${u}
Ni4 Ni 0 0.5 0.5 1.0 ${u}
`;

describe("agent loop — nuclear PDF study via MCP tools only", () => {
  it("load → build → staged refine → partials → calibrate, recovering the truth", async () => {
    // 1. The truth: parse the reference structure and synthesize its G(r)
    //    through the tool surface (partials sum ≡ calc).
    const TRUE_A = 3.524;
    const truth = call("parse_structure", { cif: cifFor(TRUE_A, 0.005) });
    const rows = Array.from({ length: 480 }, (_, i) => `${(0.4 + i * 0.02).toFixed(2)} 0`);
    const placeholder = call("parse_pdf_data", {
      text: `mode = neutron\nqmax = 22\nqdamp = 0.03\n#### start data\n${rows.join("\n")}\n`,
      filename: "ni.gr",
    });
    expect(placeholder.detected.dataType).toBe("pdf");
    const truthModel = call("build_pdf_model", { structure: truth.structure, pattern: placeholder.pattern });
    const truthPartials = call("compute_partial_pdf", {
      structure: truth.structure, pattern: placeholder.pattern,
      parameters: truthModel.parameters, bindings: truthModel.bindings,
    });
    const gTrue: number[] = placeholder.pattern.points.map((_: unknown, i: number) =>
      truthPartials.partials.reduce((s: number, p: { g: number[] }) => s + (p.g[i] ?? 0), 0),
    );
    const grText = `mode = neutron\nqmax = 22\nqdamp = 0.03\n#### start data\n${placeholder.pattern.points
      .map((p: { r: number }, i: number) => `${p.r.toFixed(2)} ${gTrue[i]!.toPrecision(8)}`)
      .join("\n")}\n`;

    // 2. The study, from a perturbed starting model (+0.6 % cell, U ×2).
    const parsed = call("parse_pdf_data", { text: grText, filename: "ni_obs.gr" });
    expect(parsed.summary.qmax).toBe(22);
    const start = call("parse_structure", { cif: cifFor(3.545, 0.01) });
    const model = call("build_pdf_model", { structure: start.structure, pattern: parsed.pattern });
    expect(model.freeCount).toBeGreaterThan(0);

    // 3. Staged refinement with ADPs freed, low-r artifact region excluded.
    const params = model.parameters.map((p: { kind: string; fixed: boolean }) =>
      p.kind === "bIso" ? { ...p, fixed: false } : p,
    );
    const refined = await call("refine_pdf", {
      structure: start.structure, pattern: parsed.pattern,
      parameters: params, bindings: model.bindings, restraints: model.restraints,
      staged: true, fitRange: { min: 1.0 }, maxIterations: 30,
    });
    expect(refined.result.status).toBe("converged");
    expect(refined.warnings).toEqual([]);
    const aEntry = Object.entries(refined.result.parameters).find(([id]) => id.startsWith("cell_"));
    expect(aEntry).toBeDefined();
    expect(Math.abs((aEntry![1] as number) - TRUE_A)).toBeLessThan(2e-3);
    expect(refined.result.agreement.rWeighted ?? 1).toBeLessThan(0.02);

    // 4. Interpretation + calibration on the (single-element) standard.
    const partials = call("compute_partial_pdf", {
      structure: start.structure, pattern: parsed.pattern,
      parameters: params.map((p: { id: string; value: number }) => ({ ...p, value: refined.result.parameters[p.id] ?? p.value })),
      bindings: model.bindings,
    });
    expect(partials.kind).toBe("element-pairs");
    expect(partials.partials.map((p: { label: string }) => p.label)).toEqual(["Ni–Ni"]);

    const cal = call("calibrate_qdamp", { structure: truth.structure, pattern: parsed.pattern, maxIterations: 20 });
    expect(cal.qdamp).toBeGreaterThan(0.02);
    expect(cal.qdamp).toBeLessThan(0.05);
  }, 120000);
});
