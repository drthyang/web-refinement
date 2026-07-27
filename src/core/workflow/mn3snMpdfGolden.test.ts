/**
 * Real-data mPDF golden: Mn₃Sn on POWGEN (data-gated; skips without the local
 * git-ignored data/ folder — the dataset and every refined number stay in
 * `data/PDF/Mn3Sn_PG3/golden.json`, unpublished).
 *
 * The first non-collinear, non-toy exercise of the mPDF kernel: 12 canted
 * triangular kagome moments in an orthorhombic (Ama2 → P1) cell, against real
 * neutron total-scattering data. Two gates:
 *
 *  A. NUCLEAR — our G(r) forward model vs the Gcalc column PDFgui saved in the
 *     .fgr (same structure CIF, same dscale/Qdamp/Qbroad). A real-data sibling
 *     of the committed PDFfit2 goldens at far lower symmetry (16-atom P1).
 *  B. MAGNETIC — the unnormalized mPDF d(r) built from the externally refined
 *     mCIF moment vectors (diffpy.mpdf fit of the SAME residual) vs the
 *     measured Gdiff, with only the two affine scales (ordered, paramagnetic)
 *     free — solved in closed form, no optimizer. If the kernel's A/B split,
 *     ⟨j0⟩ envelope, SRO damping, or net-moment line were wrong, the refined
 *     external model could not reproduce the measured residual.
 */
import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import { dataExists, readData } from "@/testSupport/data";
import { parseFgr, fgrToPattern, type FgrFit } from "@/parsers/fgrData";
import { parseCif, parseMagneticCif } from "@/parsers/cif";
import { buildPdfSpec, buildPdfProblem } from "@/core/workflow/pdf";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import {
  averageMomentSq,
  computeNormalizedMpdf,
  computeUnnormalizedMpdf,
  formFactorEnvelope,
  j0Profile,
  mpdfExtendedGrid,
  type MpdfSpin,
} from "@/core/magnetic/mpdf";

const DIR = "PDF/Mn3Sn_PG3";
const MANIFEST = `${DIR}/golden.json`;

interface Golden {
  readonly fgr: string;
  readonly cif: string;
  readonly mcif: string;
  /** PDFgui PHASE scale (pscale). The .fgr header only records the DATASET
   *  scale (dscale, = 1 in fits that put the scale on the phase), so the phase
   *  scale is carried here — and δ2/sratio are recorded nowhere in an .fgr,
   *  which leaves an irreducible ~20–30% peak-amplitude ambiguity: the tight
   *  nuclear gate is the SHAPE (corr), not κ. */
  readonly nucScale?: number;
  readonly formFactorIon: string;
  readonly fitMin: number;
  readonly fitMax: number;
  readonly xi: number;
  readonly qdampMag: number;
  readonly psigma: number;
  /** Conversion from our g = 1, |m| = 1 μB convention to the reference fit's
   *  (unit spins with g = 2 ⇒ ordered pair weights g² = 4; K₂ = K₁ carries
   *  g²S(S+1) = 3 at S = ½) — divide our fitted scales by these to land in
   *  the reference script's ordscale/parascale units. */
  readonly ordWeightConvention: number;
  readonly paraWeightConvention: number;
  readonly reference: {
    /** The sweep's rw is ‖residual‖/‖G_obs‖ — normalized by the TOTAL observed
     *  G(r), not the magnetic residual (pinned: rwInitVsObs == ‖Gdiff‖/‖Gobs‖). */
    rwFinalVsObs: number;
    rwInitVsObs: number;
    ordscale: number;
    parascale: number;
  };
  readonly gates: {
    minNuclearCorr: number;
    maxNuclearKappaErr: number;
    minMagCorr: number;
    maxMagRw: number;
    maxRwVsObsDelta: number;
    maxScaleRelErr: number;
  };
}

const loadGolden = (): Golden => JSON.parse(readData(MANIFEST)) as Golden;
const loadFgr = (g: Golden): FgrFit => parseFgr(readData(`${DIR}/${g.fgr}`));

