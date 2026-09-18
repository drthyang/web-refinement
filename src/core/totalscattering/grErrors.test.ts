/**
 * σ_G(r) propagation from S(Q) errors — synthetic checks of the closed form
 * σ_G(r)² = (2ΔQ/π)² Σ Q² sin²(Qr) σ_S(Q)².
 */
import { describe, it, expect } from "vitest";
import { propagateGrSigma, parseSqWithErrors } from "@/core/totalscattering/grErrors";

describe("propagateGrSigma", () => {
  it("matches a direct evaluation of the closed form", () => {
    const q = Array.from({ length: 200 }, (_, j) => 0.5 + j * 0.05);
    const sig = q.map((qq) => 0.02 + 0.001 * qq);
    const r = [1.0, 2.5, 7.3];
    const out = propagateGrSigma(q, sig, r);
    const dq = 0.05;
    for (let i = 0; i < r.length; i++) {
      let acc = 0;
      for (let j = 0; j < q.length; j++) acc += q[j]! ** 2 * Math.sin(q[j]! * r[i]!) ** 2 * sig[j]! ** 2;
      expect(out[i]).toBeCloseTo(((2 * dq) / Math.PI) * Math.sqrt(acc), 12);
    }
  });

  it("scales linearly with σ_S and vanishes with it", () => {
    const q = Array.from({ length: 100 }, (_, j) => 0.5 + j * 0.1);
    const s1 = propagateGrSigma(q, q.map(() => 0.05), [3.0]);
    const s2 = propagateGrSigma(q, q.map(() => 0.10), [3.0]);
    expect(s2[0]! / s1[0]!).toBeCloseTo(2, 12);
    expect(propagateGrSigma(q, q.map(() => 0), [3.0])[0]).toBe(0);
    // sin² averages to ~1/2 over many periods: σ ≈ (2ΔQ/π)·σ_S·√(ΣQ²/2)
    let sumQ2 = 0;
    for (const qq of q) sumQ2 += qq * qq;
    expect(s1[0]).toBeCloseTo(((2 * 0.1) / Math.PI) * 0.05 * Math.sqrt(sumQ2 / 2), 2);
  });

  it("parseSqWithErrors reads the Mantid # X Y E dialect", () => {
    const { q, s, sigma } = parseSqWithErrors("# X   Y   E Distribution=true\n1.0 0.5 0.05\n1.1 0.6 0.04\nbad line\n");
    expect(q).toEqual([1.0, 1.1]);
    expect(s).toEqual([0.5, 0.6]);
    expect(sigma).toEqual([0.05, 0.04]);
  });
});
