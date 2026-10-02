/**
 * The S(Q)/F(Q) → G(r) operator: values, σ and covariance from ONE set of
 * quadrature coefficients. Gates, strongest first:
 *
 *  1. brute-force Jacobian — every operator column ∂G/∂F_k is obtained by
 *     transforming a unit vector, so J·U_F·Jᵀ is computed from the VALUE path
 *     alone and the σ / covariance paths must reproduce it (every option);
 *  2. Monte Carlo — seeded noise realizations on S(Q), transformed, give the
 *     propagated variances and correlations (no formula shared with 1);
 *  3. closed forms — DST-I orthogonality on the Nyquist grid, σ_G(0) = 0 and
 *     its small-r slope, the large-r plateau ½P(0), the low-Q integrals
 *     against Gauss–Legendre quadrature.
 *
 * External goldens (pystog, RMCProfile StoG) live in pystogGolden.test.ts and
 * stogGolden.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  correlationFromCovariance,
  covarianceEntries,
  defaultTransformGrid,
  fOfQFromSOfQ,
  gOfRFromFOfQ,
  lorchModification,
  lowQIntegrals,
  noiseAutocorrelation,
  sigmaFFromSigmaS,
  sineTransform,
  sineTransformCovariance,
  sineTransformOperator,
  sineTransformSigma,
  transformReciprocal,
  trapezoidWeights,
  type SineTransformOptions,
} from "@/core/totalscattering/fourier";
import { gaussLegendre } from "@/core/math/quadrature";

/** mulberry32 → uniform [0,1); Box–Muller → N(0,1). Deterministic per seed. */
function normalRng(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    const u = 1 - uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
}

/** Toy S(Q): damped Debye shells about 1, the shape real data have. */
function toySofQ(q: number): number {
  const shells = [[2.5, 0.6, 0.006], [3.6, 0.45, 0.009], [4.4, 0.35, 0.011]] as const;
  let s = 1;
  for (const [d, n, u] of shells) s += (n * Math.sin(q * d)) / (q * d) * Math.exp(-0.5 * u * q * q * d);
  return s;
}

/** All four option combinations. */
const OPTION_SETS: readonly [string, SineTransformOptions][] = [
  ["plain", {}],
  ["lorch", { modification: "lorch" }],
  ["low-Q", { lowQ: "linear" }],
  ["lorch + low-Q", { modification: "lorch", lowQ: "linear" }],
];

describe("fOfQFromSOfQ / sigmaFFromSigmaS", () => {
  it("F(Q) = Q·(S−1) and σ_F = Q·σ_S", () => {
    expect(Array.from(fOfQFromSOfQ([1, 2, 4], [1.5, 1, 0.75]))).toEqual([0.5, 0, -1]);
    expect(Array.from(sigmaFFromSigmaS([1, 2, 4], [0.1, 0.2, 0.05]))).toEqual([0.1, 0.4, 0.2]);
  });
});

