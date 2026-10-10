/**
 * Le Bail intensity extraction: partition an observed powder pattern into
 * per-reflection integrated intensities using only the cell + space group (no
 * structural model). Used for indexing checks, space-group testing, and as
 * input to structure solution — a standard capability in GSAS-II / Jana /
 * FullProf.
 *
 * Iteration (Le Bail 1988): with a current set of intensities I_k, the observed
 * intensity assigned to reflection k is
 *   I_k^obs = Σ_i [ I_k · Ω(i,k) / (y_i^calc − b_i) ] · (y_i^obs − b_i),
 * where Ω(i,k) is reflection k's (area-normalized) profile at point i and b_i
 * the background. Repeating this converges to a self-consistent partition of
 * the pattern; an isolated peak gets its whole net area in one cycle. (Dividing
 * by the gross y_i^calc instead grew each intensity only by the peak-to-
 * background ratio per cycle, so weak reflections never reached their size.)
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { braggTheta } from "@/core/crystal/unitCell";
import { gaussian, pseudoVoigt, supportTaper, tofBackToBack, type PeakShape, type TofShape } from "@/core/diffraction/profile";

export interface LeBailReflection {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly center: number;
  readonly intensity: number;
}

/** TOF diffractometer constants (GSAS-II µs): TOF = Zero + difC·d + difA·d² + difB/d. */
export interface TofCalibration {
  readonly difC: number;
  readonly difA: number;
  readonly difB: number;
  readonly zero: number;
}

/**
 * Back-to-back-exponential TOF peak coefficients (GSAS-II form, µs): rising
 * edge α = alpha/d, falling edge β = beta0 + beta1/d⁴ + betaQ/d², Gaussian
 * variance σ² = sig0 + sig1·d² + sig2·d⁴ + sigQ·d. The widths grow with d, as
 * real TOF resolution does.
 */
export interface LeBailTofProfile {
  readonly alpha: number;
  readonly beta0: number;
  readonly beta1?: number;
  readonly betaQ?: number;
  readonly sig0?: number;
  readonly sig1: number;
  readonly sig2?: number;
  readonly sigQ?: number;
}

/** Another phase whose reflections share the pattern (an impurity). */
export interface LeBailPhase {
  readonly cell: UnitCell;
  readonly spaceGroup: SpaceGroup;
  /** Its own peak broadening: the Gaussian σ (TOF) or the FWHM (constant
   *  wavelength) times this factor. Default 1. */
  readonly widthScale?: number;
}

export interface LeBailOptions {
  /** The FWHM; on a 2θ pattern with `fwhmU`, the FWHM at the pattern's middle angle. */
  readonly fwhm: number;
  /**
   * Constant wavelength, 2θ axis: how the width grows with angle, Caglioti's U
   * term (deg²): FWHM² = fwhm² + U·(tan²θ − tan²θ_mid). One width cannot span a
   * wide 2θ range — high-angle peaks are several times broader, and their
   * flanks then read as unindexed peaks. Default 0 (one width).
   */
  readonly fwhmU?: number;
  readonly shape?: PeakShape;
  readonly eta?: number;
  readonly cycles?: number;
  /** Flat, or one value per pattern point. */
  readonly background?: number | readonly number[];
  /** Required for a TOF (`xUnit === "tof"`) pattern: without it a reflection's
   *  d-spacing cannot be mapped to a time-of-flight position. */
  readonly tof?: TofCalibration;
  /** With `shape: "tof"` on a TOF pattern: each reflection gets the
   *  back-to-back-exponential peak these coefficients give at its d, in place
   *  of the single `fwhm`. */
  readonly tofProfile?: LeBailTofProfile;
  /** Impurity phases, extracted together with the main one. */
  readonly extraPhases?: readonly LeBailPhase[];
}

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

/**
 * The constant-wavelength FWHM at position x: `fwhm` at the middle angle,
 * grown (or shrunk) by `u` as FWHM² = fwhm² + u·(tan²θ − tan²θ_mid), never
 * below a fifth of `fwhm`. One width everywhere off a 2θ axis, or when u is 0.
 */
export function cwWidth(pattern: PowderPattern, fwhm: number, u: number): (x: number) => number {
  if (u === 0 || pattern.xUnit !== "twoTheta" || pattern.points.length === 0) return () => fwhm;
  const xs = pattern.points.map((p) => p.x).sort((a, b) => a - b);
  const tan2 = (x: number): number => Math.tan((x * Math.PI) / 360) ** 2;
  const mid = tan2(xs[xs.length >> 1]!);
  const floor = (0.2 * fwhm) ** 2;
  return (x) => Math.sqrt(Math.max(fwhm * fwhm + u * (tan2(x) - mid), floor));
}

