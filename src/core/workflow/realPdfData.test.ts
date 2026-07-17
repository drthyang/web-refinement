/**
 * Real-data PDF smoke fits (data-gated; skip without the local data/ folder):
 * each dataset runs the full agent workflow through the MCP tools and pins
 * LOOSE physical expectations — converged, sane Rw, cell near the reference.
 * These are the "does the engine survive real reductions" gates, complementing
 * the committed PDFfit2 goldens (exact synthetic references).
 */
import { describe, it, expect } from "vitest";
import { dataExists, readData } from "@/testSupport/data";
import * as tools from "@/mcp/tools";
import type { PdfPattern } from "@/core/diffraction/types";
import type { RefinementParameter } from "@/core/refinement/types";

function truncate(pattern: PdfPattern, rMax: number): PdfPattern {
  return { ...pattern, points: pattern.points.filter((p) => p.r <= rMax) };
}

function report(name: string, refined: Awaited<ReturnType<typeof tools.refine_pdf>>, params: RefinementParameter[]): void {
  const r = refined.result;
  const byKind = (kind: string): string =>
    params.filter((p) => p.kind === kind)
      .map((p) => `${p.label}=${(r.parameters[p.id] ?? p.value).toPrecision(6)}${r.esd[p.id] ? `(${r.esd[p.id]!.toPrecision(2)})` : ""}`)
      .join(" ");
  // eslint-disable-next-line no-console
  console.log(`[${name}] ${r.status} in ${r.history.length} cycles · Rw=${((r.agreement.rWeighted ?? 0) * 100).toFixed(2)}%
  cell: ${byKind("cellLength")}
  scale: ${byKind("pdfScale")} qdamp: ${byKind("qdamp")} qbroad: ${byKind("qbroad")} δ2: ${byKind("delta2")}
  warnings: ${refined.warnings.join("; ") || "none"}`);
}

const NI_GR = "Ni_PDF_data/Ni_cryostat_Feb_PDF_20210210-140444_f64884_0001_dark_corrected_img_L1_U97_percentile_masked_q.gr";
const FCS_GR = "FeCoSn_PDF/PG3_48288_PDF_1p7K_Q30.gr";
const FCS_CIF = "FeCoSn_PDF/Fe1Co9Sn_300K.cif";
const GANB_GR = "GaNb4Se8_PDF_Qmax_27/GaNb4Se8_101_T_base_5.8K_T_FC0.0K_Sample_X_5.78mm_DetZ_3674.0mm_new_masked_L1_U98_q.dat_bgsub_scale_0.28_shift_110.gr";
const GANB_CIF = "GaNb4Se8_XRD/GaNb4Se8_100K.cif";
const GTS_GR = "GaTa4Se8_NOMAD/PDF/01_GTS_at_5K.gr";
const GTS_CIF = "GaTa4Se8_NOMAD/GTS_5K.cif";