describe("quadrature and operator construction", () => {
  it("trapezoid weights sum to the window length, also on a non-uniform grid", () => {
    const q = [0.3, 0.35, 0.5, 0.8, 0.81, 1.4];
    const w = trapezoidWeights(q);
    expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1.4 - 0.3, 14);
    expect(w[0]).toBeCloseTo(0.025, 15);
    expect(w[2]).toBeCloseTo((0.8 - 0.35) / 2, 15);
  });

  it("the value path equals an explicit trapezoid accumulation (the pre-operator implementation)", () => {
    const q: number[] = [];
    for (let x = 0.4; x <= 18; x *= 1.003) q.push(x);
    const f = fOfQFromSOfQ(q, q.map(toySofQ));
    const r = [0.7, 2.5, 3.61, 9.9];
    const g = gOfRFromFOfQ(q, f, r);
    r.forEach((ri, j) => {
      let acc = 0;
      for (let i = 1; i < q.length; i++) {
        acc += 0.5 * (f[i - 1]! * Math.sin(q[i - 1]! * ri) + f[i]! * Math.sin(q[i]! * ri)) * (q[i]! - q[i - 1]!);
      }
      expect(g[j]).toBeCloseTo((2 / Math.PI) * acc, 12);
    });
  });

  it("windows to [qmin, qmax] and records the nodes actually integrated", () => {
    const q = Array.from({ length: 100 }, (_, i) => 0.25 + 0.25 * i);
    const op = sineTransformOperator(q, { qmin: 1.1, qmax: 20.05 });
    expect(op.qmin).toBe(1.25);
    expect(op.qmax).toBe(20);
    expect(op.first).toBe(4);
    expect(op.q.length).toBe(76);
  });

  it("refuses a non-ascending grid or a window with fewer than two nodes", () => {
    expect(() => sineTransformOperator([1, 2, 2, 3])).toThrow(/strictly ascending/);
    expect(() => sineTransformOperator([1, 2, 3], { qmin: 2.5, qmax: 2.9 })).toThrow(/fewer than two/);
  });

  it("Lorch M(Q): 1 at Q = 0, 0 at Qmax, 2/π at Qmax/2", () => {
    expect(lorchModification(0, 25)).toBe(1);
    expect(Math.abs(lorchModification(25, 25))).toBeLessThan(1e-15);
    expect(lorchModification(12.5, 25)).toBeCloseTo(2 / Math.PI, 15);
  });
});

