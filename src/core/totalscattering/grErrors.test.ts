/**
 * Diagnostics of the propagated G(r) error: the legacy σ helper, the
 * continuum correlation laws, the stationary approximation, and the two
 * "independent points" counts — each against a closed form.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveIndependentPoints,
  grUncertaintySummary,
  nyquistPointCount,
  nyquistStep,
  parseSqWithErrors,
  propagateGrSigma,
  stationaryNoiseCorrelation,
  whiteFCorrelation,
  whiteSCorrelation,
} from "@/core/totalscattering/grErrors";
import {
  covarianceEntries,
  sigmaFFromSigmaS,
  sineTransformOperator,
  sineTransformSigma,
} from "@/core/totalscattering/fourier";
import { gaussLegendre } from "@/core/math/quadrature";
import { parsePdfData } from "@/parsers/pdfData";

describe("propagateGrSigma", () => {
  it("is the trapezoid operator's σ — and differs from the old rectangle rule by exactly ¾ of the two endpoint terms", () => {
    // The helper used to weight EVERY node by ΔQ, while the transform it
    // described weights the endpoints by ΔQ/2. In variance that is
    // ΔQ²·(1 − ¼)·(e_first + e_last), e = Q²σ_S² sin²(Qr) — about 1 % of σ here,
    // since the high-Q endpoint carries the largest Q²σ² term.
    const q = Array.from({ length: 200 }, (_, j) => 0.5 + j * 0.05);
    const sig = q.map((qq) => 0.02 + 0.001 * qq);
    const r = [1.0, 2.5, 7.3];
    const out = propagateGrSigma(q, sig, r);
    const ref = sineTransformSigma(sineTransformOperator(q), sigmaFFromSigmaS(q, sig), r);
    expect(Array.from(out)).toEqual(Array.from(ref));
    const dq = 0.05;
    const last = q.length - 1;
    for (let i = 0; i < r.length; i++) {
      let rect = 0;
      for (let j = 0; j < q.length; j++) rect += q[j]! ** 2 * Math.sin(q[j]! * r[i]!) ** 2 * sig[j]! ** 2;
      const e = (j: number): number => q[j]! ** 2 * sig[j]! ** 2 * Math.sin(q[j]! * r[i]!) ** 2;
      const pref = ((2 * dq) / Math.PI) ** 2;
      expect(pref * rect - out[i]! ** 2).toBeCloseTo(pref * 0.75 * (e(0) + e(last)), 15);
    }
  });

  it("scales linearly with σ_S and vanishes with it", () => {
    const q = Array.from({ length: 100 }, (_, j) => 0.5 + j * 0.1);
    const s1 = propagateGrSigma(q, q.map(() => 0.05), [3.0]);
    const s2 = propagateGrSigma(q, q.map(() => 0.10), [3.0]);
    expect(s2[0]! / s1[0]!).toBeCloseTo(2, 12);
    expect(propagateGrSigma(q, q.map(() => 0), [3.0])[0]).toBe(0);
  });

  it("parseSqWithErrors reads the Mantid # X Y E dialect", () => {
    const { q, s, sigma } = parseSqWithErrors("# X   Y   E Distribution=true\n1.0 0.5 0.05\n1.1 0.6 0.04\nbad line\n");
    expect(q).toEqual([1.0, 1.1]);
    expect(s).toEqual([0.5, 0.6]);
    expect(sigma).toEqual([0.05, 0.04]);
  });
});

describe("continuum correlation laws", () => {
  const gl = gaussLegendre(80);
  /** ∫_0^1 x^{2p} cos(ux) dx / ∫_0^1 x^{2p} dx by quadrature. */
  const numeric = (p: number, u: number): number => {
    let acc = 0;
    gl.nodes.forEach((t, i) => {
      const x = 0.5 * (t + 1);
      acc += gl.weights[i]! * x ** (2 * p) * Math.cos(u * x);
    });
    return 0.5 * acc * (2 * p + 1);
  };

  it("white F: sin u/u; white S: 3[(u²−2)sin u + 2u cos u]/u³ — against quadrature, both sides of the series switch", () => {
    for (const u of [0, 1e-4, 0.05, 0.7, 1.999999, 2.000001, Math.PI, 4.2, 9.9, 30]) {
      expect(whiteFCorrelation(u)).toBeCloseTo(numeric(0, u), 13);
      expect(whiteSCorrelation(u)).toBeCloseTo(numeric(1, u), 13);
    }
  });

  it("white-F points at Nyquist spacing are uncorrelated; white-S ones correlate at −6/π²", () => {
    for (const m of [1, 2, 3, 7]) expect(Math.abs(whiteFCorrelation(m * Math.PI))).toBeLessThan(1e-15);
    expect(whiteSCorrelation(Math.PI)).toBeCloseTo(-6 / (Math.PI * Math.PI), 14);
  });

  it("the discrete stationary correlation approaches the continuum laws on a fine Q grid from 0", () => {
    const qmax = 25;
    const q = Array.from({ length: 5001 }, (_, k) => (k * qmax) / 5000);
    const op = sineTransformOperator(q);
    const white = q.map(() => 1);
    const sOnly = sigmaFFromSigmaS(q, white); // σ_F = Q
    const us = [0.3, 1, Math.PI, 5, 2 * Math.PI];
    const rhoF = stationaryNoiseCorrelation(op, white, us.map((u) => u / qmax));
    const rhoS = stationaryNoiseCorrelation(op, sOnly, us.map((u) => u / qmax));
    us.forEach((u, i) => {
      expect(rhoF[i]!).toBeCloseTo(whiteFCorrelation(u), 3);
      expect(rhoS[i]!).toBeCloseTo(whiteSCorrelation(u), 3);
    });
  });

  it("far from r = 0 the exact covariance correlation IS the stationary one (the Hankel term has decayed)", () => {
    const q = Array.from({ length: 1201 }, (_, k) => 0.5 + 0.02 * k);
    const sigmaF = sigmaFFromSigmaS(q, q.map((x) => 0.01 + 0.0005 * x));
    const op = sineTransformOperator(q);
    const h = 0.01;
    const r = Array.from({ length: 30 }, (_, i) => 30 + i * h);
    const entry = covarianceEntries(op, sigmaF, r);
    const lags = [1, 3, 12]; // includes ≈ the Nyquist spacing π/24.5 ≈ 0.128 Å
    const stationary = stationaryNoiseCorrelation(op, sigmaF, lags.map((d) => d * h));
    lags.forEach((d, i) => {
      const exact = entry(0, d) / Math.sqrt(entry(0, 0) * entry(d, d));
      expect(Math.abs(exact - stationary[i]!)).toBeLessThan(5e-3);
    });
  });
});