const FCC: readonly [number, number, number][] = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];
const NI_STRUCTURE: import("@/core/crystal/types").StructureModel = {
  id: "ni", name: "Ni", cell: { a: 3.524, b: 3.524, c: 3.524, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { operations: [{ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" }] },
  sites: FCC.map((p, i) => ({ label: `Ni${i + 1}`, element: "Ni", position: p, occupancy: 1, adp: { kind: "isotropic" as const, bIso: 0.4 } })),
};

describe.skipIf(!dataExists(NI_GR))("REAL Ni standard (28-ID X-ray) — calibration", () => {
  it("full standard fit: cell+B+scale+Qdamp+Qbroad+δ2", async () => {
    const parsed = tools.parse_pdf_data({ text: readData(NI_GR), filename: "ni.gr" });
    const pattern = truncate(parsed.pattern, 30);
    const model = tools.build_pdf_model({ structure: NI_STRUCTURE, pattern });
    const params = model.parameters.map((p) => {
      if (p.kind === "bIso" || p.id === "delta2" || p.id === "qdamp" || p.id === "qbroad") return { ...p, fixed: false };
      if (p.kind === "cellAngle") return { ...p, fixed: true };
      return p;
    });
    const refined = await tools.refine_pdf({
      structure: NI_STRUCTURE, pattern, parameters: params, bindings: model.bindings,
      restraints: model.restraints, staged: true, fitRange: { min: 1.5, max: 28 }, maxIterations: 40,
    });
    report("Ni standard", refined, params);
    const cal = tools.calibrate_qdamp({ structure: NI_STRUCTURE, pattern, fitRange: { min: 1.5, max: 28 }, maxIterations: 30 });
    // eslint-disable-next-line no-console
    console.log(`[Ni calibrate_qdamp] qdamp=${cal.qdamp.toPrecision(4)}(${cal.esd.qdamp?.toPrecision(2)}) qbroad=${cal.qbroad.toPrecision(4)} Rw=${((cal.rw ?? 0) * 100).toFixed(2)}%`);
    expect(refined.result.status).toBe("converged");
    expect(refined.result.agreement.rWeighted ?? 1).toBeLessThan(0.15);
    expect(cal.qdamp).toBeGreaterThan(0.02);
    expect(cal.qdamp).toBeLessThan(0.07);
  }, 300000);
});

describe.skipIf(!dataExists(FCS_GR) || !dataExists(FCS_CIF))("REAL Fe0.1Co0.9Sn 1.7K (POWGEN neutron) — vs PDFgui", () => {
  it("staged fit lands near the PDFgui-refined cell (a 5.2722, c 4.2677)", async () => {
    const { structure } = tools.parse_structure({ cif: readData(FCS_CIF) });
    const parsed = tools.parse_pdf_data({ text: readData(FCS_GR), filename: "fecosn.gr" });
    const pattern = truncate(parsed.pattern, 30);
    const model = tools.build_pdf_model({ structure, pattern });
    // POWGEN instrument constants from the user's PDFgui fit; δ2 free.
    const params = model.parameters.map((p) => {
      if (p.id === "qdamp") return { ...p, value: 0.0155299 };
      if (p.id === "qbroad") return { ...p, value: 0.0120727 };
      if (p.kind === "bIso" || p.id === "delta2") return { ...p, fixed: false };
      if (p.kind === "cellAngle") return { ...p, fixed: true };
      return p;
    });
    const refined = await tools.refine_pdf({
      structure, pattern, parameters: params, bindings: model.bindings,
      restraints: model.restraints, staged: true, fitRange: { min: 1.7, max: 28 }, maxIterations: 40,
    });
    report("FeCoSn 1.7K", refined, params);
    expect(refined.result.status).toBe("converged");
    // PDFgui refined a = 5.272188, c = 4.267749 on this data; agree to < 6 mÅ
    // (δ2/ADP conventions differ between the fits — see the golden notes).
    const a = params.find((p) => p.id === "cell_a")!;
    const c = params.find((p) => p.id === "cell_c")!;
    expect(Math.abs((refined.result.parameters[a.id] ?? 0) - 5.272188)).toBeLessThan(6e-3);
    expect(Math.abs((refined.result.parameters[c.id] ?? 0) - 4.267749)).toBeLessThan(6e-3);
    expect(refined.result.agreement.rWeighted ?? 1).toBeLessThan(0.25);
  }, 300000);
});

describe.skipIf(!dataExists(GANB_GR) || !dataExists(GANB_CIF))("REAL GaNb4Se8 5.8K (28-ID X-ray)", () => {
  it("cubic (100 K) model against the base-T frame", async () => {
    const { structure } = tools.parse_structure({ cif: readData(GANB_CIF) });
    // eslint-disable-next-line no-console
    console.log(`[GaNb4Se8 model] ${structure.spaceGroup.hermannMauguin ?? "?"} · a=${structure.cell.a} · ${structure.sites.length} sites`);
    const parsed = tools.parse_pdf_data({ text: readData(GANB_GR), filename: "ganb.gr" });
    const pattern = truncate(parsed.pattern, 30);
    const model = tools.build_pdf_model({ structure, pattern });
    const params = model.parameters.map((p) => {
      if (p.id === "qdamp") return { ...p, value: 0.035 }; // 28-ID ballpark; Ni calibration refines this
      if (p.kind === "bIso" || p.id === "delta2") return { ...p, fixed: false };
      if (p.kind === "cellAngle") return { ...p, fixed: true };
      return p;
    });
    const refined = await tools.refine_pdf({
      structure, pattern, parameters: params, bindings: model.bindings,
      restraints: model.restraints, staged: true, fitRange: { min: 1.5, max: 27 }, maxIterations: 40,
    });
    report("GaNb4Se8 5.8K", refined, params);
    expect(refined.result.status).toBe("converged");
    expect(refined.result.agreement.rWeighted ?? 1).toBeLessThan(0.2);
  }, 600000);
});

describe.skipIf(!dataExists(GTS_GR) || !dataExists(GTS_CIF))("REAL GaTa4Se8 5K (NOMAD neutron)", () => {
  it("5 K model against the 5 K frame", async () => {
    const { structure } = tools.parse_structure({ cif: readData(GTS_CIF) });
    // eslint-disable-next-line no-console
    console.log(`[GTS model] ${structure.spaceGroup.hermannMauguin ?? "?"} · a=${structure.cell.a} · ${structure.sites.length} sites`);
    const parsed = tools.parse_pdf_data({ text: readData(GTS_GR), filename: "gts.gr" });
    const pattern = truncate(parsed.pattern, 30);
    const model = tools.build_pdf_model({ structure, pattern });
    const params = model.parameters.map((p) => {
      if (p.id === "qdamp") return { ...p, value: 0.02 }; // NOMAD ballpark
      if (p.kind === "bIso" || p.id === "delta2") return { ...p, fixed: false };
      if (p.kind === "cellAngle") return { ...p, fixed: true };
      return p;
    });
    const refined = await tools.refine_pdf({
      structure, pattern, parameters: params, bindings: model.bindings,
      restraints: model.restraints, staged: true, fitRange: { min: 1.5, max: 28 }, maxIterations: 40,
    });
    report("GaTa4Se8 5K", refined, params);
    expect(refined.result.status).toBe("converged");
  }, 600000);
});