describe("sine transform — physics of the value path", () => {
  it("a pure mode F(Q) = sin(Q·r0) transforms to a termination-kernel peak at r0", () => {
    const qmax = 25;
    const r0 = 2.5;
    const q = Array.from({ length: 2500 }, (_, i) => (i + 1) * 0.01);
    const f = q.map((qi) => Math.sin(qi * r0));
    const rGrid = defaultTransformGrid(6, 0.005);
    const g = gOfRFromFOfQ(q, f, rGrid);
    let best = -Infinity;
    let bestR = 0;
    for (let j = 0; j < rGrid.length; j++) {
      if (g[j]! > best) { best = g[j]!; bestR = rGrid[j]!; }
    }
    expect(bestR).toBeCloseTo(r0, 2);
    expect(best).toBeCloseTo(qmax / Math.PI, 1); // (2/π)·(Qmax/2)
    const at = (r: number): number => g[Math.round(r / 0.005) - 1]!;
    expect(Math.abs(at(r0 + Math.PI / qmax))).toBeLessThan(0.05 * best); // sinc first zero
    expect(at(r0 + 1.43 * (Math.PI / qmax))).toBeLessThan(0); // first sidelobe
  });

  it("handles a non-uniform Q grid (trapezoid, not FFT)", () => {
    const r0 = 3.0;
    const q: number[] = [];
    for (let x = 0.01; x <= 20; x *= 1.004) q.push(x);
    const g = gOfRFromFOfQ(q, q.map((qi) => Math.sin(qi * r0)), defaultTransformGrid(5, 0.01));
    let bestR = 0;
    let best = -Infinity;
    for (let j = 0; j < g.length; j++) if (g[j]! > best) { best = g[j]!; bestR = (j + 1) * 0.01; }
    expect(bestR).toBeCloseTo(r0, 1);
  });

  it("Lorch: first sidelobe and peak height match the analytic Lorch kernel", () => {
    // The Lorch real-space kernel is the sinc averaged over ±π/Qmax, so with
    // u = Qmax·(r − r0): G ∝ ∫_{u−π}^{u+π} sin t/t dt. Its first minimum is at
    // u = 2π (d/du ∝ sin u/(u² − π²)), giving [Si(3π) − Si(π)]/(2 Si(π)) of
    // the peak; the peak itself drops to Si(π)/π of the unmodified sinc's.
    // Unmodified: the EXACT continuum transform of the mode, including the odd
    // reflection at r = 0 that the sinc alone omits (~1/(2r0·Qmax) ≈ 0.8 % of
    // the peak here; the Lorch reflection is ~1e-4 and below the tolerance):
    //   G(r) = (1/π)[sin(Qmax(r − r0))/(r − r0) − sin(Qmax(r + r0))/(r + r0)].
    const SI_PI = 1.851937051982466; // Si(π)
    const SI_3PI = 1.674761798979961; // Si(3π)
    const r0 = 2.5;
    const qmax = 25;
    const q = Array.from({ length: 2500 }, (_, i) => (i + 1) * 0.01);
    const f = q.map((qi) => Math.sin(qi * r0));
    const r = defaultTransformGrid(6, 0.001);
    const plain = sineTransform(sineTransformOperator(q), f, r).g;
    const lorch = sineTransform(sineTransformOperator(q, { modification: "lorch" }), f, r).g;
    const lobe = (g: Float64Array): number => Math.min(...Array.from(g).filter((_, j) => r[j]! > r0 + 0.1 && r[j]! < r0 + 0.4));
    const peak = (g: Float64Array): number => Math.max(...Array.from(g));
    const exact = Float64Array.from(r, (x) => {
      const d = x - r0;
      const head = Math.abs(d) < 1e-12 ? qmax : Math.sin(qmax * d) / d;
      return (head - Math.sin(qmax * (x + r0)) / (x + r0)) / Math.PI;
    });
    expect(lobe(plain) / peak(plain)).toBeCloseTo(lobe(exact) / peak(exact), 3);
    expect(lobe(lorch) / peak(lorch)).toBeCloseTo((SI_3PI - SI_PI) / (2 * SI_PI), 3);
    expect(peak(lorch) / peak(plain)).toBeCloseTo(SI_PI / Math.PI, 2);
  });

  it("is linear in F (the property every propagation formula rests on)", () => {
    const q = Array.from({ length: 300 }, (_, i) => 0.5 + 0.05 * i);
    const f1 = q.map((x) => Math.sin(1.7 * x) * Math.exp(-0.01 * x * x));
    const f2 = q.map((x) => 0.3 * Math.cos(2.9 * x));
    const r = [0.3, 1.9, 4.4, 11];
    for (const [, opts] of OPTION_SETS) {
      // G is AFFINE under the low-Q extrapolation (the −1 in S−1 at Q → 0), so
      // compare differences: G(a·f1 + b·f2) − G(0) = a·[G(f1) − G(0)] + b·[G(f2) − G(0)].
      const op = sineTransformOperator(q, opts);
      const zero = sineTransform(op, q.map(() => 0), r).g;
      const g1 = sineTransform(op, f1, r).g;
      const g2 = sineTransform(op, f2, r).g;
      const g12 = sineTransform(op, f1.map((v, i) => 2 * v - 3 * f2[i]!), r).g;
      for (let j = 0; j < r.length; j++) {
        expect(g12[j]! - zero[j]!).toBeCloseTo(2 * (g1[j]! - zero[j]!) - 3 * (g2[j]! - zero[j]!), 11);
      }
    }
  });
});

