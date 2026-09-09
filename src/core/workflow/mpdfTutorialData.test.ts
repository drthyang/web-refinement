/**
 * End-to-end mPDF validation against the Frandsen group's published tutorial
 * cases (github.com/FrandsenGroup/mPDF-tutorial, GPL-3.0) — data-gated, so a
 * checkout without the local `data/mPDF_tutorial/` folder skips cleanly.
 *
 * Where `magnetic/mnoGolden.test.ts` gates the KERNEL against a committed
 * diffpy.mpdf reference, these gate the whole WORKFLOW against real measured
 * data and the tutorial's own refined answers:
 *
 *   1. MnO   (tutorial 02) — the experimental mPDF is the residual of a
 *      converged PDFgui structural fit; refine the two mPDF scales against it.
 *   2. MnTe  (tutorial 09) — a genuine nuclear + magnetic co-refinement of real
 *      NOMAD data through the same `refine_mpdf` an agent would call.
 *   3. MnSb  (tutorial 07) — the ferromagnetic net-moment line and the
 *      short-range-order envelope, the two pieces an AFM case cannot exercise.
 *
 * To populate the folder: clone the tutorial and copy `files/1.31_MnO.mcif`,
 * `MnOfit_PDFgui_NOMAD.fgr`, `MnTe_hex.cif`, `NOM_MnTe_320K.gr`, `MnSb.cif`
 * into `data/mPDF_tutorial/`. Nothing from it is committed here.
 */

import { describe, it, expect } from "vitest";
import { dataExists, readData } from "@/testSupport/data";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { parseMagneticCif, parseCif } from "@/parsers/cif";
import { expandSpinField } from "@/core/crystal/cellExpansion";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import {
  computeNormalizedMpdf, computeUnnormalizedMpdf, formFactorEnvelope, j0Profile,
  averageMomentSq, netMomentPerSpin, type MpdfSpin,
} from "@/core/magnetic/mpdf";
import * as tools from "@/mcp/tools";

const MNO_MCIF = "mPDF_tutorial/1.31_MnO.mcif";
const MNO_FGR = "mPDF_tutorial/MnOfit_PDFgui_NOMAD.fgr";
const MNTE_CIF = "mPDF_tutorial/MnTe_hex.cif";
const MNTE_GR = "mPDF_tutorial/NOM_MnTe_320K.gr";
const MNSB_CIF = "mPDF_tutorial/MnSb.cif";

/**
 * A PDFgui `.fgr` fit file. Columns are `r Gcalc d_r d_Gr Gdiff`, and the
 * observed PDF is Gcalc + Gdiff (diffpy.mpdf's own `read_fgr` convention).
 * `Gdiff` — what the structural model could NOT explain — is the experimental
 * magnetic PDF: the whole premise of the mPDF method.
 */
function readFgr(text: string): { r: number[]; gobs: number[]; gcalc: number[]; gdiff: number[] } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("start data"));
  const r: number[] = [], gcalc: number[] = [], gdiff: number[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const c = t.split(/\s+/).map(Number);
    if (c.length < 5 || c.some((v) => Number.isNaN(v))) continue;
    r.push(c[0]!); gcalc.push(c[1]!); gdiff.push(c[4]!);
  }
  return { r, gcalc, gdiff, gobs: gcalc.map((v, i) => v + gdiff[i]!) };
}

/** The magnetic box's spins as our kernel consumes them (Cartesian µ_B). */
function spinsOf(structure: StructureModel, magnetic: MagneticModel): MpdfSpin[] {
  const box = expandSpinField(structure, magnetic);
  return box.atoms.filter((a) => a.moment).map((a) => ({
    position: a.site.position,
    moment: crystalComponentsToCartesian(box.cell, a.moment!),
  }));
}

// ─── 1. MnO: fit the experimental mPDF (tutorial 02) ────────────────────────