/** The back-to-back-exponential coefficients at d. */
export function tofShapeAt(d: number, p: LeBailTofProfile): TofShape {
  const alpha = Math.max(p.alpha / d, 1e-9);
  const beta = Math.max(p.beta0 + (p.beta1 ?? 0) / (d * d * d * d) + (p.betaQ ?? 0) / (d * d), 1e-9);
  const sig2 = Math.max((p.sig0 ?? 0) + p.sig1 * d * d + (p.sig2 ?? 0) * d * d * d * d + (p.sigQ ?? 0) * d, 1e-6);
  return { alpha, beta, sigma: Math.sqrt(sig2) };
}

/** A TOF peak's full width at half maximum (µs), near enough for windows: the
 *  Gaussian FWHM plus each exponential edge's half-height length. */
export function tofFwhmAt(d: number, p: LeBailTofProfile): number {
  const s = tofShapeAt(d, p);
  return FWHM_PER_SIGMA * s.sigma + Math.LN2 / s.alpha + Math.LN2 / s.beta;
}

/** Position of a d-spacing on the pattern's own axis (NaN when it cannot be placed). */
export function dToX(pattern: PowderPattern, d: number, tof?: TofCalibration): number {
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : undefined);
  switch (pattern.xUnit) {
    case "twoTheta": {
      if (wl === undefined) return NaN;
      const t = braggTheta(d, wl);
      return Number.isNaN(t) ? NaN : (2 * t * 180) / Math.PI;
    }
    case "dSpacing": return d;
    case "q": return (2 * Math.PI) / d;
    case "tof":
      return tof ? tof.difC * d + tof.difA * d * d + tof.difB / d + tof.zero : NaN;
  }
}

/** The d-spacing span a pattern covers. */
export function dRange(pattern: PowderPattern, tof?: TofCalibration): { dMin: number; dMax: number } {
  const xs = pattern.points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const wl = pattern.wavelength ?? (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : 1.54);
  switch (pattern.xUnit) {
    case "twoTheta": {
      const dAt = (tt: number) => wl / (2 * Math.sin((tt / 2) * (Math.PI / 180)));
      return { dMin: dAt(xMax), dMax: dAt(xMin) };
    }
    case "dSpacing": return { dMin: xMin, dMax: xMax };
    case "q": return { dMin: (2 * Math.PI) / xMax, dMax: (2 * Math.PI) / xMin };
    case "tof": {
      // Invert TOF≈difC·d+Zero (leading order) for the d bounds, widened 5% so a
      // small difA/difB curvature can't clip real reflections — the per-point
      // profile window drops any that fall outside the actual pattern anyway.
      if (!tof || !(tof.difC > 0)) return { dMin: 0.5, dMax: 5 };
      const dAt = (x: number) => (x - tof.zero) / tof.difC;
      const lo = dAt(xMin);
      const hi = dAt(xMax);
      const dMin = Math.max(1e-3, Math.min(lo, hi) * 0.95);
      const dMax = Math.max(lo, hi) * 1.05;
      return { dMin, dMax };
    }
  }
}

export interface LeBailResult {
  readonly reflections: LeBailReflection[];
  /** Each extra phase's reflections, in `extraPhases` order. */
  readonly extraReflections: LeBailReflection[][];
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
}

/** Indices i with |x_i − center| ≤ half, ascending. A binary search on a
 *  monotonic grid; a full scan otherwise. */
function window(x: readonly number[], center: number, half: number, monotonic: 1 | -1 | 0): number[] {
  const out: number[] = [];
  const n = x.length;
  if (monotonic === 0) {
    for (let i = 0; i < n; i++) if (Math.abs(x[i]! - center) <= half) out.push(i);
    return out;
  }
  // First index whose x is past the window's leading edge.
  const edge = monotonic === 1 ? center - half : center + half;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (monotonic === 1 ? x[mid]! < edge : x[mid]! > edge) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < n && Math.abs(x[i]! - center) <= half * (1 + 1e-12) + 1e-12; i++) {
    if (Math.abs(x[i]! - center) <= half) out.push(i);
  }
  return out;
}

function monotonicity(x: readonly number[]): 1 | -1 | 0 {
  let up = true;
  let down = true;
  for (let i = 1; i < x.length; i++) {
    if (x[i]! < x[i - 1]!) up = false;
    if (x[i]! > x[i - 1]!) down = false;
  }
  return up ? 1 : down ? -1 : 0;
}

