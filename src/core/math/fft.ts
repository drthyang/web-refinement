/**
 * Radix-2 FFT and the linear (full) convolution built on it — the fast path for
 * the real-space kernels the PDF/mPDF forward models convolve on every
 * evaluation (Gaussian peak broadening, the magnetic form-factor envelope).
 *
 * Split real/imaginary `Float64Array`s rather than the object `Complex` of
 * `math/complex.ts`: these run in the innermost loop of a refinement, so the
 * allocation per element that an object form implies is not affordable.
 *
 * **Determinism.** Every routine here is a pure function of its inputs: the
 * twiddle table is memoized per transform length but is itself only a function
 * of that length, and no scratch state survives a call. Identical inputs give
 * bit-identical outputs regardless of call order or which worker thread runs
 * them — the pooled ≡ serial evaluator contract depends on this.
 *
 * **Accuracy.** FFT convolution is not bit-identical to the direct sum: its
 * error is ~ε·√(log₂N)·‖a‖·‖b‖ rather than ε·Σ|aᵢbⱼ| pointwise, and exact zeros
 * come back as ~1e-16 noise. At the sizes used here (N ≤ 2¹⁴) that is ~1e-13
 * relative — far inside the golden-fixture gates — but it is why
 * {@link convolveFull} keeps the direct sum where the direct sum is also faster.
 */

/** Smallest power of two ≥ `n` (1 for n ≤ 1). */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

interface Twiddles {
  readonly cos: Float64Array;
  readonly sin: Float64Array;
}

/** exp(−2πik/n) for k < n/2, memoized per length (≈30 entries ever, since n is
 *  a power of two). Pure in `n`, so memoizing cannot make a result order-dependent. */
const TWIDDLE_CACHE = new Map<number, Twiddles>();

function twiddles(n: number): Twiddles {
  const cached = TWIDDLE_CACHE.get(n);
  if (cached) return cached;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  const table: Twiddles = { cos, sin };
  TWIDDLE_CACHE.set(n, table);
  return table;
}

/**
 * In-place iterative Cooley–Tukey FFT of the complex sequence (`re`, `im`).
 * Length must be a power of two. `inverse` conjugates the twiddles and divides
 * by n, so `fftInPlace(x, true)` after `fftInPlace(x, false)` is the identity up
 * to rounding.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (im.length !== n) throw new Error(`fftInPlace: re/im length mismatch (${n} vs ${im.length})`);
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftInPlace: length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }

  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let base = 0; base < n; base += len) {
      for (let k = 0; k < half; k++) {
        const t = k * stride;
        const wr = cos[t]!;
        const wi = inverse ? -sin[t]! : sin[t]!;
        const a = base + k;
        const b = a + half;
        const br = re[b]!;
        const bi = im[b]!;
        const xr = br * wr - bi * wi;
        const xi = br * wi + bi * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! * invN;
      im[i] = im[i]! * invN;
    }
  }
}

/**
 * Cyclic convolution of two real sequences already zero-padded to the same
 * power-of-two length: `c[i] = Σ_j a[j]·b[(i − j) mod n]`.
 *
 * Two real sequences ride in one complex transform — pack z = a + i·b, so that
 * A_k = (Z_k + conj(Z_{−k}))/2 and B_k = −i(Z_k − conj(Z_{−k}))/2 by the
 * Hermitian symmetry of a real signal's spectrum. Total cost: two length-n
 * transforms, not three.
 *
 * **The padding is the caller's problem.** This wraps by construction; it is
 * the caller who must choose n large enough that the wrap lands only on zeros
 * (see {@link convolveFullFft} for the linear case, and `pdf/termination` for a
 * symmetric-kernel case where n ≥ 2·len − 1 is the condition).
 */
export function convolveCyclicFft(a: Float64Array, b: Float64Array): Float64Array {
  const n = a.length;
  if (b.length !== n) throw new Error(`convolveCyclicFft: length mismatch (${n} vs ${b.length})`);
  if (n === 0) return new Float64Array(0);
  if ((n & (n - 1)) !== 0) throw new Error(`convolveCyclicFft: length must be a power of two, got ${n}`);

  const re = Float64Array.from(a);
  const im = Float64Array.from(b);
  fftInPlace(re, im, false);

  // Unpack the two spectra and multiply. Reading index k and its mirror −k in
  // the same pass forbids writing back in place, so the product lands in fresh
  // arrays (which are the inverse transform's buffers anyway).
  const cre = new Float64Array(n);
  const cim = new Float64Array(n);
  const mask = n - 1;
  for (let k = 0; k < n; k++) {
    const m = (n - k) & mask;
    const rk = re[k]!, ik = im[k]!, rm = re[m]!, imv = im[m]!;
    const ar = 0.5 * (rk + rm);
    const ai = 0.5 * (ik - imv);
    const br = 0.5 * (ik + imv);
    const bi = -0.5 * (rk - rm);
    cre[k] = ar * br - ai * bi;
    cim[k] = ar * bi + ai * br;
  }
  fftInPlace(cre, cim, true);
  return cre;
}

/**
 * Linear convolution of two real sequences (numpy `convolve(a, b, 'full')`),
 * length `a.length + b.length − 1`, via FFT — the cyclic transform padded to
 * the point where nothing wraps.
 */
export function convolveFullFft(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const nOut = a.length + b.length - 1;
  if (nOut < 1) return new Float64Array(0);
  const n = nextPowerOfTwo(nOut);
  const pa = new Float64Array(n);
  const pb = new Float64Array(n);
  pa.set(a as ArrayLike<number>);
  pb.set(b as ArrayLike<number>);
  return convolveCyclicFft(pa, pb).subarray(0, nOut).slice();
}
