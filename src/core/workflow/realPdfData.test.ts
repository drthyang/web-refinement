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
import { buildPdfSpec } from "@/core/workflow/pdf";
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

// --- Local-structure head-to-head: cubic average vs the distorted P2_13 model
// (extracted from the user's PDFgui P213.ddp refined 5.8 K state; their
// protocol: r = 2-10 A, qdamp 0.0383, qbroad 0.0472, PDFgui Rw 8.88%). ---
const P213_CIF = "GaNb4Se8_PDF_Qmax_27/P213_5p8K_extracted.cif";

const trunc2 = (p: PdfPattern, rMax: number): PdfPattern => ({ ...p, points: p.points.filter((q) => q.r <= rMax) });

async function localFit(structure: object, pattern: PdfPattern, qdamp: number, qbroad: number, label: string): Promise<number> {
  const model = tools.build_pdf_model({ structure: structure as never, pattern });
  const params = model.parameters.map((p) => {
    if (p.id === "qdamp") return { ...p, value: qdamp };
    if (p.id === "qbroad") return { ...p, value: qbroad };
    if (p.kind === "bIso" || p.id === "delta2") return { ...p, fixed: false };
    if (p.kind === "cellAngle") return { ...p, fixed: true };
    return p;
  });
  const refined = await tools.refine_pdf({
    structure: structure as never, pattern, parameters: params, bindings: model.bindings,
    restraints: model.restraints, staged: true, fitRange: { min: 2.0, max: 10.0 }, maxIterations: 40,
  });
  const rw = refined.result.agreement.rWeighted ?? 1;
  const aP = params.find((p) => p.kind === "cellLength")!;
  // eslint-disable-next-line no-console
  console.log(`[${label}] ${refined.result.status} · Rw(2–10 Å)=${(rw * 100).toFixed(2)}% · a=${(refined.result.parameters[aP.id] ?? 0).toFixed(5)} · free=${params.filter((p) => !p.fixed && !p.expression).length}`);
  expect(refined.result.status).toBe("converged");
  return rw;
}

describe.skipIf(!dataExists(GANB_GR) || !dataExists(P213_CIF))("GaNb4Se8 5.8K — cubic vs P2₁3 local fit (r = 2–10 Å, PDFgui settings)", () => {
  it("distorted P2₁3 beats the cubic average; target: PDFgui Rw 8.88%", async () => {
    const pattern = trunc2(tools.parse_pdf_data({ text: readData(GANB_GR), filename: "g.gr" }).pattern, 12);
    const cubic = tools.parse_structure({ cif: readData(GANB_CIF) }).structure;
    const p213 = tools.parse_structure({ cif: readData(P213_CIF) }).structure;
    // eslint-disable-next-line no-console
    console.log(`[models] cubic ${cubic.spaceGroup.hermannMauguin} ${cubic.sites.length} sites · p213 ${p213.spaceGroup.hermannMauguin} ${p213.sites.length} sites`);
    const rwCubic = await localFit(cubic, pattern, 0.0383, 0.0472, "GaNb cubic 2–10");
    const rwP213 = await localFit(p213, pattern, 0.0383, 0.0472, "GaNb P213 2–10");
    expect(rwP213).toBeLessThan(rwCubic);
  }, 600000);
});

describe.skipIf(!dataExists(GTS_GR) || !dataExists(P213_CIF))("GaTa4Se8 5K — Ta-substituted P2₁3 local fit", () => {
  it("the distorted model fits the NOMAD 5K frame far better than cubic", async () => {
    const pattern = trunc2(tools.parse_pdf_data({ text: readData(GTS_GR), filename: "gts.gr" }).pattern, 12);
    const p213 = tools.parse_structure({ cif: readData(P213_CIF) }).structure;
    const scale = 10.3563 / p213.cell.a;
    const gts = {
      ...p213,
      cell: { ...p213.cell, a: p213.cell.a * scale, b: p213.cell.b * scale, c: p213.cell.c * scale },
      sites: p213.sites.map((s) => (s.element === "Nb" ? { ...s, element: "Ta", label: s.label.replace("Nb", "Ta") } : s)),
    };
    const cubic = tools.parse_structure({ cif: readData("GaTa4Se8_NOMAD/GTS_5K.cif") }).structure;
    const rwCubic = await localFit(cubic, pattern, 0.02, 0, "GTS cubic 2–10");
    const rwP213 = await localFit(gts, pattern, 0.02, 0, "GTS P213 2–10");
    expect(rwP213).toBeLessThan(rwCubic);
  }, 600000);
});