/** Pearson correlation + least-squares amplitude ratio κ (golden convention). */
function corrKappa(a: ArrayLike<number>, b: ArrayLike<number>): { corr: number; kappa: number } {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    sa += a[i]!; sb += b[i]!;
    saa += a[i]! * a[i]!; sbb += b[i]! * b[i]!; sab += a[i]! * b[i]!;
  }
  const cov = sab - (sa * sb) / n;
  return { corr: cov / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n)), kappa: sbb > 0 ? sab / sbb : NaN };
}

/** Rw = √(Σ(fit−obs)² / Σobs²) — the script's unweighted convention. */
function rwOf(obs: readonly number[], fit: readonly number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < obs.length; i++) {
    num += (fit[i]! - obs[i]!) ** 2;
    den += obs[i]! ** 2;
  }
  return Math.sqrt(num / den);
}

/**
 * The `_atom_site_moment` loop of an explicit-P1 mCIF (no BNS operations, so
 * parseMagneticCif carries no magnetic model — the moment rows are exactly the
 * label + 3 crystal-axis components with no symmetry to apply).
 */
function readMomentLoop(text: string): Map<string, Vec3> {
  const moments = new Map<string, Vec3>();
  let inLoop = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^_atom_site_moment\.label/i.test(line)) inLoop = true;
    if (!inLoop || line.startsWith("_") || line === "" || line.toLowerCase() === "loop_") continue;
    const toks = line.split(/\s+/);
    if (toks.length < 4) continue;
    const v = toks.slice(1, 4).map(Number);
    if (v.every(Number.isFinite)) moments.set(toks[0]!, v as [number, number, number]);
  }
  return moments;
}