describe("uncertainty propagation — the exact linear law, against a brute-force Jacobian", () => {
  const q = Array.from({ length: 70 }, (_, i) => 0.6 + 0.31 * i); // 0.6 … 22 Å⁻¹
  const sigmaS = q.map((x) => 0.004 + 0.0007 * x + 0.003 * Math.exp(-x)); // grows with Q, like real data
  const sigmaF = sigmaFFromSigmaS(q, sigmaS);
  const rUniform = Array.from({ length: 24 }, (_, i) => 0.05 + 0.137 * i);
  const rRagged = [0.02, 0.4, 0.41, 1.3, 2.75, 2.8, 6.1, 9.0];

  /** J[i][k] = ∂G(r_i)/∂F_k from the VALUE path: G(e_k) − G(0). */
  function jacobian(opts: SineTransformOptions, r: readonly number[]): number[][] {
    const op = sineTransformOperator(q, opts);
    const zero = sineTransform(op, q.map(() => 0), r).g;
    const cols = q.map((_, k) => {
      const e = q.map((__, i) => (i === k ? 1 : 0));
      const g = sineTransform(op, e, r).g;
      return r.map((__, i) => g[i]! - zero[i]!);
    });
    return r.map((_, i) => cols.map((c) => c[i]!));
  }

  for (const [label, opts] of OPTION_SETS) {
    it(`${label}: σ_G = √(Σ_k J_ik² σ_k²)`, () => {
      const J = jacobian(opts, rUniform);
      const sigma = sineTransformSigma(sineTransformOperator(q, opts), sigmaF, rUniform);
      J.forEach((row, i) => {
        const ref = Math.sqrt(row.reduce((s, jik, k) => s + jik * jik * sigmaF[k]! ** 2, 0));
        expect(Math.abs(sigma[i]! - ref)).toBeLessThan(1e-12 * Math.max(ref, 1e-6));
      });
    });

    for (const [gridLabel, r] of [["uniform r (Toeplitz − Hankel)", rUniform], ["non-uniform r (direct sum)", rRagged]] as const) {
      it(`${label}, ${gridLabel}: Cov = J·diag(σ²)·Jᵀ`, () => {
        const J = jacobian(opts, r);
        const op = sineTransformOperator(q, opts);
        const cov = sineTransformCovariance(op, sigmaF, r);
        const n = r.length;
        let scale = 0;
        for (let i = 0; i < n; i++) scale = Math.max(scale, cov[i * n + i]!);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const ref = J[i]!.reduce((s, jik, k) => s + jik * J[j]![k]! * sigmaF[k]! ** 2, 0);
            expect(Math.abs(cov[i * n + j]! - ref)).toBeLessThan(1e-12 * scale);
          }
        }
      });
    }

    it(`${label}: √diag(Cov) IS sineTransformSigma (bit-identical), and the entry accessor IS the matrix`, () => {
      const op = sineTransformOperator(q, opts);
      const cov = sineTransformCovariance(op, sigmaF, rUniform);
      const sigma = sineTransformSigma(op, sigmaF, rUniform);
      const entry = covarianceEntries(op, sigmaF, rUniform);
      const n = rUniform.length;
      for (let i = 0; i < n; i++) {
        expect(Math.sqrt(cov[i * n + i]!)).toBe(sigma[i]);
        for (let j = 0; j < n; j++) expect(entry(i, j)).toBe(cov[i * n + j]);
      }
      // sineTransform's σ (value + σ in one pass) is the same numbers too.
      expect(Array.from(sineTransform(op, fOfQFromSOfQ(q, q.map(toySofQ)), rUniform, sigmaF).sigma!)).toEqual(Array.from(sigma));
    });
  }

  it("the covariance is symmetric positive semi-definite (Cholesky with jitter succeeds)", () => {
    const op = sineTransformOperator(q, { lowQ: "linear" });
    const n = rUniform.length;
    const c = sineTransformCovariance(op, sigmaF, rUniform);
    const scale = Math.max(...Array.from({ length: n }, (_, i) => c[i * n + i]!));
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = c[i * n + j]! + (i === j ? 1e-12 * scale : 0);
        for (let k = 0; k < j; k++) s -= L[i * n + k]! * L[j * n + k]!;
        if (i === j) {
          expect(s).toBeGreaterThan(0);
          L[i * n + i] = Math.sqrt(s);
        } else L[i * n + j] = s / L[j * n + j]!;
      }
    }
  });
});