export function leBailExtract(
  pattern: PowderPattern,
  cell: UnitCell,
  spaceGroup: SpaceGroup,
  options: LeBailOptions,
): LeBailResult {
  const { dMin, dMax } = dRange(pattern, options.tof);
  const phases: LeBailPhase[] = [{ cell, spaceGroup }, ...(options.extraPhases ?? [])];
  const perPhase = phases.map((ph) => generateReflections(ph.cell, ph.spaceGroup, dMin, dMax));
  const reflections = perPhase.flat();
  const phaseOf = perPhase.flatMap((list, p) => list.map(() => p));
  const shape = options.shape ?? "gaussian";
  const eta = options.eta ?? 0.5;
  const fwhm = Math.max(options.fwhm, 1e-4);
  const widthAt = cwWidth(pattern, fwhm, options.fwhmU ?? 0);
  const bkgOpt = options.background ?? 0;
  const bkgAt = (i: number): number => (typeof bkgOpt === "number" ? bkgOpt : bkgOpt[i] ?? 0);
  const cycles = options.cycles ?? 8;
  const tofProfile = shape === "tof" && pattern.xUnit === "tof" && options.tof ? options.tofProfile : undefined;

  const centers = reflections.map((r) => dToX(pattern, r.d, options.tof));
  const valid = reflections.map((_, i) => Number.isFinite(centers[i]!));
  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const order = monotonicity(x);

  // Faded to zero at the support edge: the cell prefit refines the widths and
  // the cell by finite differences, and a hard cutoff made yCalc (and each
  // norm_k) jump whenever a point crossed a moving edge.
  const profileOf = (k: number): { support: number; at: (xi: number) => number } => {
    const center = centers[k]!;
    const scale = phases[phaseOf[k]!]!.widthScale ?? 1;
    if (tofProfile) {
      const s0 = tofShapeAt(reflections[k]!.d, tofProfile);
      const s = scale === 1 ? s0 : { ...s0, sigma: s0.sigma * scale };
      // The long β tail sets the reach: e^-8 of the peak at 8 decay lengths.
      const support = 8 * (FWHM_PER_SIGMA * s.sigma + 1 / s.alpha + 1 / s.beta);
      return { support, at: (xi) => tofBackToBack(xi - center, s) * supportTaper(Math.abs(xi - center), support) };
    }
    const w = widthAt(center) * scale;
    const support = 12 * w;
    return {
      support,
      at: (xi) => (shape === "gaussian" ? gaussian(xi, center, w) : pseudoVoigt(xi, center, w, eta)) * supportTaper(Math.abs(xi - center), support),
    };
  };

  // Point-sum-normalized profile Ω_ik (Σ_i Ω_ik = 1) so that the Le Bail
  // partition conserves counts and the reconstruction matches the data
  // regardless of the grid spacing. Each reflection's points and Ω values are
  // computed once; the cycles then touch only those.
  const support: number[][] = [];
  const omega: number[][] = [];
  for (let k = 0; k < reflections.length; k++) {
    if (!valid[k]) {
      support.push([]);
      omega.push([]);
      continue;
    }
    const prof = profileOf(k);
    const idx = window(x, centers[k]!, prof.support, order);
    const raw = idx.map((i) => prof.at(x[i]!));
    let s = 0;
    for (const v of raw) s += v;
    const norm = s > 0 ? s : 1;
    support.push(idx);
    omega.push(raw.map((v) => v / norm));
  }

  const computeYCalc = (): number[] => {
    const y = x.map((_, i) => bkgAt(i));
    for (let k = 0; k < reflections.length; k++) {
      const idx = support[k]!;
      const om = omega[k]!;
      const ik = intensity[k]!;
      for (let j = 0; j < idx.length; j++) y[idx[j]!]! += ik * om[j]!;
    }
    return y;
  };

  // Initialize all reflection intensities equal.
  let intensity = reflections.map(() => 1);

  for (let cycle = 0; cycle < cycles; cycle++) {
    const yCalc = computeYCalc();
    const next = intensity.slice();
    for (let k = 0; k < reflections.length; k++) {
      if (!valid[k]) continue;
      const idx = support[k]!;
      const om = omega[k]!;
      let acc = 0;
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j]!;
        const peaks = yCalc[i]! - bkgAt(i);
        if (peaks <= 1e-12) continue;
        acc += (intensity[k]! * om[j]! / peaks) * (yObs[i]! - bkgAt(i));
      }
      next[k] = Math.max(acc, 0);
    }
    intensity = next;
  }

  const yCalcFinal = computeYCalc();

  const all: (LeBailReflection & { phase: number })[] = reflections
    .map((r, i) => ({ h: r.h, k: r.k, l: r.l, d: r.d, center: centers[i]!, intensity: intensity[i]!, phase: phaseOf[i]! }))
    .filter((_, i) => valid[i]);
  const strip = ({ phase: _phase, ...r }: LeBailReflection & { phase: number }): LeBailReflection => r;

  return {
    reflections: all.filter((r) => r.phase === 0).map(strip),
    extraReflections: phases.slice(1).map((_, p) => all.filter((r) => r.phase === p + 1).map(strip)),
    x,
    yObs,
    yCalc: yCalcFinal,
  };
}