describe.skipIf(!dataExists(MNO_FGR))("TUTORIAL MnO — experimental mPDF from the PDFgui residual", () => {
  it("recovers the tutorial's refined ordered scale and explains the residual", () => {
    const fit = readFgr(readData(MNO_FGR));
    const { structure, magnetic } = parseMagneticCif(readData(MNO_MCIF), "mno");
    const spins = spinsOf(structure, magnetic!);
    // 32 Mn per magnetic cell — only true once the mCIF centering operations
    // are composed (see mnoGolden.test.ts); with 4 the fit below is garbage.
    expect(spins).toHaveLength(32);

    const step = 0.01;
    const n = Math.round((fit.r[fit.r.length - 1]! + 5) / step);
    const grid = new Float64Array(n);
    for (let k = 0; k < n; k++) grid[k] = k * step;
    const env = formFactorEnvelope(j0Profile(["Mn2"]), 5, step);
    const mSq = averageMomentSq(spins);
    // d(r) is exactly affine in BOTH scales, so the two basis curves below turn
    // the refinement into one 2×2 linear solve — no optimizer needed.
    const f = computeNormalizedMpdf(structure.cell, spins, grid, { psigma: 0.12 });
    const dOrd = computeUnnormalizedMpdf(grid, f, env, 0, mSq);
    const dPara = computeUnnormalizedMpdf(grid, new Float64Array(n), env, 1, mSq);

    const i0 = Math.round(fit.r[0]! / step);
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let j = 0; j < fit.r.length; j++) {
      const i = i0 + j;
      if (i >= n) break;
      const x1 = dOrd[i]!, x2 = dPara[i]!, y = fit.gdiff[j]!;
      a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1 * y; b2 += x2 * y;
    }
    const det = a11 * a22 - a12 * a12;
    const ordScale = (b1 * a22 - b2 * a12) / det;
    const paraScale = (a11 * b2 - a12 * b1) / det;

    let ssRes = 0, ssTot = 0;
    for (let j = 0; j < fit.r.length; j++) {
      const i = i0 + j;
      if (i >= n) break;
      const m = ordScale * dOrd[i]! + paraScale * dPara[i]!;
      ssRes += (fit.gdiff[j]! - m) ** 2;
      ssTot += fit.gdiff[j]! ** 2;
    }
    const rw = Math.sqrt(ssRes / ssTot);
    // eslint-disable-next-line no-console
    console.log(`[MnO mPDF] ordScale=${ordScale.toFixed(4)} paraScale=${paraScale.toFixed(4)} · Rw=${(100 * rw).toFixed(2)}% · explained=${(100 * (1 - rw * rw)).toFixed(1)}%`);

    // The tutorial's own least_squares fit of the same residual gives
    // ordScale = 1.6685 (diffpy.mpdf, run locally). ordScale is the physically
    // meaningful one — it sets the ordered moment. paraScale is NOT compared:
    // it multiplies a differently-normalized self-scattering basis there.
    expect(ordScale).toBeGreaterThan(0);
    expect(ordScale).toBeCloseTo(1.6685, 1);
    // A real measured residual, so this is a fit-quality gate, not an identity:
    // diffpy reaches Rw 23.6% / 94.4% explained on the same data.
    expect(rw).toBeLessThan(0.30);
    expect(1 - rw * rw).toBeGreaterThan(0.90);
  });
});

// ─── 2. MnTe: nuclear + magnetic co-refinement (tutorial 09) ────────────────

