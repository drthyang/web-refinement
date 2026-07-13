/**
 * Le Bail intensity extraction: partition an observed powder pattern into
 * per-reflection integrated intensities using only the cell + space group (no
 * structural model). Used for indexing checks, space-group testing, and as
 * input to structure solution — a standard capability in GSAS-II / Jana /
 * FullProf.
 *
 * Iteration (Le Bail 1988): with a current set of intensities I_k, the observed
 * intensity assigned to reflection k is
 *   I_k^obs = Σ_i [ I_k · Ω(i,k) / y_i^calc ] · y_i^obs,
 * where Ω(i,k) is reflection k's (area-normalized) profile at point i. Repeating
 * this converges to a self-consistent partition of the pattern.
 */

import type { UnitCell, SpaceGroup } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { braggTheta } from "@/core/crystal/unitCell";
import { gaussian, pseudoVoigt, type PeakShape } from "@/core/diffraction/profile";

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

export interface LeBailOptions {
  readonly fwhm: number;
  readonly shape?: PeakShape;
  readonly eta?: number;
  readonly cycles?: number;
  readonly background?: number;
  /** Required for a TOF (`xUnit === "tof"`) pattern: without it a reflection's
   *  d-spacing cannot be mapped to a time-of-flight position. */
  readonly tof?: TofCalibration;
}

function dToX(pattern: PowderPattern, d: number, tof?: TofCalibration): number {
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

function dRange(pattern: PowderPattern, tof?: TofCalibration): { dMin: number; dMax: number } {
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
  readonly x: number[];
  readonly yObs: number[];
  readonly yCalc: number[];
}

export function leBailExtract(
  pattern: PowderPattern,
  cell: UnitCell,
  spaceGroup: SpaceGroup,
  options: LeBailOptions,
): LeBailResult {
  const { dMin, dMax } = dRange(pattern, options.tof);
  const reflections = generateReflections(cell, spaceGroup, dMin, dMax);
  const shape = options.shape ?? "gaussian";
  const eta = options.eta ?? 0.5;
  const fwhm = Math.max(options.fwhm, 1e-4);
  const bkg = options.background ?? 0;
  const cycles = options.cycles ?? 8;

  const centers = reflections.map((r) => dToX(pattern, r.d, options.tof));
  const valid = reflections.map((_, i) => Number.isFinite(centers[i]!));
  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);

  const rawShape = (xi: number, center: number): number =>
    shape === "gaussian" ? gaussian(xi, center, fwhm) : pseudoVoigt(xi, center, fwhm, eta);

  const support = 12 * fwhm;

  // Point-sum-normalized profile Ω_ik (Σ_i Ω_ik = 1) so that the Le Bail
  // partition conserves counts and the reconstruction matches the data
  // regardless of the grid spacing. norm_k = Σ_i shape(x_i, center_k).
  const norm = centers.map((center, k) => {
    if (!valid[k]) return 1;
    let s = 0;
    for (const xi of x) if (Math.abs(xi - center) <= support) s += rawShape(xi, center);
    return s > 0 ? s : 1;
  });
  const omega = (xi: number, k: number): number => rawShape(xi, centers[k]!) / norm[k]!;

  const computeYCalc = (): number[] =>
    x.map((xi) => {
      let sum = bkg;
      for (let k = 0; k < reflections.length; k++) {
        if (!valid[k]) continue;
        if (Math.abs(xi - centers[k]!) > support) continue;
        sum += intensity[k]! * omega(xi, k);
      }
      return sum;
    });

  // Initialize all reflection intensities equal.
  let intensity = reflections.map(() => 1);

  for (let cycle = 0; cycle < cycles; cycle++) {
    const yCalc = computeYCalc();
    const next = intensity.slice();
    for (let k = 0; k < reflections.length; k++) {
      if (!valid[k]) continue;
      let acc = 0;
      for (let i = 0; i < x.length; i++) {
        const xi = x[i]!;
        if (Math.abs(xi - centers[k]!) > support) continue;
        const yc = yCalc[i]!;
        if (yc <= 1e-12) continue;
        acc += (intensity[k]! * omega(xi, k) / yc) * (yObs[i]! - bkg);
      }
      next[k] = Math.max(acc, 0);
    }
    intensity = next;
  }

  const yCalcFinal = computeYCalc();

  const extracted: LeBailReflection[] = reflections
    .map((r, i) => ({ h: r.h, k: r.k, l: r.l, d: r.d, center: centers[i]!, intensity: intensity[i]! }))
    .filter((_, i) => valid[i]);

  return { reflections: extracted, x, yObs, yCalc: yCalcFinal };
}
