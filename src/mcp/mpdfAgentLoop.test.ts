import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "@/mcp/registry";

/**
 * The P4/P6 gate for the MAGNETIC PDF track: an agent completes a whole mPDF
 * study — parse structure → parse neutron G(r) → build the symmetry-allowed
 * spin model → check the magnetic signal is worth fitting → co-refine nuclear +
 * magnetic — through the MCP tool surface ONLY (handlers resolved by name from
 * the registry, JSON in/out, no core imports). The nuclear sibling is
 * pdfAgentLoop.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(name: string, args: object): any {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.handler(args);
}

/** One-atom Mn cell — Mn has both a tabulated b (−3.73 fm) and an ⟨j0⟩ form
 *  factor, so a neutron PDF over it carries a real magnetic term. */
const cifFor = (a: number, u: number): string => `data_mn
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
Mn1 Mn 0 0 0 1.0 ${u}
`;

const TRUE_A = 4.40;
const TRUE_MOMENT = 3.0;
const K_AFM: [number, number, number] = [0, 0, 0.5];
const R_ROWS = Array.from({ length: 400 }, (_, i) => `${(0.5 + i * 0.02).toFixed(2)} 0`);
const header = "mode = neutron\nqdamp = 0.02\n#### start data\n";

describe("agent loop — magnetic PDF study via MCP tools only", () => {
  it("parse → spin model → component check → co-refine, recovering the truth moment", async () => {
    // 1. The truth: an AFM Mn box with k = (0,0,½), synthesized through the
    //    tool surface so the "observed" G(r) is the model's own total.
    const truth = call("parse_structure", { cif: cifFor(TRUE_A, 0.005) });
    const placeholder = call("parse_pdf_data", { text: header + R_ROWS.join("\n") + "\n", filename: "mn.gr" });
    expect(placeholder.pattern.scatteringType).toBe("neutron");

    const truthMag = call("build_magnetic_model", {
      structure: truth.structure, ionLabels: ["Mn1"], k: K_AFM, moment: TRUE_MOMENT,
    });
    expect(truthMag.activeSites).toEqual(["Mn1"]);
    const truthModel = call("build_mpdf_model", {
      structure: truth.structure, pattern: placeholder.pattern,
      magnetic: truthMag.magnetic, parameters: truthMag.parameters, bindings: truthMag.bindings,
    });
    expect(truthModel.warnings).toEqual([]);

    const truthComponents = call("compute_mpdf_components", {
      structure: truth.structure, magnetic: truthModel.magnetic, pattern: placeholder.pattern,
      parameters: truthModel.parameters, bindings: truthModel.bindings,
    });
    // The magnetic term must be a real, fittable fraction of the signal —
    // otherwise this gate would "pass" on an all-nuclear fit.
    expect(truthComponents.magneticFraction).toBeGreaterThan(0.02);

    const grText = header + placeholder.pattern.points
      .map((p: { r: number }, i: number) => `${p.r.toFixed(2)} ${truthComponents.components.gCalc[i]!.toPrecision(10)}`)
      .join("\n") + "\n";

    // 2. The study from a perturbed start: cell +0.7 %, moment at 60 % of truth.
    const parsed = call("parse_pdf_data", { text: grText, filename: "mn_obs.gr" });
    const start = call("parse_structure", { cif: cifFor(4.43, 0.005) });
    const mag = call("build_magnetic_model", {
      structure: start.structure, ionLabels: ["Mn1"], k: K_AFM, moment: 1.8,
    });
    const model = call("build_mpdf_model", {
      structure: start.structure, pattern: parsed.pattern,
      magnetic: mag.magnetic, parameters: mag.parameters, bindings: mag.bindings,
    });
    expect(model.freeCount).toBeGreaterThan(0);

    // 3. Co-refine: free the cell, the PDF scale and the moment modes. The
    //    mPDF scales stay fixed — mpdfOrdScale is degenerate with |m|.
    const params = model.parameters.map((p: { kind: string; fixed: boolean }) =>
      p.kind === "momentMode" || p.kind === "cellLength" || p.kind === "pdfScale"
        ? { ...p, fixed: false }
        : { ...p, fixed: true },
    );
    const refined = await call("refine_mpdf", {
      structure: start.structure, magnetic: model.magnetic, pattern: parsed.pattern,
      parameters: params, bindings: model.bindings, restraints: model.restraints,
      fitRange: { min: 1.0 }, maxIterations: 40,
    });

    expect(refined.warnings).toEqual([]);
    // Status is deliberately NOT asserted: on exact synthetic data the fit
    // reaches χ² ≈ 1e-17 and then grinds at machine epsilon, so it exhausts the
    // iteration budget without ever tripping the relative tolerance. The
    // recovered values below are the real gate.
    const aEntry = Object.entries(refined.result.parameters).find(([id]) => id.startsWith("cell_"));
    expect(Math.abs((aEntry![1] as number) - TRUE_A)).toBeLessThan(2e-3);
    // The moment is recovered up to the global ±m (time-reversal) degeneracy.
    const moment = Math.hypot(...refined.magnetic.moments[0]!.components);
    expect(moment).toBeCloseTo(TRUE_MOMENT, 1);
    expect(refined.result.agreement.rWeighted ?? 1).toBeLessThan(0.02);

    // 4. The refined magnetic model comes back as a usable MagneticModel, and
    //    the separated curves still sum to the total.
    expect(refined.magnetic.propagation).toEqual([K_AFM]);
    const c = refined.components;
    for (let i = 0; i < c.r.length; i += 37) {
      expect(c.gNuclear[i]! + c.gMagnetic[i]!).toBeCloseTo(c.gCalc[i]!, 10);
    }
  }, 120000);

  it("a spin model whose site labels miss the structure is called out, not silently ignored", async () => {
    const s = call("parse_structure", { cif: cifFor(TRUE_A, 0.005) });
    const parsed = call("parse_pdf_data", { text: header + R_ROWS.join("\n") + "\n", filename: "mn.gr" });
    const mag = call("build_magnetic_model", { structure: s.structure, ionLabels: ["Mn1"], k: K_AFM, moment: TRUE_MOMENT });
    // The classic mismatch: the model was built on a structure whose site is
    // labelled differently from the one being refined. Nothing errors — the
    // magnetic term just vanishes and every moment column goes exactly zero.
    const renamed = { ...mag.magnetic, moments: mag.magnetic.moments.map((m: object) => ({ ...m, siteLabel: "Mn_other" })) };

    const model = call("build_mpdf_model", {
      structure: s.structure, pattern: parsed.pattern,
      magnetic: renamed, parameters: mag.parameters, bindings: mag.bindings,
    });
    expect(model.warnings.join(" ")).toMatch(/identically zero|siteLabel/i);

    const c = call("compute_mpdf_components", {
      structure: s.structure, magnetic: renamed, pattern: parsed.pattern,
      parameters: model.parameters, bindings: model.bindings,
    });
    expect(c.magneticPeak).toBe(0);
    expect(c.nuclearPeak).toBeGreaterThan(0);

    const refined = await call("refine_mpdf", {
      structure: s.structure, magnetic: renamed, pattern: parsed.pattern,
      parameters: model.parameters, bindings: model.bindings, maxIterations: 2,
    });
    expect(refined.warnings.join(" ")).toMatch(/identically zero|siteLabel/i);
  }, 60000);

  it("an X-ray PDF is refused a magnetic term, loudly", () => {
    const s = call("parse_structure", { cif: cifFor(TRUE_A, 0.005) });
    const xray = call("parse_pdf_data", {
      text: "mode = xray\n#### start data\n" + R_ROWS.join("\n") + "\n", filename: "x.gr",
    });
    const mag = call("build_magnetic_model", { structure: s.structure, ionLabels: ["Mn1"], k: K_AFM, moment: TRUE_MOMENT });
    const model = call("build_mpdf_model", {
      structure: s.structure, pattern: xray.pattern,
      magnetic: mag.magnetic, parameters: mag.parameters, bindings: mag.bindings,
    });
    expect(model.warnings.join(" ")).toMatch(/no magnetic dipole term|identically zero/i);
    const c = call("compute_mpdf_components", {
      structure: s.structure, magnetic: model.magnetic, pattern: xray.pattern,
      parameters: model.parameters, bindings: model.bindings,
    });
    expect(c.magneticFraction).toBe(0);
  });

  // A CIF with no ADP column loads at B_iso = 0, which makes the NUCLEAR term
  // delta-sharp — and the moments are then fitted against whatever the
  // collapsing nuclear scale leaves behind, so the magnetic answer is wrong
  // too. Same guard as build_pdf_model (see zeroAdpWarning).
  it("a structure with no displacement parameter is called out before the moments are fitted", () => {
    const noAdpCif = cifFor(TRUE_A, 0.005)
      .replace("_atom_site_U_iso_or_equiv\n", "")
      .replace(" 0.005\n", "\n");
    const s = call("parse_structure", { cif: noAdpCif });
    expect(s.structure.sites[0].adp).toEqual({ kind: "isotropic", bIso: 0 });
    const neutron = call("parse_pdf_data", { text: header + R_ROWS.join("\n") + "\n", filename: "mn.gr" });
    const mag = call("build_magnetic_model", { structure: s.structure, ionLabels: ["Mn1"], k: K_AFM, moment: TRUE_MOMENT });
    const model = call("build_mpdf_model", {
      structure: s.structure, pattern: neutron.pattern,
      magnetic: mag.magnetic, parameters: mag.parameters, bindings: mag.bindings,
    });
    expect(model.warnings.join(" ")).toMatch(/No displacement parameter on site Mn1 \(B_iso = 0\)/);
  });
});
