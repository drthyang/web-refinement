import { describe, it, expect } from "vitest";
import {
  durbinWatson,
  durbinWatsonCritical,
  misfitSignature,
  phaseAgreement,
  powderValidation,
  unindexedPeaks,
  worstReflections,
} from "@/core/diagnostics/powderValidation";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";

/** Deterministic standard-normal draws (mulberry32 + Box–Muller). */
function normals(n: number, seed = 1): number[] {
  let a = seed;
  const rand = (): number => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let u = 0;
    while (u === 0) u = rand();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()));
  }
  return out;
}

describe("Durbin–Watson", () => {
  it("is ≈ 2 for white noise, 0 for a constant run, ≈ 4 for an alternating one", () => {
    expect(durbinWatson(normals(20000, 7))).toBeCloseTo(2, 1);
    expect(durbinWatson([1, 1, 1, 1, 1])).toBe(0);
    const alt = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    expect(durbinWatson(alt)).toBeCloseTo(4, 1);
  });

  it("Q_D follows Hill & Flack: 2[(N−1)/(N−P) − 3.0902/√(N+2)]", () => {
    expect(durbinWatsonCritical(4812, 38)).toBeCloseTo(2 * (4811 / 4774 - 3.0902 / Math.sqrt(4814)), 12);
    expect(durbinWatsonCritical(4812, 38)).toBeCloseTo(1.926, 3);
    // Undefined without more points than parameters.
    expect(durbinWatsonCritical(10, 10)).toBe(0);
  });
});

