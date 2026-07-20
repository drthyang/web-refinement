/**
 * Convergence diagnostics and posterior summaries for the ensemble sampler.
 *
 * Split-R̂ (Gelman–Rubin) treats each walker as a chain and splits it in half —
 * ensemble walkers are not independent chains, so this is conservative but
 * standard practice for emcee-style samplers. ESS uses the mean-of-chains
 * autocorrelation with Geyer's initial-monotone-positive-sequence truncation.
 * The headline agent-facing number is esdRatio = posteriorStd / linearizedEsd:
 * ≈ 1 validates the least-squares error bars; ≫ 1 means the linearization was
 * overconfident (correlation, non-Gaussianity, or multimodality at work).
 *
 * References: Gelman et al., *Bayesian Data Analysis* 3e §11.4–11.5; Geyer,
 * Statist. Sci. 7 (1992) 473. The reporting surface (priors, seed, chain
 * length, R̂/ESS, credible intervals alongside point estimates) follows the
 * best-practice advice of McCluskey et al., J. Appl. Cryst. 56 (2023) 12,
 * doi:10.1107/S1600576722011426.
 */

export interface SampleDiagnostics {
  /** Split-R̂ per free parameter, order-aligned with freeIds. */
  readonly rHat: number[];
  /** Effective sample size per free parameter. */
  readonly ess: number[];
  readonly maxRHat: number;
  readonly minEss: number;
  /** Total kept (post-burn-in, thinned) draws across all walkers. */
  readonly nSamples: number;
}

export interface PosteriorParamSummary {
  readonly id: string;
  readonly mean: number;
  readonly median: number;
  readonly std: number;
  /** Quantiles of the marginal posterior. */
  readonly q025: number;
  readonly q16: number;
  readonly q84: number;
  readonly q975: number;
  readonly rHat: number;
  readonly ess: number;
  /** posteriorStd / linearizedEsd, when an LM esd was supplied. */
  readonly esdRatio?: number;
}

export interface PosteriorSummary {
  readonly parameters: PosteriorParamSummary[];
  /** Sample correlation matrix over the free parameters (row/col = freeIds). */
  readonly correlation: number[][];
}

/** Split-R̂ for one parameter given per-walker chains [nWalkers][n]. */
export function splitRHat(chains: readonly (readonly number[])[]): number {
  // Split each walker-chain in half → 2m chains of length n/2.
  const halves: number[][] = [];
  for (const c of chains) {
    const nHalf = Math.floor(c.length / 2);
    if (nHalf < 2) continue;
    halves.push(c.slice(0, nHalf), c.slice(c.length - nHalf));
  }
  const m = halves.length;
  if (m < 2) return Number.POSITIVE_INFINITY;
  const n = halves[0]!.length;

  const chainMeans = halves.map((c) => c.reduce((a, v) => a + v, 0) / n);
  const grand = chainMeans.reduce((a, v) => a + v, 0) / m;
  const B = (n / (m - 1)) * chainMeans.reduce((a, mu) => a + (mu - grand) ** 2, 0);
  const W =
    halves.reduce((acc, c, i) => {
      const mu = chainMeans[i]!;
      return acc + c.reduce((a, v) => a + (v - mu) ** 2, 0) / (n - 1);
    }, 0) / m;
  if (!(W > 0)) return B > 0 ? Number.POSITIVE_INFINITY : 1;
  const V = ((n - 1) / n) * W + B / n;
  return Math.sqrt(V / W);
}

/**
 * ESS for one parameter from per-walker chains: mean-of-chains autocovariance,
 * Geyer initial-monotone truncation of the paired sums Γ_k = ρ_{2k} + ρ_{2k+1}.
 * ESS = m·n / (1 + 2·Σρ_t).
 */
