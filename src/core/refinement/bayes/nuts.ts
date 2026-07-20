/**
 * No-U-Turn Sampler (NUTS) — gradient-based posterior sampling over a
 * RefinementProblem whose workflow supplies a scalar χ² gradient (`gradChi2`,
 * today the PDF track's fused analytic pass with FD fill-in).
 *
 * Where the ensemble sampler (sampler.ts) needs only likelihood evaluations,
 * NUTS follows the local geometry: each draw simulates Hamiltonian dynamics in
 * the UNBOUNDED (logit-transformed) space and doubles a trajectory until it
 * U-turns, giving far longer effective moves per evaluation on correlated
 * posteriors. The price is sequential gradient evaluations (no walker batch to
 * fan over the pool), so NUTS runs in-process — the node/MCP path first.
 *
 * Crystallographic shortcut: when linearized LM esds are supplied, the diagonal
 * mass matrix is seeded from them (transformed to q-space), so the kinetic
 * metric already matches the posterior's per-parameter scales and warmup only
 * has to tune the step size (dual averaging, target acceptance 0.8).
 *
 * References: Hoffman & Gelman (2014), JMLR 15, 1593 (NUTS, Algorithms 3/6 —
 * the slice variant implemented here, with dual averaging); Neal (2011),
 * "MCMC using Hamiltonian dynamics," Handbook of MCMC Ch. 5 (leapfrog, mass
 * matrices); Betancourt (2017), arXiv:1701.02434 (divergence diagnostics).
 * Crystallographic precedent for Bayesian full-profile refinement: Fancher et
 * al., Sci. Rep. 6 (2016) 31625.
 */

import type { RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import {
  logLikelihood,
  logPrior,
  nUsedOf,
  type NoiseModel,
  type PriorSpec,
} from "@/core/refinement/bayes/logPosterior";
import {
  dLogJacobianDq,
  dxdq,
  logJacobian,
  planTransforms,
  toBounded,
  toUnbounded,
  type TransformSpec,
} from "@/core/refinement/bayes/transform";
import {
  buildDiagnostics,
  posteriorSummary,
  type PosteriorSummary,
  type SampleDiagnostics,
} from "@/core/refinement/bayes/diagnostics";

/** The scalar-gradient contract (PdfRefinementProblem.gradChi2). */
export type GradChi2 = (
  freeParams: readonly RefinementParameter[],
  freeValues: readonly number[],
) => { chi2: number; grad: Float64Array };

/** Serializable per-chain NUTS state — the resume token. */
export interface NutsChainState {
  /** Position in UNBOUNDED space. */
  readonly q: number[];
  readonly rngDraws: number;
  readonly seed: number;
}

export interface NutsState {
  readonly chains: NutsChainState[];
  /** Post-warmup step size per chain (dual-averaged). */
  readonly stepSize: number[];
  /** Diagonal inverse mass (shared across chains). */
  readonly massInv: number[];
  readonly stepIndex: number;
  readonly freeIds: string[];
}

export interface NutsOptions {
  /** Post-warmup draws to collect THIS call (per chain). */
  readonly nSteps: number;
  /** Independent chains (sequential). Default 4. */
  readonly nChains?: number;
  /** Warmup (dual-averaging) iterations per chain on a fresh start. Default 100. */
  readonly nWarmup?: number;
  readonly seed?: number;
  readonly noiseModel?: NoiseModel;
  readonly priors?: Readonly<Record<string, PriorSpec>>;
  /** Linearized LM esds by parameter id — seeds the diagonal mass matrix. */
  readonly linearizedEsd?: Readonly<Record<string, number>>;
  /** Dual-averaging target acceptance. Default 0.8. */
  readonly targetAccept?: number;
  /** Maximum tree depth. Default 10. */
  readonly maxTreeDepth?: number;
  /** Resume token from a previous run (skips warmup). */
  readonly init?: NutsState;
  readonly onStep?: (step: number, meanLogP: number) => void;
}

export interface NutsResult {
  /** Kept draws in ORIGINAL bounded space, [nChains][nSteps][nFree]. */
  readonly chains: number[][][];
  readonly logProb: number[][];
  readonly freeIds: string[];
  /** Mean Metropolis acceptance statistic (dual-averaging α̅). */
  readonly acceptanceFraction: number;
  readonly diagnostics: SampleDiagnostics;
  readonly posterior: PosteriorSummary;
  readonly resume: NutsState;
  readonly status: "ok" | "not-converged";
  readonly message?: string;
  /** NUTS-specific health: divergent transitions must be ~0 to trust tails. */
  readonly nuts: {
    readonly divergences: number;
    readonly maxTreeDepthHits: number;
    readonly gradEvals: number;
    readonly stepSize: number[];
  };
}

const DELTA_MAX = 1000; // divergence threshold on the log-joint drop
const DEFAULT_SEED = 0x5eed5;

/** Counter-resumable mulberry32 (same construction as sampler.ts). */
function rngFrom(seed: number, skip: number): { next: () => number; count: () => number } {
  let s = seed >>> 0;
  let n = 0;
  const raw = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    n++;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < skip; i++) raw();
  return { next: raw, count: () => n };
}

