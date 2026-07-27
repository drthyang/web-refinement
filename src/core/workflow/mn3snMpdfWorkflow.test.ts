/**
 * Tier-2 REAL-data mPDF WORKFLOW tests: Mn₃Sn (POWGEN) through the PRODUCT
 * pipeline — buildMpdfSpec → buildMpdfProblem → the LM engine — one level up
 * from the kernel-level closed-form checks in mn3snMpdfGolden.test.ts. Data-
 * gated: skips without the git-ignored data/ folder; every refined number
 * stays in data/PDF/Mn3Sn_PG3/golden.json (UNPUBLISHED — none of its values
 * may appear in this file).
 *
 *  1. RESIDUAL-MODE PARITY — the reference fit (diffpy.mpdf against the
 *     PDFgui nuclear residual) reproduced by OUR engine: the pattern is the
 *     .fgr Gdiff column, the nuclear term is zeroed via pdfScale = 0, and only
 *     the two affine mPDF scales plus the SRO correlation length ξ are free.
 *     Gate: the reference script's own convergence figure, rw = ‖residual‖ /
 *     ‖G_obs(total)‖ over the fit window (the sweep normalizes by the TOTAL
 *     observed G(r), not the magnetic residual — see the Golden comments in
 *     mn3snMpdfGolden.test.ts), must land within a small delta of the
 *     manifest value, and ξ must come back near the externally refined length.
 *  2. CO-REFINEMENT SMOKE — the actual product mode: ONE residual carrying
 *     nuclear + magnetic against the TOTAL observed G(r) (gObs = Gcalc +
 *     Gdiff), gated on the magnetic term genuinely improving Rw over a
 *     zero-moment baseline. Deliberately loose: the workflow shares a single
 *     Qdamp between the nuclear and magnetic terms, while the reference used
 *     ~0.1 Å⁻¹ magnetic damping alongside the header Qdamp nuclear — a known
 *     modeling gap (free ξ absorbs part of it).
 */

import { describe, it, expect } from "vitest";
import type { MagneticModel, MagneticMoment } from "@/core/magnetic/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { dataExists, readData } from "@/testSupport/data";
import { readMcifMomentLoop } from "@/testSupport/mn3snMcif";
import { parseFgr, fgrToPattern, type FgrFit } from "@/parsers/fgrData";
import { parseCif, parseMagneticCif } from "@/parsers/cif";
import { refine } from "@/core/refinement/engine";
import { buildMpdfProblem, buildMpdfSpec, mpdfComponents } from "@/core/workflow/mpdf";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { compositionWeights } from "@/core/totalscattering/weights";
import { BARN_TO_FM2 } from "@/core/magnetic/mpdf";

const DIR = "PDF/Mn3Sn_PG3";
const MANIFEST = `${DIR}/golden.json`;

/** The manifest fields these tests consume (see mn3snMpdfGolden.test.ts for
 *  the full Golden shape and the rw-normalization / unit-convention notes). */
interface Golden {
  readonly fgr: string;
  readonly cif: string;
  readonly mcif: string;
  /** PDFgui PHASE scale (dscale in the .fgr is a placeholder 1). */
  readonly nucScale?: number;
  readonly formFactorIon: string;
  readonly fitMin: number;
  readonly fitMax: number;
  /** Externally refined SRO correlation length ξ (Å). */
  readonly xi: number;
  /** The reference mPDF fit's Q-damping — NOT the .fgr nuclear header value. */
  readonly qdampMag: number;
  readonly psigma: number;
  /** Our g = 1, |m| = 1 μB scales ÷ these = the reference script's units. */
  readonly ordWeightConvention: number;
  readonly paraWeightConvention: number;
  readonly reference: {
    readonly rwFinalVsObs: number;
    readonly ordscale: number;
    readonly parascale: number;
  };
  readonly gates: {
    readonly maxScaleRelErr: number;
  };
}

const loadGolden = (): Golden => JSON.parse(readData(MANIFEST)) as Golden;
const loadFgr = (g: Golden): FgrFit => parseFgr(readData(`${DIR}/${g.fgr}`));

/**
 * MagneticModel from the explicit-P1 mCIF moment loop: 12 Mn crystal-axis
 * unit-ish vectors, k = 0 (the P1 cell IS the magnetic cell), ⟨j0⟩ ion from
 * the manifest. The moment MAGNITUDE convention rides on mpdfOrdScale — the
 * reference script fits unit spins and carries μ in its ordscale too.
 */