describe("independent points in a fit window", () => {
  const qmax = 20;
  const q = Array.from({ length: 2001 }, (_, k) => k * 0.01); // 0 … 20 Å⁻¹
  const op = sineTransformOperator(q);
  const rWindow = Array.from({ length: 1001 }, (_, i) => 10 + 0.02 * i); // 10 … 30 Å
  const nNyq = nyquistPointCount(10, 30, qmax);

  it("Nyquist step and count", () => {
    expect(nyquistStep(qmax)).toBeCloseTo(Math.PI / 20, 15);
    expect(nNyq).toBeCloseTo((20 * 20) / Math.PI, 12);
    expect(nyquistPointCount(5, 3, qmax)).toBe(0);
  });

  it("white F(Q) noise: the participation ratio recovers the sampling-theorem count", () => {
    const nEff = effectiveIndependentPoints(op, q.map(() => 0.01), rWindow);
    expect(nEff / nNyq).toBeGreaterThan(0.95);
    expect(nEff / nNyq).toBeLessThan(1.05);
  });

  it("white S(Q) noise (σ_F ∝ Q): only ≈ 5/9 of it — the spectrum ∝ Q² gives (∫x²)²/∫x⁴", () => {
    const nEff = effectiveIndependentPoints(op, sigmaFFromSigmaS(q, q.map(() => 0.01)), rWindow);
    expect(nEff / nNyq).toBeGreaterThan((5 / 9) * 0.95);
    expect(nEff / nNyq).toBeLessThan((5 / 9) * 1.05);
  });

  it("white F(Q) noise sampled ON the Nyquist grid: every point is independent (N_eff = n)", () => {
    const rNyq = Array.from({ length: 40 }, (_, j) => ((j + 30) * Math.PI) / qmax);
    expect(effectiveIndependentPoints(op, q.map(() => 0.01), rNyq)).toBeCloseTo(40, 9);
  });
});