/** Standard normal via Box–Muller (two uniform draws per call — deterministic). */
function gauss(rng: { next: () => number }): number {
  const u1 = Math.max(rng.next(), 1e-300);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

interface Target {
  readonly freeParams: RefinementParameter[];
  readonly freeIds: string[];
  readonly transforms: TransformSpec[];
  /** logPost(q) and ∇_q logPost(q) — one gradChi2 evaluation each. */
  readonly evaluate: (q: readonly number[]) => { logP: number; grad: Float64Array };
  readonly evalCount: () => number;
}

function buildTarget(
  problem: RefinementProblem,
  gradChi2: GradChi2,
  options: NutsOptions,
): Target {
  const freeParams = problem.parameters.filter((p) => !p.fixed);
  if (freeParams.length === 0) throw new Error("sampleNuts: no free parameters to sample");
  const freeIds = freeParams.map((p) => p.id);
  const transforms = planTransforms(freeParams);
  const nUsed = nUsedOf(problem.weights);
  const noiseModel = options.noiseModel ?? "marginalized";
  const priors = options.priors;
  let evals = 0;

  const evaluate = (q: readonly number[]): { logP: number; grad: Float64Array } => {
    const n = q.length;
    const x = new Array<number>(n);
    for (let j = 0; j < n; j++) x[j] = toBounded(q[j]!, transforms[j]!);
    const { chi2, grad: gradX } = gradChi2(freeParams, x);
    evals++;

    let logP = logLikelihood(chi2, nUsed, noiseModel);
    const grad = new Float64Array(n);
    if (!Number.isFinite(logP)) {
      return { logP: Number.NEGATIVE_INFINITY, grad };
    }
    logP += logPrior(freeParams, x, priors);
    // dlogL/dχ²: marginalized −(N/2)/χ², fixed −1/2.
    const dLdChi2 = noiseModel === "marginalized" ? -(nUsed / 2) / chi2 : -0.5;
    for (let j = 0; j < n; j++) {
      const t = transforms[j]!;
      logP += logJacobian(q[j]!, t);
      let dPriorDx = 0;
      const spec = priors?.[freeIds[j]!];
      if (spec && spec.kind === "normal" && spec.sigma !== undefined && spec.sigma > 0) {
        dPriorDx = -(x[j]! - (spec.mu ?? 0)) / (spec.sigma * spec.sigma);
      }
      grad[j] = (dLdChi2 * gradX[j]! + dPriorDx) * dxdq(q[j]!, t) + dLogJacobianDq(q[j]!, t);
    }
    let finite = Number.isFinite(logP);
    for (let j = 0; finite && j < n; j++) finite = Number.isFinite(grad[j]!);
    if (!finite) return { logP: Number.NEGATIVE_INFINITY, grad: new Float64Array(n) };
    return { logP, grad };
  };

  return { freeParams, freeIds, transforms, evaluate, evalCount: () => evals };
}

interface PhasePoint {
  q: number[];
  p: number[];
  grad: Float64Array;
  logP: number;
}

/** One leapfrog step (diagonal inverse mass), ONE new gradient evaluation. */
function leapfrog(
  point: PhasePoint,
  direction: 1 | -1,
  eps: number,
  massInv: readonly number[],
  target: Target,
): PhasePoint {
  const h = direction * eps;
  const n = point.q.length;
  const p = point.p.slice();
  const q = point.q.slice();
  for (let j = 0; j < n; j++) p[j] = p[j]! + 0.5 * h * point.grad[j]!;
  for (let j = 0; j < n; j++) q[j] = q[j]! + h * massInv[j]! * p[j]!;
  const { logP, grad } = target.evaluate(q);
  for (let j = 0; j < n; j++) p[j] = p[j]! + 0.5 * h * grad[j]!;
  return { q, p, grad, logP };
}

function kinetic(p: readonly number[], massInv: readonly number[]): number {
  let k = 0;
  for (let j = 0; j < p.length; j++) k += 0.5 * massInv[j]! * p[j]! * p[j]!;
  return k;
}

/** U-turn criterion across a subtree span (M⁻¹-metric momenta). */
function noUTurn(
  qMinus: readonly number[],
  qPlus: readonly number[],
  pMinus: readonly number[],
  pPlus: readonly number[],
  massInv: readonly number[],
): boolean {
  let dotMinus = 0;
  let dotPlus = 0;
  for (let j = 0; j < qMinus.length; j++) {
    const dq = qPlus[j]! - qMinus[j]!;
    dotMinus += dq * massInv[j]! * pMinus[j]!;
    dotPlus += dq * massInv[j]! * pPlus[j]!;
  }
  return dotMinus >= 0 && dotPlus >= 0;
}

interface Tree {
  minus: PhasePoint;
  plus: PhasePoint;
  /** Candidate draw from this subtree (slice-uniform). */
  candidate: PhasePoint;
  /** Number of slice-admissible states in the subtree. */
  n: number;
  /** Subtree still valid (no U-turn, no divergence). */
  s: boolean;
  alpha: number;
  nAlpha: number;
  diverged: boolean;
}

/** Recursive tree doubling (Hoffman & Gelman Alg. 6 BuildTree). */
function buildTree(
  point: PhasePoint,
  logU: number,
  direction: 1 | -1,
  depth: number,
  eps: number,
  logJoint0: number,
  massInv: readonly number[],
  target: Target,
  rng: { next: () => number },
): Tree {
  if (depth === 0) {
    const leaf = leapfrog(point, direction, eps, massInv, target);
    const logJoint = leaf.logP - kinetic(leaf.p, massInv);
    const diverged = !(logU < DELTA_MAX + logJoint);
    return {
      minus: leaf,
      plus: leaf,
      candidate: leaf,
      n: logU <= logJoint ? 1 : 0,
      s: !diverged,
      alpha: Math.min(1, Math.exp(logJoint - logJoint0)),
      nAlpha: 1,
      diverged,
    };
  }
  const first = buildTree(point, logU, direction, depth - 1, eps, logJoint0, massInv, target, rng);
  if (!first.s) return first;
  const from = direction === 1 ? first.plus : first.minus;
  const second = buildTree(from, logU, direction, depth - 1, eps, logJoint0, massInv, target, rng);
  const minus = direction === 1 ? first.minus : second.minus;
  const plus = direction === 1 ? second.plus : first.plus;
  const total = first.n + second.n;
  // Progressive slice sampling: pick the second subtree's candidate w.p. n″/(n′+n″).
  const candidate =
    total > 0 && rng.next() < second.n / total ? second.candidate : first.candidate;
  return {
    minus,
    plus,
    candidate,
    n: total,
    s: second.s && noUTurn(minus.q, plus.q, minus.p, plus.p, massInv),
    alpha: first.alpha + second.alpha,
    nAlpha: first.nAlpha + second.nAlpha,
    diverged: first.diverged || second.diverged,
  };
}

/** One NUTS transition. Returns the next point + per-iteration statistics. */
function nutsStep(
  current: PhasePoint,
  eps: number,
  maxDepth: number,
  massInv: readonly number[],
  target: Target,
  rng: { next: () => number },
): { point: PhasePoint; alpha: number; nAlpha: number; diverged: boolean; depthHit: boolean } {
  const n = current.q.length;
  // Momentum draw p ~ N(0, M): p_j = z / sqrt(massInv_j).
  const p = new Array<number>(n);
  for (let j = 0; j < n; j++) p[j] = gauss(rng) / Math.sqrt(massInv[j]!);
  const start: PhasePoint = { q: current.q, p, grad: current.grad, logP: current.logP };
  const logJoint0 = start.logP - kinetic(p, massInv);
  // Slice variable: log u = logJoint0 + log(uniform).
  const logU = logJoint0 + Math.log(Math.max(rng.next(), 1e-300));

  let minus = start;
  let plus = start;
  let candidate = start;
  let nTotal = 1;
  let s = true;
  let alpha = 0;
  let nAlpha = 0;
  let diverged = false;
  let depth = 0;

  while (s && depth < maxDepth) {
    const direction: 1 | -1 = rng.next() < 0.5 ? -1 : 1;
    const tree = buildTree(
      direction === 1 ? plus : minus,
      logU,
      direction,
      depth,
      eps,
      logJoint0,
      massInv,
      target,
      rng,
    );
    if (direction === 1) plus = tree.plus;
    else minus = tree.minus;
    alpha += tree.alpha;
    nAlpha += tree.nAlpha;
    diverged = diverged || tree.diverged;
    if (tree.s && tree.n > 0 && rng.next() < tree.n / nTotal) {
      candidate = tree.candidate;
    }
    nTotal += tree.n;
    s = tree.s && noUTurn(minus.q, plus.q, minus.p, plus.p, massInv);
    depth++;
  }

  return {
    point: { q: candidate.q, p: candidate.p, grad: candidate.grad, logP: candidate.logP },
    alpha,
    nAlpha,
    diverged,
    depthHit: depth >= maxDepth,
  };
}

/** Heuristic initial step size (Hoffman & Gelman Alg. 4). */
function findInitialStepSize(
  start: PhasePoint,
  massInv: readonly number[],
  target: Target,
  rng: { next: () => number },
): number {
  const n = start.q.length;
  let eps = 0.1;
  const p = new Array<number>(n);
  for (let j = 0; j < n; j++) p[j] = gauss(rng) / Math.sqrt(massInv[j]!);
  const point: PhasePoint = { q: start.q, p, grad: start.grad, logP: start.logP };
  const logJoint0 = point.logP - kinetic(p, massInv);
  const probe = leapfrog(point, 1, eps, massInv, target);
  let logRatio = probe.logP - kinetic(probe.p, massInv) - logJoint0;
  const a = logRatio > Math.log(0.5) ? 1 : -1;
  for (let i = 0; i < 50; i++) {
    if (!(a * logRatio > -a * Math.log(2))) break;
    eps *= a === 1 ? 2 : 0.5;
    const next = leapfrog(point, 1, eps, massInv, target);
    logRatio = next.logP - kinetic(next.p, massInv) - logJoint0;
    if (!Number.isFinite(logRatio)) {
      eps *= 0.5;
      break;
    }
  }
  return eps;
}

/**
 * Run NUTS: fresh start = warmup (dual averaging) + draws; resume = draws only
 * with the token's step sizes/mass. Chains run sequentially in-process.
 */
export function sampleNuts(
  problem: RefinementProblem,
  gradChi2: GradChi2,
  options: NutsOptions,
): NutsResult {
  const target = buildTarget(problem, gradChi2, options);
  const { freeParams, freeIds, transforms } = target;
  const n = freeParams.length;
  const maxDepth = options.maxTreeDepth ?? 10;
  const targetAccept = options.targetAccept ?? 0.8;

  // --- Mass matrix: from linearized esds when available (q-space), else unit.
  let massInv: number[];
  let stepSizes: number[];
  let chainStates: NutsChainState[];
  let stepIndex: number;
  const resuming = options.init !== undefined;

  if (resuming) {
    const init = options.init!;
    if (init.freeIds.length !== n || init.freeIds.some((id, j) => id !== freeIds[j])) {
      throw new Error("sampleNuts: resume token's free parameters do not match the problem");
    }
    massInv = [...init.massInv];
    stepSizes = [...init.stepSize];
    chainStates = init.chains.map((c) => ({ ...c, q: [...c.q] }));
    stepIndex = init.stepIndex;
  } else {
    const q0 = freeParams.map((p, j) => toUnbounded(p.value, transforms[j]!));
    massInv = freeParams.map((p, j) => {
      const esd = options.linearizedEsd?.[p.id];
      if (esd === undefined || !(esd > 0)) return 1;
      const slope = Math.abs(dxdq(q0[j]!, transforms[j]!));
      const esdQ = slope > 0 ? esd / slope : esd;
      // massInv ≈ posterior variance in q — clamp away from degenerate scales.
      return Math.min(Math.max(esdQ * esdQ, 1e-12), 1e12);
    });
    const nChains = Math.max(1, options.nChains ?? 4);
    const baseSeed = (options.seed ?? DEFAULT_SEED) >>> 0;
    chainStates = Array.from({ length: nChains }, (_, c) => ({
      q: [...q0],
      rngDraws: 0,
      seed: (baseSeed + 1000003 * c) >>> 0,
    }));
    stepSizes = new Array<number>(nChains).fill(0);
    stepIndex = 0;
  }

  const keptChains: number[][][] = chainStates.map(() => []);
  const keptLogP: number[][] = chainStates.map(() => []);
  let divergences = 0;
  let depthHits = 0;
  let alphaSum = 0;
  let nAlphaSum = 0;

  for (let c = 0; c < chainStates.length; c++) {
    const chain = chainStates[c]!;
    const rng = rngFrom(chain.seed, chain.rngDraws);
    let point: PhasePoint;
    {
      const { logP, grad } = target.evaluate(chain.q);
      if (!Number.isFinite(logP)) {
        throw new Error("sampleNuts: starting point has non-finite log-posterior");
      }
      point = { q: [...chain.q], p: new Array<number>(n).fill(0), grad, logP };
    }

    let eps = stepSizes[c]!;
    if (!resuming) {
      // --- Warmup: initial ε heuristic + dual averaging toward targetAccept.
      eps = findInitialStepSize(point, massInv, target, rng);
      const mu = Math.log(10 * eps);
      const gamma = 0.05;
      const t0 = 10;
      const kappa = 0.75;
      let hBar = 0;
      let logEpsBar = 0;
      const nWarmup = Math.max(10, options.nWarmup ?? 100);
      for (let m = 1; m <= nWarmup; m++) {
        const step = nutsStep(point, eps, maxDepth, massInv, target, rng);
        point = step.point;
        const accept = step.nAlpha > 0 ? step.alpha / step.nAlpha : 0;
        hBar = (1 - 1 / (m + t0)) * hBar + (1 / (m + t0)) * (targetAccept - accept);
        const logEps = mu - (Math.sqrt(m) / gamma) * hBar;
        eps = Math.exp(logEps);
        const w = Math.pow(m, -kappa);
        logEpsBar = w * logEps + (1 - w) * logEpsBar;
      }
      eps = Math.exp(logEpsBar);
      stepSizes[c] = eps;
    }

    // --- Sampling.
    for (let m = 0; m < options.nSteps; m++) {
      const step = nutsStep(point, eps, maxDepth, massInv, target, rng);
      point = step.point;
      if (step.diverged) divergences++;
      if (step.depthHit) depthHits++;
      alphaSum += step.alpha;
      nAlphaSum += step.nAlpha;
      keptChains[c]!.push(point.q.map((qj, j) => toBounded(qj, transforms[j]!)));
      keptLogP[c]!.push(point.logP);
      options.onStep?.(stepIndex + m + 1, point.logP);
    }

    chainStates[c] = { q: [...point.q], rngDraws: rng.count(), seed: chain.seed };
  }
  stepIndex += options.nSteps;

  const diagnostics = buildDiagnostics(keptChains, keptLogP, freeIds);
  const posterior = posteriorSummary(keptChains, freeIds, diagnostics, options.linearizedEsd);
  const converged =
    diagnostics.maxRHat < 1.05 &&
    diagnostics.minEss >= Math.max(100, 10 * n) &&
    divergences === 0;

  return {
    chains: keptChains,
    logProb: keptLogP,
    freeIds: [...freeIds],
    acceptanceFraction: nAlphaSum > 0 ? alphaSum / nAlphaSum : 0,
    diagnostics,
    posterior,
    resume: { chains: chainStates, stepSize: stepSizes, massInv, stepIndex, freeIds: [...freeIds] },
    status: converged ? "ok" : "not-converged",
    message: converged
      ? `converged: R̂max ${diagnostics.maxRHat.toFixed(3)}, ESSmin ${Math.round(diagnostics.minEss)}, 0 divergences`
      : `not converged: R̂max ${diagnostics.maxRHat.toFixed(3)}, ESSmin ${Math.round(diagnostics.minEss)}, ${divergences} divergence(s) — continue via the resume token`,
    nuts: {
      divergences,
      maxTreeDepthHits: depthHits,
      gradEvals: target.evalCount(),
      stepSize: [...stepSizes],
    },
  };
}