describe.skipIf(!dataExists(MNTE_GR))("TUTORIAL MnTe — nuclear + magnetic co-refinement of real NOMAD data", () => {
  it("co-refines the structure and the spin model through refine_mpdf", async () => {
    const raw = parseCif(readData(MNTE_CIF), "mnte");
    // This CIF carries NO displacement parameters at all, so every site parses
    // with bIso = 0 — delta-sharp peaks whose calculated G(r) is ~50× the data,
    // which drives the scale to ~5e-4 and leaves the fit at Rw ≈ 97 %. Seed a
    // physically sensible U = 0.006 Å² (the tutorial starts its ADPs at 0.003)
    // and the same fit converges at Rw ≈ 10 %. Refining from a zero ADP is not
    // a modelling choice, it is a broken start.
    const bIso = 8 * Math.PI * Math.PI * 0.006;
    const structure: StructureModel = { ...raw, sites: raw.sites.map((s) => ({ ...s, adp: { kind: "isotropic", bIso } })) };
    const parsed = tools.parse_pdf_data({ text: readData(MNTE_GR), filename: "NOM_MnTe_320K.gr" });
    expect(parsed.pattern.scatteringType).toBe("neutron");
    // NiAs-type P6_3/mmc: Mn at 2a, Te at 2c.
    expect(structure.sites.some((s) => s.element === "Mn")).toBe(true);

    // The tutorial hands diffpy an unconstrained `basisvecs` — any direction it
    // likes. MATERIA will not do that: at the 2a site of P6₃/mmc the full grey
    // group forbids EVERY moment (the in-plane 2-folds reverse an axial vector
    // along c, the 3-fold kills the in-plane components), so a moment only
    // becomes allowed under a magnetic SUBGROUP. That is the real workflow —
    // enumerate the subgroups, take one that permits a moment.
    const candidates = tools.list_magnetic_subgroups({ structure, k: [0, 0, 0], maxIndex: 4 });
    const allowed = candidates.candidates
      .map((c) => ({ c, build: tools.build_magnetic_model({ structure, ionLabels: ["Mn"], k: [0, 0, 0], operations: c.operations, moment: 1.5 }) }))
      .find(({ build }) => build.magnetic.moments.length > 0);
    expect(allowed, "no magnetic subgroup of P6₃/mmc allows a moment on Mn").toBeDefined();
    const mag = allowed!.build;
    // eslint-disable-next-line no-console
    console.log(`[MnTe] subgroup ${allowed!.c.label ?? allowed!.c.bns ?? "?"} (index ${allowed!.c.index}) allows m = ${JSON.stringify(mag.magnetic.moments[0]!.components)}`);
    const pattern: PdfPattern = {
      ...parsed.pattern,
      points: parsed.pattern.points.filter((p) => p.r <= 20),
      qdamp: 0.025, qbroad: 0.024,   // the instrument constants in the file header
    };
    const model = tools.build_mpdf_model({
      structure, pattern, magnetic: mag.magnetic,
      parameters: mag.parameters, bindings: mag.bindings,
    });
    expect(model.warnings).toEqual([]);

    // Free what the tutorial frees: cell, ADPs, the nuclear scale, δ1, the
    // moments, and the SRO correlation length. mpdfOrdScale stays fixed — it is
    // exactly degenerate with the moment magnitude.
    const params = model.parameters.map((p) => {
      if (p.kind === "cellLength" || p.kind === "bIso" || p.kind === "pdfScale") return { ...p, fixed: false };
      if (p.id === "delta1" || p.id === "corrLength") return { ...p, fixed: false };
      if (p.kind === "momentMode") return { ...p, fixed: false };
      return { ...p, fixed: true };
    });
    const refined = await tools.refine_mpdf({
      structure, magnetic: model.magnetic, pattern,
      parameters: params, bindings: model.bindings, restraints: model.restraints,
      fitRange: { min: 1.5, max: 20 }, maxIterations: 40,
    });

    const rw = refined.result.agreement.rWeighted ?? 1;
    const moment = Math.hypot(...refined.magnetic.moments[0]!.components);
    const cellA = Object.entries(refined.result.parameters).find(([id]) => id.startsWith("cell_"))?.[1] ?? 0;
    const magFrac = Math.max(...refined.components.gMagnetic.map(Math.abs)) /
      Math.max(...refined.components.gNuclear.map(Math.abs));
    // eslint-disable-next-line no-console
    console.log(`[MnTe co-refine] ${refined.result.status} · Rw=${(100 * rw).toFixed(2)}% · a=${(cellA as number).toFixed(4)} (ref 4.193) · |m|=${moment.toFixed(2)} µ_B · magnetic/nuclear=${(100 * magFrac).toFixed(1)}%`);

    expect(refined.warnings).toEqual([]);
    // Real data with a real model: loose physical gates, not an identity.
    expect(rw).toBeLessThan(0.20);
    expect(cellA as number).toBeGreaterThan(4.0);
    expect(cellA as number).toBeLessThan(4.4);
    // 320 K is just above T_N ≈ 307 K, so the long-range order is gone but
    // short-range correlations survive — the case mPDF exists to measure. The
    // magnetic term must be a real, fitted fraction of the signal.
    expect(magFrac).toBeGreaterThan(0.01);
    expect(moment).toBeGreaterThan(0.5);
    expect(moment).toBeLessThan(8);
    // The separated curves must still sum to the total.
    const c = refined.components;
    for (let i = 0; i < c.r.length; i += 97) {
      expect(c.gNuclear[i]! + c.gMagnetic[i]!).toBeCloseTo(c.gCalc[i]!, 10);
    }
  }, 300000);
});

// ─── 3. MnSb: the ferromagnetic net-moment line + SRO envelope (tutorial 07) ─

