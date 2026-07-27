/**
 * Canting-angle posterior smoke (data-gated; every reference number lives in
 * the git-ignored `data/PDF/Mn3Sn_PG3/golden.json`).
 *
 * The Mn₃Sn kagome canting angles enter through the two-mode-per-layer
 * parameterization (testSupport/mn3snCantingModes): amplitudes LINEAR in the
 * momentMode machinery, angles as atan2 pushforwards — so the ensemble
 * sampler explores (cnt₁, cnt₂, μ_A, μ_B, paraScale, ξ) with no new kernel
 * code. The likelihood is σ-weighted with σ_G(r) propagated from the S(Q)
 * error column (totalscattering/grErrors) under the marginalized-scale noise
 * model: the propagated σ carry the r-DEPENDENCE of the statistics while the
 * marginalized global factor absorbs both the correlated-point underestimate
 * and nuclear-misfit systematics.
 *
 * This is a SHORT chain — a machinery gate, not the production posterior: it
 * pins that the reference canting angles fall inside the sampled 95%
 * intervals and that the posterior means land near them. The long-chain
 * credible regions are an analysis product, not a CI artifact.
 */
import { describe, it, expect } from "vitest";
import { dataExists, readData } from "@/testSupport/data";
import { parseFgr, fgrToPattern } from "@/parsers/fgrData";
import { parseMagneticCif } from "@/parsers/cif";
import { buildMpdfSpec, buildMpdfProblem } from "@/core/workflow/mpdf";
import { samplePosterior } from "@/core/refinement/bayes/sampler";
import { propagateGrSigma, parseSqWithErrors } from "@/core/totalscattering/grErrors";
import { buildCantingModes, amplitudesFor, anglesFrom } from "@/testSupport/mn3snCantingModes";
import type { RefinementParameter } from "@/core/refinement/types";

const DIR = "PDF/Mn3Sn_PG3";
const MANIFEST = `${DIR}/golden.json`;
const SQ = `${DIR}/SQ/PG3_55526_SQ.dat`;

interface Golden {
  readonly fgr: string;
  readonly mcif: string;
  readonly nucScale?: number;
  readonly formFactorIon: string;
  readonly fitMin: number;
  readonly fitMax: number;
  readonly xi: number;
  readonly qdampMag: number;
  readonly psigma: number;
  readonly reference: { cnt1Deg: number; cnt2Deg: number; orderedMomentMuB: number };
}