// --- Distortion-mode fitting (AMPLIMODES paradigm): decompose the P2_13 child
// against the cubic F-43m parent and fit the FROZEN-MODE AMPLITUDE — one
// order-parameter instead of 13 coordinates. ---
describe.skipIf(!dataExists(GANB_GR) || !dataExists(P213_CIF) || !dataExists(GANB_CIF))("GaNb4Se8 5.8K — frozen-mode amplitude fit (F-43m → P2_13)", () => {
  it("one mode amplitude captures the distortion (vs 13 free positions)", async () => {
    const { buildDistortionModes, withDistortionModes } = await import("@/core/crystal/distortionModes");
    const parent = tools.parse_structure({ cif: readData(GANB_CIF) }).structure;
    const p213 = tools.parse_structure({ cif: readData(P213_CIF) }).structure;
    const set = buildDistortionModes(parent, p213);
    // eslint-disable-next-line no-console
    console.log(`[modes] ${set.parameters.length} modes over ${p213.sites.length} sites · A_total=${set.totalAmplitude.toFixed(4)} Å · A1=${set.modes[0]!.observedAmplitude.toFixed(4)} Å · unpaired: ${set.unpaired.join(",") || "none"}`);
    expect(set.unpaired).toEqual([]);
    expect(set.parameters).toHaveLength(13);
    expect(set.totalAmplitude).toBeGreaterThan(0.05);

    const pattern = trunc2(tools.parse_pdf_data({ text: readData(GANB_GR), filename: "g.gr" }).pattern, 12);
    const spec = buildPdfSpec(set.parentized, pattern);
    const swapped = withDistortionModes({ params: spec.params, bindings: spec.bindings }, set);
    const params = swapped.params.map((p) => {
      if (p.id === "qdamp") return { ...p, value: 0.0383 };
      if (p.id === "qbroad") return { ...p, value: 0.0472 };
      if (p.kind === "bIso" || p.id === "delta2") return { ...p, fixed: false };
      if (p.kind === "cellAngle") return { ...p, fixed: true };
      return p; // withDistortionModes leaves only mode_1 free among the modes
    });
    const refined = await tools.refine_pdf({
      structure: set.parentized, pattern, parameters: params, bindings: swapped.bindings,
      restraints: spec.restraints, staged: true, fitRange: { min: 2.0, max: 10.0 }, maxIterations: 40,
    });
    const rw = refined.result.agreement.rWeighted ?? 1;
    const amp = refined.result.parameters["mode_1"] ?? 0;
    // eslint-disable-next-line no-console
    console.log(`[mode fit] ${refined.result.status} · Rw(2–10 Å)=${(rw * 100).toFixed(2)}% · A1=${amp.toFixed(4)} Å (obs ${set.modes[0]!.observedAmplitude.toFixed(4)}) · free=${params.filter((p) => !p.fixed && !p.expression).length}`);
    expect(["converged", "stalled"]).toContain(refined.result.status);
    // One amplitude must beat the CUBIC average (9.19 %) — the frozen mode IS
    // the local distortion — and land near the full 13-coordinate fit (7.98 %).
    expect(rw).toBeLessThan(0.0919);
    // The fitted amplitude agrees with the decomposition of the user's refined
    // P2_13 state to ~20 % (δ2/ADP trade-offs move it slightly).
    expect(Math.abs(amp - set.modes[0]!.observedAmplitude) / set.modes[0]!.observedAmplitude).toBeLessThan(0.2);
  }, 600000);
});