function magneticFrom(mcifText: string, structureId: string, formFactorId: string): MagneticModel {
  const loop = readMcifMomentLoop(mcifText);
  const moments: MagneticMoment[] = [...loop.entries()].map(([siteLabel, components]) => ({
    siteLabel,
    frame: "crystallographic",
    components,
    formFactorId,
  }));
  return { id: `${structureId}-mag`, structureId, propagation: [[0, 0, 0]], moments };
}

/** Everything fixed at its spec value except the explicitly overridden rows. */
type Override = Partial<Pick<RefinementParameter, "value" | "initialValue" | "min" | "max" | "fixed">>;
function withAllFixedExcept(
  params: readonly RefinementParameter[],
  overrides: Readonly<Record<string, Override>>,
): RefinementParameter[] {
  return params.map((p) => ({ ...p, fixed: true, ...(overrides[p.id] ?? {}) }));
}

/** Indices of the data grid inside the fit window (inclusive, as windowFor). */
function windowIndices(r: readonly number[], min: number, max: number): number[] {
  return r.map((_, i) => i).filter((i) => r[i]! >= min && r[i]! <= max);
}

/** √(Σ(calc−target)² / Σnorm²) over the window — the script's unweighted
 *  convention; `norm` = the TOTAL observed curve for the rwVsObs figure. */
function rwOver(
  idx: readonly number[],
  calc: ArrayLike<number>,
  target: readonly number[],
  norm: readonly number[],
): number {
  let num = 0;
  let den = 0;
  for (const i of idx) {
    num += (calc[i]! - target[i]!) ** 2;
    den += norm[i]! ** 2;
  }
  return Math.sqrt(num / den);
}