export function effectiveSampleSize(chains: readonly (readonly number[])[]): number {
  const m = chains.length;
  const n = chains[0]?.length ?? 0;
  if (m === 0 || n < 4) return 0;

  const means = chains.map((c) => c.reduce((a, v) => a + v, 0) / n);
  const vars = chains.map((c, i) => {
    const mu = means[i]!;
    return c.reduce((a, v) => a + (v - mu) ** 2, 0) / n;
  });
  const meanVar = vars.reduce((a, v) => a + v, 0) / m;
  if (!(meanVar > 0)) return 0;

  // Mean-of-chains normalized autocorrelation at lag t.
  const rho = (t: number): number => {
    let acc = 0;
    for (let i = 0; i < m; i++) {
      const c = chains[i]!;
      const mu = means[i]!;
      let s = 0;
      for (let k = 0; k + t < n; k++) s += (c[k]! - mu) * (c[k + t]! - mu);
      acc += s / n;
    }
    return acc / m / meanVar;
  };

  // Geyer: sum Γ_k = ρ_{2k} + ρ_{2k+1} while positive and non-increasing.
  let sum = 0;
  let prevGamma = Number.POSITIVE_INFINITY;
  for (let k = 0; 2 * k + 1 < n; k++) {
    let gamma = rho(2 * k) + rho(2 * k + 1);
    if (gamma <= 0) break;
    gamma = Math.min(gamma, prevGamma); // enforce monotone non-increasing
    prevGamma = gamma;
    sum += gamma;
    if (k > 200) break; // hard cap: beyond this the estimate is noise anyway
  }
  // Σ_{t≥1} ρ_t = (sum of Γ over pairs) − ρ_0/... : Γ sums include ρ_0 = 1 in the
  // k = 0 pair, so 1 + 2Σ_{t≥1}ρ_t = 2·ΣΓ − 1.
  const tau = Math.max(2 * sum - 1, 1);
  return (m * n) / tau;
}

export function buildDiagnostics(
  chains: readonly (readonly (readonly number[])[])[],
  _logProb: readonly (readonly number[])[],
  freeIds: readonly string[],
): SampleDiagnostics {
  const nFree = freeIds.length;
  const nWalkers = chains.length;
  const kept = chains[0]?.length ?? 0;
  const rHat: number[] = [];
  const ess: number[] = [];
  for (let j = 0; j < nFree; j++) {
    const perWalker = Array.from({ length: nWalkers }, (_, w) => chains[w]!.map((row) => row[j]!));
    rHat.push(splitRHat(perWalker));
    ess.push(effectiveSampleSize(perWalker));
  }
  return {
    rHat,
    ess,
    maxRHat: rHat.length ? Math.max(...rHat) : Number.POSITIVE_INFINITY,
    minEss: ess.length ? Math.min(...ess) : 0,
    nSamples: nWalkers * kept,
  };
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function posteriorSummary(
  chains: readonly (readonly (readonly number[])[])[],
  freeIds: readonly string[],
  diagnostics: SampleDiagnostics,
  linearizedEsd?: Readonly<Record<string, number>>,
): PosteriorSummary {
  const nFree = freeIds.length;
  // Flatten all walkers' kept draws per parameter.
  const flat: number[][] = Array.from({ length: nFree }, () => []);
  for (const walker of chains) {
    for (const row of walker) {
      for (let j = 0; j < nFree; j++) flat[j]!.push(row[j]!);
    }
  }

  const means = flat.map((v) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN));
  const stds = flat.map((v, j) => {
    if (v.length < 2) return NaN;
    const mu = means[j]!;
    return Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / (v.length - 1));
  });

  const parameters: PosteriorParamSummary[] = freeIds.map((id, j) => {
    const sorted = [...flat[j]!].sort((a, b) => a - b);
    const esd = linearizedEsd?.[id];
    const base: PosteriorParamSummary = {
      id,
      mean: means[j]!,
      median: quantile(sorted, 0.5),
      std: stds[j]!,
      q025: quantile(sorted, 0.025),
      q16: quantile(sorted, 0.16),
      q84: quantile(sorted, 0.84),
      q975: quantile(sorted, 0.975),
      rHat: diagnostics.rHat[j]!,
      ess: diagnostics.ess[j]!,
    };
    return esd !== undefined && esd > 0 && Number.isFinite(stds[j]!)
      ? { ...base, esdRatio: stds[j]! / esd }
      : base;
  });

  // Sample correlation matrix.
  const correlation: number[][] = Array.from({ length: nFree }, () => new Array<number>(nFree).fill(0));
  const nDraws = flat[0]?.length ?? 0;
  for (let i = 0; i < nFree; i++) {
    correlation[i]![i] = 1;
    for (let j = i + 1; j < nFree; j++) {
      let cov = 0;
      for (let k = 0; k < nDraws; k++) cov += (flat[i]![k]! - means[i]!) * (flat[j]![k]! - means[j]!);
      cov /= Math.max(nDraws - 1, 1);
      const denom = stds[i]! * stds[j]!;
      const c = denom > 0 ? cov / denom : 0;
      correlation[i]![j] = c;
      correlation[j]![i] = c;
    }
  }

  return { parameters, correlation };
}
