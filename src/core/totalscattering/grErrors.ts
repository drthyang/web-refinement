/**
 * Statistical uncertainty of a reduced G(r) propagated from S(Q) errors.
 *
 * The sine Fourier transform G(r) = (2/π)∫Q[S(Q)−1]sin(Qr)dQ is linear in
 * S(Q), so with independent per-point uncertainties σ_S(Q) on a uniform grid
 * (spacing ΔQ) the variance propagates in closed form:
 *
 *   σ_G(r)² = (2ΔQ/π)² Σ_Q Q² sin²(Qr) σ_S(Q)²
 *
 * This is the pointwise STATISTICAL error only — neighbouring G(r) points
 * remain strongly correlated (the transform mixes every Q into every r), so
 * these σ are honest for weighting a residual but NOT for treating points as
 * independent; interval estimates should carry a marginalized error scale on
 * top (see refinement/bayes/logPosterior.ts).
 */

/** σ_G on each `r` from S(Q) uncertainties on a uniform Q grid. */
export function propagateGrSigma(
  q: ArrayLike<number>,
  sigmaS: ArrayLike<number>,
  r: ArrayLike<number>,
): Float64Array {
  const nq = q.length;
  const out = new Float64Array(r.length);
  if (nq < 2) return out;
  const dq = q[1]! - q[0]!;
  const pref = (2 * dq) / Math.PI;
  // Precompute Q²σ² once; the r loop is then a plain weighted sin² sum.
  const w = new Float64Array(nq);
  for (let j = 0; j < nq; j++) w[j] = q[j]! * q[j]! * sigmaS[j]! * sigmaS[j]!;
  for (let i = 0; i < r.length; i++) {
    const ri = r[i]!;
    let acc = 0;
    for (let j = 0; j < nq; j++) {
      const s = Math.sin(q[j]! * ri);
      acc += w[j]! * s * s;
    }
    out[i] = pref * Math.sqrt(acc);
  }
  return out;
}

/** Parse a Mantid-style `# X Y E` three-column S(Q) text file. */
export function parseSqWithErrors(text: string): { q: number[]; s: number[]; sigma: number[] } {
  const q: number[] = [];
  const s: number[] = [];
  const sigma: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const t = line.split(/\s+/).map(Number);
    if (t.length >= 3 && t.every(Number.isFinite)) {
      q.push(t[0]!);
      s.push(t[1]!);
      sigma.push(t[2]!);
    }
  }
  return { q, s, sigma };
}