describe("powderValidation", () => {
  const n = 4000;
  const x = Array.from({ length: n }, (_, i) => 10 + i * 0.025);
  const sigma = Array.from({ length: n }, () => 5);
  const bkg = Array.from({ length: n }, () => 400);
  const peaks = x.map((xv) => 3000 * Math.exp(-0.5 * ((xv - 40) / 0.2) ** 2) + 1500 * Math.exp(-0.5 * ((xv - 70) / 0.25) ** 2));
  const yCalc = peaks.map((p, i) => p + bkg[i]!);
  const noise = normals(n, 11);
  const include = x.map(() => true);

  it("noise alone: GoF ≈ 1, d ≈ 2 (not correlated), χ² spread evenly over the shells", () => {
    const yObs = yCalc.map((c, i) => c + sigma[i]! * noise[i]!);
    const v = powderValidation({ x, yObs, yCalc, yBackground: bkg, sigma, include, nParams: 10 });
    expect(v.agreement.n).toBe(n);
    expect(v.agreement.gof).toBeGreaterThan(0.95);
    expect(v.agreement.gof).toBeLessThan(1.05);
    expect(v.agreement.chi2nu).toBeCloseTo(v.agreement.gof ** 2, 10);
    expect(v.durbinWatson!.correlated).toBe(false);
    expect(v.durbinWatson!.d).toBeGreaterThan(1.9);
    // Cumulative χ² is monotone and ends at 1.
    for (let i = 1; i < n; i++) expect(v.cumulative[i]!).toBeGreaterThanOrEqual(v.cumulative[i - 1]!);
    expect(v.cumulative[n - 1]).toBeCloseTo(1, 12);
    expect(v.shells).toHaveLength(10);
    for (const s of v.shells) expect(s.chi2PerPoint).toBeGreaterThan(0.75);
    expect(v.shells.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
  });

  it("matches the engine's R definitions and the background-subtracted set", () => {
    const yObs = yCalc.map((c, i) => c + sigma[i]! * noise[i]!);
    const v = powderValidation({ x, yObs, yCalc, yBackground: bkg, sigma, include, nParams: 10 });
    let sw = 0, swd = 0, sabs = 0, sabsd = 0, swn = 0, sabsn = 0;
    for (let i = 0; i < n; i++) {
      const w = 1 / 25;
      const o = yObs[i]!;
      const d = o - yCalc[i]!;
      sw += w * o * o; swd += w * d * d; sabs += Math.abs(o); sabsd += Math.abs(d);
      swn += w * (o - 400) ** 2; sabsn += Math.abs(o - 400);
    }
    expect(v.agreement.rwp).toBeCloseTo(Math.sqrt(swd / sw), 12);
    expect(v.agreement.rp).toBeCloseTo(sabsd / sabs, 12);
    expect(v.agreement.rexp).toBeCloseTo(Math.sqrt((n - 10) / sw), 12);
    expect(v.agreement.rwpBkg).toBeCloseTo(Math.sqrt(swd / swn), 12);
    expect(v.agreement.rpBkg).toBeCloseTo(sabsd / sabsn, 12);
    // Subtracting a large background makes the same misfit look worse.
    expect(v.agreement.rwpBkg!).toBeGreaterThan(v.agreement.rwp);
  });

  it("a smooth systematic misfit is caught by Durbin–Watson and lands in its shell", () => {
    // Under-calculate the peak at 70 by 8 %: a one-signed residual under it.
    const yObs = yCalc.map((c, i) => c + 0.08 * 1500 * Math.exp(-0.5 * ((x[i]! - 70) / 0.25) ** 2) + sigma[i]! * noise[i]!);
    const v = powderValidation({ x, yObs, yCalc, yBackground: bkg, sigma, include, nParams: 10 });
    expect(v.durbinWatson!.correlated).toBe(true);
    expect(v.durbinWatson!.d).toBeLessThan(v.durbinWatson!.qd);
    const worst = v.shells.reduce((a, s) => (s.chi2PerPoint > a.chi2PerPoint ? s : a));
    expect(worst.lo).toBeLessThanOrEqual(70);
    expect(worst.hi).toBeGreaterThanOrEqual(70);
  });

  it("excluded points carry no residual and do not count", () => {
    const yObs = yCalc.map((c, i) => c + sigma[i]! * noise[i]!);
    const mask = x.map((xv) => xv < 50);
    const v = powderValidation({ x, yObs, yCalc, sigma, include: mask, nParams: 4 });
    expect(v.agreement.n).toBe(mask.filter(Boolean).length);
    expect(Number.isNaN(v.delta[n - 1]!)).toBe(true);
    expect(v.agreement.rwpBkg).toBeUndefined();
    expect(v.shells.every((s) => s.hi < 50)).toBe(true);
  });

  it("shells on d when d is given", () => {
    const yObs = yCalc.map((c, i) => c + sigma[i]! * noise[i]!);
    const d = x.map((xv) => 1.54 / (2 * Math.sin((xv * Math.PI) / 360)));
    const v = powderValidation({ x, yObs, yCalc, sigma, include, nParams: 4, d, shellCount: 5 });
    expect(v.shellAxis).toBe("d");
    expect(v.shells).toHaveLength(5);
    expect(v.shells[0]!.lo).toBeCloseTo(Math.min(...d), 10);
    expect(v.shells[4]!.hi).toBeCloseTo(Math.max(...d), 10);
  });
});

function row(over: Partial<ReflectionObsCalc>): ReflectionObsCalc {
  return { kind: "nuclear", h: 1, k: 0, l: 0, d: 2, iObs: 100, iCalc: 100, phaseId: "a", phaseLabel: "A", phaseIndex: 0, ...over };
}

describe("phaseAgreement", () => {
  it("computes R_Bragg and R_F per phase, crystallographic phases first", () => {
    const rows = [
      row({ iObs: 110, iCalc: 100 }),
      row({ h: 2, iObs: 90, iCalc: 100 }),
      row({ phaseId: "b", phaseLabel: "B", phaseIndex: 1, iObs: 50, iCalc: 40 }),
      row({ kind: "magnetic", phaseId: "magnetic", iObs: 9, iCalc: 4 }),
    ];
    const p = phaseAgreement(rows);
    expect(p.map((x) => x.phaseId)).toEqual(["a", "b", "magnetic"]);
    expect(p[0]!.rBragg).toBeCloseTo(20 / 200, 12);
    expect(p[0]!.rF).toBeCloseTo((Math.abs(Math.sqrt(110) - 10) + Math.abs(Math.sqrt(90) - 10)) / (Math.sqrt(110) + Math.sqrt(90)), 12);
    expect(p[0]!.reflections).toBe(2);
    expect(p[1]!.rBragg).toBeCloseTo(10 / 50, 12);
    expect(p[2]!.kind).toBe("magnetic");
    expect(p[2]!.rF).toBeCloseTo(1 / 3, 12);
  });
});

describe("worstReflections", () => {
  it("ranks by attributed χ² and reads the signature", () => {
    const rows = [
      row({ chi2: 10, misfitMean: 2, misfitLobe: 0.1 }),
      row({ h: 2, chi2: 50, misfitMean: 0.2, misfitLobe: -3 }),
      row({ h: 3, chi2: 20, misfitMean: -1.5, misfitLobe: 0.4 }),
      row({ h: 4 }),
    ];
    const w = worstReflections(rows, 200, 2);
    expect(w.map((r) => r.row.h)).toEqual([2, 3]);
    expect(w[0]!.share).toBeCloseTo(0.25, 12);
    expect(w[0]!.signature).toBe("shape");
    expect(w[1]!.signature).toBe("over");
    expect(misfitSignature(2, 0.1)).toBe("under");
    expect(worstReflections(rows, 0)).toEqual([]);
  });
});

describe("unindexedPeaks", () => {
  it("reports positive residual away from every reflection, not shoulders of known peaks", () => {
    const n = 3000;
    const d = Array.from({ length: n }, (_, i) => 3.2 - i * 0.0008);
    const g = (c: number, w: number, a: number) => d.map((dv) => a * Math.exp(-0.5 * ((dv - c) / w) ** 2));
    const known = g(2.0, 0.004, 5000);
    const yCalc = known.map((v) => v + 200);
    const extra = g(2.5, 0.004, 900);        // nothing indexes here
    const shoulder = g(2.006, 0.004, 900);   // on the known reflection
    const noise = normals(n, 3);
    const sigma = yCalc.map((c) => Math.sqrt(c));
    const yObs = yCalc.map((c, i) => c + extra[i]! + shoulder[i]! + sigma[i]! * noise[i]! * 0.5);
    const include = d.map(() => true);
    const v = powderValidation({ x: d, yObs, yCalc, sigma, include, nParams: 3 });
    const peaks = unindexedPeaks(d, yObs, yCalc, v, [{ d: 2.0, hkl: "1 1 0", phaseLabel: "A" }], { pointSigma: sigma });
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.d).toBeCloseTo(2.5, 2);
    expect(peaks[0]!.share).toBeGreaterThan(0.05);
  });
});