describe.skipIf(!dataExists(MANIFEST) || !dataExists(SQ))("REAL Mn3Sn canting-angle posterior (POWGEN, local-only data)", () => {
  it("short ensemble chain brackets the reference canting angles", () => {
    const g = JSON.parse(readData(MANIFEST)) as Golden;
    const fgr = parseFgr(readData(`${DIR}/${g.fgr}`));
    const mcifText = readData(`${DIR}/${g.mcif}`);
    // Difference signal, no Qmax termination (the reference protocol applies
    // none to d(r)); ordScale := nucScale makes amplitudes physical μ_B.
    const { qmax: _qmax, ...pattern } = fgrToPattern(fgr, { id: "mn3sn-gdiff", signal: "difference" });
    const { structure } = parseMagneticCif(mcifText, "mn3sn-p1");

    // Seed walkers slightly OFF the reference so the gate is not circular.
    const mu0 = g.reference.orderedMomentMuB;
    const a0 = amplitudesFor(g.reference.cnt1Deg + 3, mu0 * 0.9);
    const b0 = amplitudesFor(g.reference.cnt2Deg - 3, mu0 * 0.9);
    const modes = buildCantingModes(mcifText, structure, g.formFactorIon, {
      tA: a0.t, cA: a0.c, tB: b0.t, cB: b0.c,
    });
    expect(modes.layers.A.length).toBe(6);
    expect(modes.layers.B.length).toBe(6);

    const spec = buildMpdfSpec(structure, pattern, modes);
    type Ov = Partial<Pick<RefinementParameter, "value" | "initialValue" | "min" | "max" | "fixed">>;
    const nucScale = g.nucScale ?? fgr.dscale ?? 1;
    const overrides: Record<string, Ov> = {
      mpdfOrdScale: { value: nucScale, initialValue: nucScale, fixed: true },
      mpdfParaScale: { value: 0.7 / (mu0 * mu0), initialValue: 0.7 / (mu0 * mu0), min: 0, max: 50, fixed: false },
      corrLength: { value: g.xi, initialValue: g.xi, min: 0.5, max: 100, fixed: false },
      pdfScale: { value: 0, initialValue: 0, fixed: true },
      qdamp: { value: g.qdampMag, initialValue: g.qdampMag, fixed: true },
      qbroad: { value: 0, initialValue: 0, fixed: true },
      mpdfPsigma: { value: g.psigma, initialValue: g.psigma, fixed: true },
      muT_A: { fixed: false }, muC_A: { fixed: false }, muT_B: { fixed: false }, muC_B: { fixed: false },
    };
    const params = spec.params.map((p) => ({ ...p, fixed: true, ...(overrides[p.id] ?? {}) }));
    const fitRange = { min: g.fitMin, max: g.fitMax };
    const problem0 = buildMpdfProblem(structure, modes.magnetic, pattern, params, spec.bindings, [], fitRange);

    // σ-shaped weights from the S(Q) error propagation.
    const sq = parseSqWithErrors(readData(SQ));
    const sigma = propagateGrSigma(sq.q, sq.sigma, fgr.r);
    const weights = new Float64Array(problem0.weights.length);
    for (let i = 0; i < fgr.r.length; i++) {
      const inWin = fgr.r[i]! >= g.fitMin && fgr.r[i]! <= g.fitMax;
      weights[i] = inWin && sigma[i]! > 0 ? 1 / (sigma[i]! * sigma[i]!) : 0;
    }
    const problem = { ...problem0, weights };

    const res = samplePosterior(problem, {
      nSteps: 300, nWalkers: 14, burnIn: 150, thin: 2,
      noiseModel: "marginalized", seed: 7, initialSpread: 0.05,
    });
    expect(res.acceptanceFraction).toBeGreaterThan(0.1);
    expect(res.acceptanceFraction).toBeLessThan(0.9);

    const ids = res.freeIds;
    const col = (id: string): number => ids.indexOf(id);
    const cnt1: number[] = [];
    const cnt2: number[] = [];
    for (const walker of res.chains) {
      for (const s of walker) {
        cnt1.push(anglesFrom(s[col("muT_A")]!, s[col("muC_A")]!).cntDeg);
        cnt2.push(anglesFrom(s[col("muT_B")]!, s[col("muC_B")]!).cntDeg);
      }
    }
    const q = (arr: number[], p: number): number => arr.slice().sort((x, y) => x - y)[Math.floor(p * (arr.length - 1))]!;
    const mean = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / arr.length;
    // eslint-disable-next-line no-console
    console.log(
      `[Mn3Sn canting posterior] ${res.status} acc=${res.acceptanceFraction.toFixed(2)} n=${cnt1.length} ` +
      `cnt1=${mean(cnt1).toFixed(2)}° [${q(cnt1, 0.025).toFixed(2)}, ${q(cnt1, 0.975).toFixed(2)}] (ref ${g.reference.cnt1Deg.toFixed(2)}) ` +
      `cnt2=${mean(cnt2).toFixed(2)}° [${q(cnt2, 0.025).toFixed(2)}, ${q(cnt2, 0.975).toFixed(2)}] (ref ${g.reference.cnt2Deg.toFixed(2)})`,
    );
    // The reference angles must sit inside the sampled 95% intervals, and the
    // short-chain means within a loose ±4° of them.
    expect(q(cnt1, 0.025)).toBeLessThan(g.reference.cnt1Deg);
    expect(q(cnt1, 0.975)).toBeGreaterThan(g.reference.cnt1Deg);
    expect(q(cnt2, 0.025)).toBeLessThan(g.reference.cnt2Deg);
    expect(q(cnt2, 0.975)).toBeGreaterThan(g.reference.cnt2Deg);
    expect(Math.abs(mean(cnt1) - g.reference.cnt1Deg)).toBeLessThan(4);
    expect(Math.abs(mean(cnt2) - g.reference.cnt2Deg)).toBeLessThan(4);
  }, 600_000);
});