describe.skipIf(!dataExists(MNSB_CIF))("TUTORIAL MnSb — ferromagnet: net-moment line and correlation length", () => {
  const structure = (): StructureModel => parseCif(readData(MNSB_CIF), "mnsb");
  /** FM along c on both Mn of the NiAs cell — the tutorial's basisvecs=[0,0,1], k=0. */
  const ferro = (): MagneticModel => ({
    id: "mnsb-mag", structureId: "mnsb", propagation: [[0, 0, 0]],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [0, 0, 3.5], formFactorId: "Mn3" }],
  });

  it("the net-moment line makes a ferromagnet's mPDF oscillate about zero", () => {
    const s = structure();
    const fmSpins = spinsOf(s, ferro());
    expect(fmSpins.length).toBeGreaterThan(0);
    const netMag = netMomentPerSpin(fmSpins);
    expect(netMag).toBeGreaterThan(0.5);

    const step = 0.02, n = 1400;
    const grid = new Float64Array(n);
    for (let k = 0; k < n; k++) grid[k] = k * step;
    const f = computeNormalizedMpdf(s.cell, fmSpins, grid, { psigma: 0.1 });

    const window = (y: Float64Array, lo: number, hi: number): { mean: number; rms: number; rBar: number } => {
      let sum = 0, sq = 0, sr = 0, m = 0;
      for (let k = 0; k < n; k++) {
        const r = grid[k]!;
        if (r < lo || r > hi) continue;
        sum += y[k]!; sq += y[k]! * y[k]!; sr += r; m++;
      }
      return { mean: sum / m, rms: Math.sqrt(sq / m), rBar: sr / m };
    };
    const w = window(f, 10, 25);

    // This is the whole point of notebook 07. For a FERROMAGNET the B_ij
    // baseline grows without bound, and −4πrρ₀m̄² is exactly what cancels it so
    // the mPDF oscillates about zero as it physically must. Omit the line (the
    // tutorial's "incorrect calculation") and f(r) runs away.
    expect(Math.abs(w.mean)).toBeLessThan(0.1 * w.rms);

    // …and the gate is not vacuous: the line it is cancelling is HUGE compared
    // with the residual mean, so this could not pass with the line omitted.
    const volume = s.cell.a * s.cell.b * s.cell.c * Math.sin((s.cell.gamma * Math.PI) / 180);
    const lineAtRbar = 4 * Math.PI * w.rBar * (fmSpins.length / volume) * netMag * netMag;
    // eslint-disable-next-line no-console
    console.log(`[MnSb FM] mean=${w.mean.toFixed(3)} rms=${w.rms.toFixed(2)} · analytic line at r̄=${w.rBar.toFixed(1)} Å is ${lineAtRbar.toFixed(1)}`);
    expect(lineAtRbar).toBeGreaterThan(20 * Math.abs(w.mean));

    // The same box with alternating moments is compensated, so the line is
    // identically absent — including it for an AFM is its own bug class.
    const afmSpins = fmSpins.map((sp, i) => (i % 2 === 0 ? sp : { ...sp, moment: sp.moment.map((v) => -v) as [number, number, number] }));
    expect(netMomentPerSpin(afmSpins)).toBeLessThan(1e-12);
    const fAfm = computeNormalizedMpdf(s.cell, afmSpins, grid, { psigma: 0.1 });
    const wAfm = window(fAfm, 10, 25);
    expect(Math.abs(wAfm.mean)).toBeLessThan(0.1 * wAfm.rms);
  });

  it("a finite correlation length damps the mPDF toward zero at high r", () => {
    const s = structure();
    const spins = spinsOf(s, ferro());
    const step = 0.02, n = 1200;
    const grid = new Float64Array(n);
    for (let k = 0; k < n; k++) grid[k] = k * step;
    const XI = 8;
    const undamped = computeNormalizedMpdf(s.cell, spins, grid, { psigma: 0.1 });
    const damped = computeNormalizedMpdf(s.cell, spins, grid, { psigma: 0.1, corrLength: XI });

    // exp(−r/ξ) applies to the pair terms AND the net-moment line, so far out
    // the damped curve must be a small fraction of the undamped one.
    const at = (r: number): number => Math.round(r / step);
    const ratio = Math.abs(damped[at(20)]!) / Math.abs(undamped[at(20)]!);
    expect(ratio).toBeLessThan(Math.exp(-20 / XI) * 3);
    // …and near r = 0 the envelope is ≈ 1, so the two agree there.
    expect(damped[at(3)]!).toBeCloseTo(undamped[at(3)]! * Math.exp(-3 / XI), 6);
  });
});