describe("uncertainty propagation — Monte Carlo (independent of every formula above)", () => {
  it("transformed noise realizations reproduce the propagated variances and correlations", () => {
    const q = Array.from({ length: 160 }, (_, i) => 0.5 + 0.12 * i); // 0.5 … 19.6 Å⁻¹
    const s0 = q.map(toySofQ);
    const sigmaS = q.map((x) => 0.01 * (1 + 0.08 * x));
    const r = [0.15, 1.0, 1.08, 2.5, 7.7];
    const op = sineTransformOperator(q, { lowQ: "linear", modification: "lorch" });
    const cov = sineTransformCovariance(op, sigmaFFromSigmaS(q, sigmaS), r);
    const n = r.length;

    const M = 20000;
    const rng = normalRng(20261002);
    const sum = new Float64Array(n);
    const sumXY = new Float64Array(n * n);
    for (let m = 0; m < M; m++) {
      const s = s0.map((v, k) => v + sigmaS[k]! * rng());
      const g = sineTransform(op, fOfQFromSOfQ(q, s), r).g;
      for (let i = 0; i < n; i++) {
        sum[i] = sum[i]! + g[i]!;
        for (let j = 0; j < n; j++) sumXY[i * n + j] = sumXY[i * n + j]! + g[i]! * g[j]!;
      }
    }
    const emp = (i: number, j: number): number => sumXY[i * n + j]! / M - (sum[i]! / M) * (sum[j]! / M);
    const rho = correlationFromCovariance(cov, n);
    for (let i = 0; i < n; i++) {
      // SE of a sample variance is σ²·√(2/M) ≈ 1 %; 5 % is 5 SE.
      expect(Math.abs(emp(i, i) / cov[i * n + i]! - 1)).toBeLessThan(0.05);
      for (let j = i + 1; j < n; j++) {
        const empRho = emp(i, j) / Math.sqrt(emp(i, i) * emp(j, j));
        // SE of a sample correlation ≈ (1 − ρ²)/√M ≤ 0.007.
        expect(Math.abs(empRho - rho[i * n + j]!)).toBeLessThan(0.035);
      }
    }
    // The pair 1.00/1.08 Å is 0.08 Å apart — far below π/Qmax ≈ 0.16 Å, so the
    // two "independent-looking" grid points are in fact strongly correlated.
    expect(rho[1 * n + 2]!).toBeGreaterThan(0.5);
  });
});

describe("closed forms", () => {
  it("white F(Q) noise on the Nyquist grid is EXACTLY uncorrelated (DST-I orthogonality)", () => {
    // Q_k = kΔQ, k = 0…K (Q_0 = 0), r_j = jπ/Qmax: Σ_k sin(πkj/K) sin(πkl/K) = (K/2)δ_jl
    // for 1 ≤ j, l ≤ K−1; the trapezoid half-weights fall on nodes where every sine is 0.
    const K = 400;
    const dq = 0.06;
    const qmax = K * dq;
    const q = Array.from({ length: K + 1 }, (_, k) => k * dq);
    const sigmaF = q.map(() => 0.02);
    const r = Array.from({ length: 60 }, (_, j) => ((j + 1) * Math.PI) / qmax);
    const op = sineTransformOperator(q);
    const cov = sineTransformCovariance(op, sigmaF, r);
    const n = r.length;
    const expected = ((2 * dq * 0.02) / Math.PI) ** 2 * (K / 2);
    for (let i = 0; i < n; i++) {
      expect(cov[i * n + i]! / expected).toBeCloseTo(1, 12);
      for (let j = i + 1; j < n; j++) expect(Math.abs(cov[i * n + j]!)).toBeLessThan(1e-12 * expected);
    }
  });

  it("σ_G(0) = 0, σ_G ∝ r below π/Qmax with slope (2/π)√Σ(w_k Q_k σ_F,k)², plateau ½P(0) far out", () => {
    const q = Array.from({ length: 1200 }, (_, i) => 0.4 + 0.02 * i);
    const sigmaF = sigmaFFromSigmaS(q, q.map((x) => 0.003 + 0.0002 * x));
    const op = sineTransformOperator(q);
    expect(sineTransformSigma(op, sigmaF, [0])[0]).toBe(0);
    const w = trapezoidWeights(q);
    let s = 0;
    for (let k = 0; k < q.length; k++) s += (w[k]! * q[k]! * sigmaF[k]!) ** 2;
    const slope = (2 / Math.PI) * Math.sqrt(s);
    expect(sineTransformSigma(op, sigmaF, [1e-5])[0]! / 1e-5).toBeCloseTo(slope, 6);
    const far = sineTransformSigma(op, sigmaF, Array.from({ length: 500 }, (_, i) => 40 + 0.0137 * i));
    const meanVar = far.reduce((acc, v) => acc + v * v, 0) / far.length;
    const p0 = noiseAutocorrelation(op, sigmaF, [0])[0]!;
    expect(meanVar / (0.5 * p0)).toBeCloseTo(1, 2);
  });

  describe("low-Q integrals I_1, I_2 against 96-point Gauss–Legendre", () => {
    const gl = gaussLegendre(96);
    const numeric = (n: 1 | 2, r: number, q0: number, mod: "none" | "lorch", qmax: number): number => {
      let acc = 0;
      gl.nodes.forEach((x, i) => {
        const qq = 0.5 * q0 * (x + 1);
        const m = mod === "lorch" ? lorchModification(qq, qmax) : 1;
        acc += gl.weights[i]! * qq ** n * m * Math.sin(qq * r);
      });
      return 0.5 * q0 * acc;
    };
    const q0 = 0.9;
    const qmax = 26;
    const A = Math.PI / qmax; // the Lorch branch's removable singularity at r = A
    // Both sides of the series/closed-form switch (Q0·r = 2), the Lorch
    // removable singularity r = A, tiny r (where the closed forms cancel).
    const radii = [1e-4, 0.01, A, A + 1e-9, 0.37, 2 / q0 - 1e-9, 2 / q0 + 1e-9, 4.1, 13.7, 38];
    for (const mod of ["none", "lorch"] as const) {
      it(`${mod}: closed forms (and their series branches) match quadrature`, () => {
        for (const r of radii) {
          const { i1, i2 } = lowQIntegrals(r, q0, mod, qmax);
          const n1 = numeric(1, r, q0, mod, qmax);
          const n2 = numeric(2, r, q0, mod, qmax);
          expect(Math.abs(i1 - n1)).toBeLessThan(1e-13 * Math.abs(n1));
          expect(Math.abs(i2 - n2)).toBeLessThan(1e-13 * Math.abs(n2));
        }
      });
    }
  });
});