describe.skipIf(!dataExists(MANIFEST))("REAL Mn3Sn mPDF workflow (POWGEN, local-only data)", () => {
  it("1: residual-mode refinement through the LM engine matches the reference fit", () => {
    const g = loadGolden();
    const fgr = loadFgr(g);
    // gObs = the Gdiff column: the nuclear-fit residual, i.e. the magnetic PDF.
    const pattern = fgrToPattern(fgr, { id: "mn3sn-gdiff", signal: "difference" });
    const { structure } = parseMagneticCif(readData(`${DIR}/${g.mcif}`), "mn3sn-p1");
    expect(structure.sites.length).toBe(16); // 12 Mn + 4 Sn, Ama2 expanded to P1
    const magnetic = magneticFrom(readData(`${DIR}/${g.mcif}`), structure.id, g.formFactorIon);
    expect(magnetic.moments.length).toBe(12);

    const spec = buildMpdfSpec(structure, pattern, { magnetic, params: [], bindings: [] });
    const params = withAllFixedExcept(spec.params, {
      // The three DOF of the reference fit's linear+SRO stage. ξ min 0.5 is
      // load-bearing: corrLength 0 means INFINITE in the profile convention
      // (exp(−r/ξ) disabled), so LM must not slide across it.
      mpdfOrdScale: { value: 10, initialValue: 10, min: 0, fixed: false },
      mpdfParaScale: { value: 10, initialValue: 10, min: 0, fixed: false },
      corrLength: { value: 5, initialValue: 5, min: 0.5, max: 100, fixed: false },
      // Residual-only: the nuclear term is exactly zeroed by its scale.
      pdfScale: { value: 0, initialValue: 0, fixed: true },
      // The magnetic term reads the shared qdamp — pin it to the reference
      // mPDF damping, NOT the .fgr nuclear header value.
      qdamp: { value: g.qdampMag, initialValue: g.qdampMag, fixed: true },
      qbroad: { value: 0, initialValue: 0, fixed: true },
      mpdfPsigma: { value: g.psigma, initialValue: g.psigma, fixed: true },
    });

    const fitRange = { min: g.fitMin, max: g.fitMax };
    const problem = buildMpdfProblem(structure, magnetic, pattern, params, spec.bindings, [], fitRange);
    const result = refine(problem, { maxIterations: 200, convergenceTolerance: 1e-9 });

    const ord = result.parameters["mpdfOrdScale"]!;
    const para = result.parameters["mpdfParaScale"]!;
    const xi = result.parameters["corrLength"]!;
    const yCalc = problem.calculate(result.parameters);

    const idx = windowIndices(fgr.r, g.fitMin, g.fitMax);
    // The reference script's convergence figure: the magnetic-fit residual
    // normalized by the TOTAL observed G(r) (not the residual curve).
    const rwVsObs = rwOver(idx, yCalc, fgr.gDiff, fgr.gObs);

    // Our mpdf scales sit BEHIND the workflow's composition conversion
    // (N_spins/N_atoms)·(barn→fm²)/⟨b⟩² (see workflow/mpdf.ts); undo it, then
    // the manifest's weight conventions, to land in the reference script's
    // ordscale/parascale units. GATED below: free scales absorb any error in
    // that conversion chain, and rwVsObs/ξ are conversion-invariant — so this
    // is the only gate in the suite that would catch a regression in the
    // workflow's unit wiring (compositionWeights / BARN_TO_FM2 / spin-per-atom).
    const w = compositionWeights(expandStructureAtoms(structure), "neutron");
    const conv = (magnetic.moments.length / structure.sites.length) * (BARN_TO_FM2 / (w.bAvg * w.bAvg));
    const ordRef = (ord * conv) / g.ordWeightConvention;
    const paraRef = (para * conv) / g.paraWeightConvention;
    // eslint-disable-next-line no-console
    console.log(
      `[Mn3Sn mPDF workflow 1] status=${result.status} iters=${result.history.length} ` +
      `ord=${ord.toFixed(4)} (ref-units ${((ord * conv) / g.ordWeightConvention).toFixed(3)} vs ${g.reference.ordscale.toFixed(3)}) ` +
      `para=${para.toFixed(4)} (ref-units ${((para * conv) / g.paraWeightConvention).toFixed(3)} vs ${g.reference.parascale.toFixed(3)}) ` +
      `xi=${xi.toFixed(3)} (ref ${g.xi.toFixed(3)}) ` +
      `rwVsObs=${(rwVsObs * 100).toFixed(2)}% (ref ${(g.reference.rwFinalVsObs * 100).toFixed(2)}%)`,
    );

    expect(result.status).toBe("converged");
    expect(ord).toBeGreaterThan(0);
    expect(para).toBeGreaterThan(0);
    expect(xi).toBeGreaterThan(0.6 * g.xi);
    expect(xi).toBeLessThan(1.6 * g.xi);
    expect(Math.abs(rwVsObs - g.reference.rwFinalVsObs)).toBeLessThan(0.02);
    // Unit-wiring parity (observed −2.7% / −2.2% vs reference): the LM scales,
    // pushed through the workflow conversion + weight conventions, must land
    // on the reference fit's refined values.
    expect(Math.abs(ordRef / g.reference.ordscale - 1)).toBeLessThan(g.gates.maxScaleRelErr);
    expect(Math.abs(paraRef / g.reference.parascale - 1)).toBeLessThan(g.gates.maxScaleRelErr);

    // Component split at the refined values: pdfScale = 0 must zero the
    // nuclear curve exactly, and the magnetic component must carry the whole
    // calculated signal — cross-checked against the refine-path calculate.
    const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
    const comps = mpdfComponents(structure, magnetic, pattern, refined, spec.bindings, fitRange);
    let maxNuc = 0;
    let maxSplitErr = 0;
    for (const i of idx) {
      maxNuc = Math.max(maxNuc, Math.abs(comps.yNuclear[i]!));
      maxSplitErr = Math.max(maxSplitErr, Math.abs(comps.yMagnetic[i]! - (yCalc[i]! - comps.yNuclear[i]!)));
    }
    expect(maxNuc).toBeLessThan(1e-10);
    expect(maxSplitErr).toBeLessThan(1e-9);
  }, 300_000);

  it("2: co-refinement smoke — the magnetic term improves the one-residual total fit", () => {
    const g = loadGolden();
    const fgr = loadFgr(g);
    // The product mode fits the TOTAL observed curve: gObs = Gcalc + Gdiff.
    const pattern = fgrToPattern(fgr, { id: "mn3sn-gobs", signal: "observed" });
    // Nuclear structure from the CIF, not the mCIF: identical P1 cell,
    // positions, and Mn labels, but the mCIF writes no ADP loop (its sites
    // parse with bIso = 0) while the CIF carries the PDFgui-refined Uiso the
    // nuclear peak widths need. The moment loop keys on the shared Mn labels.
    const structure = parseCif(readData(`${DIR}/${g.cif}`), "mn3sn-nuc");
    expect(structure.sites.length).toBe(16);
    const magnetic = magneticFrom(readData(`${DIR}/${g.mcif}`), structure.id, g.formFactorIon);

    const spec = buildMpdfSpec(structure, pattern, { magnetic, params: [], bindings: [] });
    const nucScale = g.nucScale ?? fgr.dscale ?? 1;
    // NOTE (known modeling gap): the workflow shares ONE qdamp between the
    // nuclear and magnetic terms. Pinning it to the .fgr header value keeps
    // the nuclear envelope faithful, but under-damps the magnetic term
    // relative to the reference (~0.1 Å⁻¹ magnetic vs header-qdamp nuclear);
    // the free ξ absorbs part of that, and the gates below stay loose.
    const shared: Record<string, Override> = {
      qdamp: { value: fgr.qdamp!, initialValue: fgr.qdamp!, fixed: true },
      qbroad: { value: fgr.qbroad!, initialValue: fgr.qbroad!, fixed: true },
      mpdfPsigma: { value: g.psigma, initialValue: g.psigma, fixed: true },
      pdfScale: { value: nucScale, initialValue: nucScale, min: 0, fixed: false },
    };
    const paramsWith = withAllFixedExcept(spec.params, {
      ...shared,
      mpdfOrdScale: { value: 10, initialValue: 10, min: 0, fixed: false },
      mpdfParaScale: { value: 10, initialValue: 10, min: 0, fixed: false },
      corrLength: { value: 5, initialValue: 5, min: 0.5, max: 100, fixed: false },
    });
    // Zero-moment baseline: same recipe, spinless magnetic model (the mPDF
    // rows stay fixed — with no spins their columns are exactly dead).
    const paramsZero = withAllFixedExcept(spec.params, shared);
    const magneticZero: MagneticModel = {
      ...magnetic,
      moments: magnetic.moments.map((m) => ({ ...m, components: [0, 0, 0] as [number, number, number] })),
    };

    const fitRange = { min: g.fitMin, max: g.fitMax };
    const problemWith = buildMpdfProblem(structure, magnetic, pattern, paramsWith, spec.bindings, [], fitRange);
    const resultWith = refine(problemWith, { maxIterations: 200, convergenceTolerance: 1e-9 });
    const problemZero = buildMpdfProblem(structure, magneticZero, pattern, paramsZero, spec.bindings, [], fitRange);
    const resultZero = refine(problemZero, { maxIterations: 200, convergenceTolerance: 1e-9 });

    const idx = windowIndices(fgr.r, g.fitMin, g.fitMax);
    const calcWith = problemWith.calculate(resultWith.parameters);
    const calcZero = problemZero.calculate(resultZero.parameters);
    const rwWith = rwOver(idx, calcWith, fgr.gObs, fgr.gObs);
    const rwZero = rwOver(idx, calcZero, fgr.gObs, fgr.gObs);

    // eslint-disable-next-line no-console
    console.log(
      `[Mn3Sn mPDF workflow 2] with-moments: status=${resultWith.status} iters=${resultWith.history.length} ` +
      `Rw=${(rwWith * 100).toFixed(2)}% scale=${resultWith.parameters["pdfScale"]!.toFixed(4)} ` +
      `ord=${resultWith.parameters["mpdfOrdScale"]!.toFixed(3)} para=${resultWith.parameters["mpdfParaScale"]!.toFixed(3)} ` +
      `xi=${resultWith.parameters["corrLength"]!.toFixed(3)} | ` +
      `zero-moment baseline: status=${resultZero.status} Rw=${(rwZero * 100).toFixed(2)}% ` +
      `scale=${resultZero.parameters["pdfScale"]!.toFixed(4)}`,
    );

    expect(resultWith.status).toBe("converged");
    expect(resultZero.status).toBe("converged");
    // The magnetic term must genuinely help the one-residual total fit …
    expect(rwWith).toBeLessThan(rwZero - 0.03);
    // … and the combined fit must be respectable in absolute terms.
    expect(rwWith).toBeLessThan(0.3);
  }, 300_000);
});