describe("grUncertaintySummary", () => {
  /** A synthetic Mantid-style three-column S(Q) file with constant σ_S. */
  function sqFile(withSigma: boolean): string {
    const rows: string[] = ["# X Y E"];
    for (let k = 0; k <= 1225; k++) {
      const qq = 0.5 + 0.02 * k;
      const s = 1 + (0.6 * Math.sin(2.5 * qq)) / (2.5 * qq) * Math.exp(-0.004 * qq * qq);
      rows.push(withSigma ? `${qq.toFixed(4)} ${s.toFixed(8)} 0.005` : `${qq.toFixed(4)} ${s.toFixed(8)}`);
    }
    return rows.join("\n");
  }

  it("summarizes the window: Nyquist oversampling, white-S correlations, ≈5/9 effective points", () => {
    const pattern = parsePdfData(sqFile(true), { filename: "synthetic.sq" });
    const s = grUncertaintySummary(pattern, { min: 1.5, max: 20 })!;
    expect(s).not.toBeNull();
    const qmax = 0.5 + 0.02 * 1225;
    expect(s.nyquistStep).toBeCloseTo(Math.PI / qmax, 12);
    expect(s.gridStep).toBeCloseTo(0.01, 12);
    expect(s.oversampling).toBeCloseTo(Math.PI / qmax / 0.01, 9);
    expect(s.nyquistPoints).toBeCloseTo(((20 - 1.5) * qmax) / Math.PI, 6);
    // Constant σ_S is the white-S case (the Q window starts at 0.5, not 0, so
    // the continuum laws hold to the low-Q sliver's weight, < 1 %).
    expect(s.rhoNyquist).toBeCloseTo(whiteSCorrelation(Math.PI), 2);
    expect(s.rhoNeighbor).toBeCloseTo(whiteSCorrelation(qmax * 0.01), 2);
    expect(s.effectivePoints / s.nyquistPoints).toBeGreaterThan((5 / 9) * 0.93);
    expect(s.effectivePoints / s.nyquistPoints).toBeLessThan((5 / 9) * 1.07);
    // σ on the points is the propagated one, and the summary reads the same numbers.
    const inWin = pattern.points.filter((p) => p.r >= 1.5 && p.r <= 20).map((p) => p.sigma!).sort((a, b) => a - b);
    expect(s.medianSigma).toBe(inWin[Math.floor((inWin.length - 1) / 2)]);
    expect(s.maxSigma).toBe(inWin[inWin.length - 1]);
  });

  it("is null without an error column, for a G(r) file, or for an empty window", () => {
    expect(grUncertaintySummary(parsePdfData(sqFile(false), { filename: "synthetic.sq" }), { min: 1.5, max: 20 })).toBeNull();
    const gr = parsePdfData("#L r G(r)\n1.0 0.1\n1.01 0.2\n1.02 0.3\n", { filename: "x.gr" });
    expect(grUncertaintySummary(gr, { min: 0, max: 5 })).toBeNull();
    expect(grUncertaintySummary(parsePdfData(sqFile(true), { filename: "synthetic.sq" }), { min: 40, max: 50 })).toBeNull();
  });
});
