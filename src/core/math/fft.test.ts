import { describe, it, expect } from "vitest";
import { convolveCyclicFft, convolveFullFft, fftInPlace, nextPowerOfTwo } from "@/core/math/fft";

/** Deterministic pseudo-random stream (no test-run-to-test-run drift). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

function randomArray(n: number, seed: number): Float64Array {
  const rand = lcg(seed);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = rand();
  return a;
}

/** O(N²) reference DFT with the same sign convention as {@link fftInPlace}. */
function naiveDft(re: ArrayLike<number>, im: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(angle), s = Math.sin(angle);
      sr += re[t]! * c - im[t]! * s;
      si += re[t]! * s + im[t]! * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function convolveDirect(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]! + a[i]! * b[j]!;
  }
  return out;
}

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

describe("nextPowerOfTwo", () => {
  it("rounds up, and is the identity on powers of two", () => {
    expect([0, 1, 2, 3, 5, 1024, 1025].map(nextPowerOfTwo)).toEqual([1, 1, 2, 4, 8, 1024, 2048]);
  });
});

describe("fftInPlace", () => {
  it("matches a naive DFT", () => {
    const re = randomArray(64, 7);
    const im = randomArray(64, 99);
    const want = naiveDft(re, im);
    const gotRe = Float64Array.from(re);
    const gotIm = Float64Array.from(im);
    fftInPlace(gotRe, gotIm, false);
    const scale = Math.max(maxAbs(want.re), maxAbs(want.im));
    expect(maxDiff(gotRe, want.re)).toBeLessThan(1e-12 * scale);
    expect(maxDiff(gotIm, want.im)).toBeLessThan(1e-12 * scale);
  });

  it("inverts itself", () => {
    const re = randomArray(256, 3);
    const im = randomArray(256, 4);
    const workRe = Float64Array.from(re);
    const workIm = Float64Array.from(im);
    fftInPlace(workRe, workIm, false);
    fftInPlace(workRe, workIm, true);
    expect(maxDiff(workRe, re)).toBeLessThan(1e-13);
    expect(maxDiff(workIm, im)).toBeLessThan(1e-13);
  });

  it("rejects non-power-of-two and mismatched lengths", () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
    expect(() => fftInPlace(new Float64Array(8), new Float64Array(4))).toThrow(/mismatch/);
  });
});

describe("convolveCyclicFft", () => {
  it("matches the O(n²) cyclic sum, wrap included", () => {
    const n = 64;
    const a = randomArray(n, 21);
    const b = randomArray(n, 22);
    const want = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += a[j]! * b[(i - j + n) % n]!;
      want[i] = acc;
    }
    const got = convolveCyclicFft(a, b);
    expect(maxDiff(got, want)).toBeLessThan(1e-12 * maxAbs(want));
  });

  it("agrees with the linear convolution once padded past the wrap", () => {
    const na = 40, nb = 25;
    const a = randomArray(na, 31);
    const b = randomArray(nb, 32);
    const n = nextPowerOfTwo(na + nb - 1);
    const pa = new Float64Array(n); pa.set(a);
    const pb = new Float64Array(n); pb.set(b);
    const cyclic = convolveCyclicFft(pa, pb);
    const linear = convolveDirect(a, b);
    expect(maxDiff(cyclic.subarray(0, linear.length), linear)).toBeLessThan(1e-12 * maxAbs(linear));
    // Everything past the linear support must be (numerically) zero.
    let tail = 0;
    for (let i = linear.length; i < n; i++) tail = Math.max(tail, Math.abs(cyclic[i]!));
    expect(tail).toBeLessThan(1e-12 * maxAbs(linear));
  });

  it("rejects mismatched and non-power-of-two lengths", () => {
    expect(() => convolveCyclicFft(new Float64Array(8), new Float64Array(4))).toThrow(/mismatch/);
    expect(() => convolveCyclicFft(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });
});

describe("convolveFullFft", () => {
  it("reproduces the direct sum for a range of shapes", () => {
    // Includes lengths straddling a power of two in both operands, the
    // length-1 degenerate case, and the sparse/dense mix mpdf.ts feeds it.
    const shapes: [number, number][] = [[1, 1], [1, 32], [17, 5], [64, 64], [65, 63], [300, 801], [600, 3401]];
    for (const [na, nb] of shapes) {
      const a = randomArray(na, na * 31 + 1);
      const b = randomArray(nb, nb * 17 + 5);
      const want = convolveDirect(a, b);
      const got = convolveFullFft(a, b);
      expect(got.length).toBe(na + nb - 1);
      expect(maxDiff(got, want)).toBeLessThan(1e-12 * maxAbs(want));
    }
  });

  it("accepts plain arrays and returns an empty result for empty input", () => {
    expect([...convolveFullFft([1, 2, 3], [1, 1])]).toEqual([1, 3, 5, 3]);
    expect(convolveFullFft([], []).length).toBe(0);
  });

  it("is bit-identical across repeats and interleaved sizes", () => {
    // The pooled ≡ serial evaluator contract needs the convolution to depend on
    // nothing but its arguments — no scratch buffer, no order-sensitive memo.
    const a = randomArray(600, 11);
    const b = randomArray(3401, 12);
    const first = convolveFullFft(a, b);
    convolveFullFft(randomArray(37, 1), randomArray(4096, 2)); // dirty every cached table
    convolveFullFft(randomArray(2, 3), randomArray(9, 4));
    const second = convolveFullFft(a, b);
    expect([...second]).toEqual([...first]);
  });
});