describe("low-Q integrals at the smallest r", () => {
  it("low-Q I_2 at tiny r: ours matches 50-digit mpmath where the StoG/pystog closed form cancels to 1e-6", () => {
    // ∫_0^{0.5} Q² sin(Qr) dQ by mpmath.quad at 50 digits.
    const I2_MP = { 0.01: 0.00015624956597262913, 0.02: 0.0003124965277907986 } as const;
    for (const r of [0.01, 0.02] as const) {
      const v = 0.5 * r;
      const closed = (2 * v * Math.sin(v) - (v * v - 2) * Math.cos(v) - 2) / r ** 3; // StoG/pystog's expression
      const ours = lowQIntegrals(r, 0.5, "none", 26).i2;
      expect(Math.abs(ours / I2_MP[r] - 1)).toBeLessThan(1e-15);
      expect(Math.abs(closed / I2_MP[r] - 1)).toBeGreaterThan(1e-9);
    }
  });

});

describe("transformReciprocal", () => {
  it("S(Q) with σ_S and the equivalent F(Q) with σ_F = Q·σ_S give the same G and σ_G", () => {
    const q = Array.from({ length: 400 }, (_, i) => 0.5 + 0.05 * i);
    const s = q.map(toySofQ);
    const sig = q.map((x) => 0.002 + 0.0001 * x);
    const r = defaultTransformGrid(8, 0.05);
    const a = transformReciprocal({ kind: "sq", q, y: s, sigma: sig }, r, { lowQ: "linear" });
    const f = Array.from(fOfQFromSOfQ(q, s));
    const b = transformReciprocal({ kind: "fq", q, y: f, sigma: Array.from(sigmaFFromSigmaS(q, sig)) }, r, { lowQ: "linear" });
    expect(Array.from(a.g)).toEqual(Array.from(b.g));
    expect(Array.from(a.sigma!)).toEqual(Array.from(b.sigma!));
  });

  it("no σ column → values only", () => {
    const q = Array.from({ length: 50 }, (_, i) => 1 + 0.2 * i);
    const t = transformReciprocal({ kind: "sq", q, y: q.map(toySofQ) }, [1, 2, 3]);
    expect(t.sigma).toBeUndefined();
    expect(t.g.length).toBe(3);
  });
});