describe.skipIf(!dataExists(MANIFEST))("REAL Mn3Sn mPDF golden (POWGEN, local-only data)", () => {
  it("A: nuclear G(r) forward model reproduces PDFgui's saved Gcalc", () => {
    const g = loadGolden();
    const fgr = loadFgr(g);
    const structure = parseCif(readData(`${DIR}/${g.cif}`), "mn3sn");
    expect(structure.sites.length).toBe(16); // 12 Mn + 4 Sn, Ama2 expanded to P1

    const pattern = fgrToPattern(fgr, { id: "mn3sn-pdf" });
    const spec = buildPdfSpec(structure, pattern);
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    // Pin the profile to the fit's own refined constants; everything else
    // (cell, positions, Uiso) already carries the fit's values via the CIF.
    // Scale: the phase scale from the manifest when the .fgr's dataset scale
    // is a placeholder 1 (PDFgui splits the scale across pscale × dscale).
    values["pdfScale"] = g.nucScale ?? fgr.dscale!;
    values["qdamp"] = fgr.qdamp!;
    values["qbroad"] = fgr.qbroad!;

    const fitRange = { min: fgr.fitrmin!, max: fgr.fitrmax! };
    const problem = buildPdfProblem(structure, pattern, spec.params, spec.bindings, [], fitRange);
    const calc = problem.calculate(values);

    const idx = fgr.r.map((_, i) => i).filter((i) => fgr.r[i]! >= fitRange.min && fgr.r[i]! <= fitRange.max);
    const ours = idx.map((i) => calc[i]!);
    const theirs = idx.map((i) => fgr.gCalc[i]!);
    const { corr, kappa } = corrKappa(theirs, ours);
    // eslint-disable-next-line no-console
    console.log(`[Mn3Sn nuclear] corr=${corr.toFixed(5)} κ=${kappa.toFixed(4)} over ${idx.length} pts (${fitRange.min}–${fitRange.max} Å)`);
    expect(corr).toBeGreaterThan(g.gates.minNuclearCorr);
    expect(Math.abs(kappa - 1)).toBeLessThan(g.gates.maxNuclearKappaErr);
  });

  it("B: mPDF from the externally refined mCIF moments matches the measured Gdiff", () => {
    const g = loadGolden();
    const fgr = loadFgr(g);
    const { structure } = parseMagneticCif(readData(`${DIR}/${g.mcif}`), "mn3sn-mag");
    const moments = readMomentLoop(readData(`${DIR}/${g.mcif}`));
    expect(moments.size).toBe(12);

    const spins: MpdfSpin[] = structure.sites
      .filter((s) => moments.has(s.label))
      .map((s) => ({ position: s.position, moment: crystalComponentsToCartesian(structure.cell, moments.get(s.label)!) }));
    expect(spins.length).toBe(12);

    // The reference fit's model: diffpy defaults (psigma), its Q_DAMP (not the
    // nuclear header Qdamp), the refined SRO length ξ.
    const step = 0.01;
    const grid = mpdfExtendedGrid(g.fitMax, step);
    const f = computeNormalizedMpdf(structure.cell, spins, grid, {
      psigma: g.psigma, qdamp: g.qdampMag, corrLength: g.xi,
    });
    const envelope = formFactorEnvelope(j0Profile([g.formFactorIon]), 5, step);
    const mSq = averageMomentSq(spins);
    const dOrd = computeUnnormalizedMpdf(grid, f, envelope, 0, mSq);
    const dPara = computeUnnormalizedMpdf(grid, new Float64Array(grid.length), envelope, 1, mSq);

    // Fit window on the data grid; model sampled at the same r.
    const idx = fgr.r.map((_, i) => i).filter((i) => fgr.r[i]! >= g.fitMin && fgr.r[i]! <= g.fitMax);
    const y = idx.map((i) => fgr.gDiff[i]!);
    const ord = idx.map((i) => dOrd[Math.round(fgr.r[i]! / step)]!);
    const para = idx.map((i) => dPara[Math.round(fgr.r[i]! / step)]!);

    // Closed-form 2×2 normal equations for the two affine scales — the linear
    // subproblem of the reference fit (its nonlinear DOF, the moments/ξ, are
    // pinned to the refined values).
    let oo = 0, pp = 0, op = 0, oy = 0, py = 0;
    for (let k = 0; k < y.length; k++) {
      oo += ord[k]! * ord[k]!; pp += para[k]! * para[k]!; op += ord[k]! * para[k]!;
      oy += ord[k]! * y[k]!; py += para[k]! * y[k]!;
    }
    const det = oo * pp - op * op;
    const alpha = (oy * pp - py * op) / det; // ordered scale
    const beta = (py * oo - oy * op) / det; // paramagnetic scale
    const fit = ord.map((v, k) => alpha * v + beta * para[k]!);

    const { corr } = corrKappa(y, fit);
    const rw = rwOf(y, fit);
    // The reference script's convergence figure: residual normalized by the
    // TOTAL observed G(r) over the same window.
    const yObs = idx.map((i) => fgr.gObs[i]!);
    let ssRes = 0, ssObs = 0;
    for (let k = 0; k < y.length; k++) {
      ssRes += (fit[k]! - y[k]!) ** 2;
      ssObs += yObs[k]! ** 2;
    }
    const rwVsObs = Math.sqrt(ssRes / ssObs);
    // Our scales in the reference fit's units (see Golden interface).
    const ordRef = alpha / g.ordWeightConvention;
    const paraRef = beta / g.paraWeightConvention;
    // eslint-disable-next-line no-console
    console.log(
      `[Mn3Sn mPDF] corr=${corr.toFixed(4)} Rw=${(rw * 100).toFixed(2)}% rwVsObs=${(rwVsObs * 100).toFixed(2)}% ` +
      `(reference ${(g.reference.rwFinalVsObs * 100).toFixed(2)}%) ` +
      `ord=${ordRef.toFixed(3)} (ref ${g.reference.ordscale.toFixed(3)}) para=${paraRef.toFixed(3)} (ref ${g.reference.parascale.toFixed(3)})`,
    );
    // The ordered signal must be present with POSITIVE amplitude — a flipped
    // or scrambled spin arrangement fails here before any Rw gate.
    expect(alpha).toBeGreaterThan(0);
    expect(beta).toBeGreaterThan(0);
    expect(corr).toBeGreaterThan(g.gates.minMagCorr);
    expect(rw).toBeLessThan(g.gates.maxMagRw);
    // Reproduce the reference fit's own convergence figure and refined scales
    // — the external cross-check: diffpy.mpdf's refined ordscale/parascale
    // must fall out of OUR kernel via a closed-form linear solve.
    expect(Math.abs(rwVsObs - g.reference.rwFinalVsObs)).toBeLessThan(g.gates.maxRwVsObsDelta);
    expect(Math.abs(ordRef / g.reference.ordscale - 1)).toBeLessThan(g.gates.maxScaleRelErr);
    expect(Math.abs(paraRef / g.reference.parascale - 1)).toBeLessThan(g.gates.maxScaleRelErr);
  });
});
