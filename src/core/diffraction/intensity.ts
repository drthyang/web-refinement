/**
 * Intensity models converting structure factors to observable intensities.
 *
 * Single crystal (this workbench refines on integrated Bragg intensities):
 *   I(hkl) = scale · |F|²                        (optionally × Lorentz)
 *
 * Powder (constant-wavelength):
 *   I(hkl) = scale · m · Lp(θ) · |F|²
 * where m is the reflection multiplicity and Lp is the Lorentz(-polarization)
 * factor. Polarization applies to X-rays only.
 */

import type { Radiation } from "@/core/diffraction/types";
import type { StructureModel } from "@/core/crystal/types";
import type { Reflection } from "@/core/diffraction/reflections";
import { braggTheta } from "@/core/crystal/unitCell";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";

/**
 * Lorentz(-polarization) factor for a constant-wavelength powder experiment.
 *  - neutron: L = 1 / (sin²θ · cosθ)
 *  - X-ray:   Lp = (1 + cos²2θ) / (sin²θ · cosθ)
 * Returns 1 for time-of-flight (handled by the TOF profile, not implemented in
 * the minimal engine) or when θ is undefined.
 */
export function lorentzPolarization(radiation: Radiation, d: number): number {
  if (radiation.kind === "neutron-tof") return 1;
  const theta = braggTheta(d, radiation.wavelength);
  if (Number.isNaN(theta)) return 1;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lorentz = 1 / (sinT * sinT * cosT);
  if (radiation.kind === "xray") {
    const cos2T = Math.cos(2 * theta);
    return ((1 + cos2T * cos2T) / 2) * lorentz;
  }
  return lorentz;
}

export interface PowderPeak {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly twoTheta: number;
  readonly intensity: number;
}

/** Integrated peak intensities for a powder pattern (before profile spreading). */
export function powderPeakIntensities(
  model: StructureModel,
  radiation: Radiation,
  reflections: readonly Reflection[],
  scale: number,
): PowderPeak[] {
  const peaks: PowderPeak[] = [];
  for (const r of reflections) {
    const f2 = nuclearStructureFactorSquared(model, radiation, r.h, r.k, r.l);
    const lp = lorentzPolarization(radiation, r.d);
    const intensity = scale * r.multiplicity * lp * f2;
    let twoTheta = NaN;
    if (radiation.kind !== "neutron-tof") {
      const theta = braggTheta(r.d, radiation.wavelength);
      twoTheta = Number.isNaN(theta) ? NaN : (2 * theta * 180) / Math.PI;
    }
    peaks.push({ h: r.h, k: r.k, l: r.l, d: r.d, twoTheta, intensity });
  }
  return peaks;
}

/** Single-crystal calculated intensities aligned with an observed hkl list. */
export function singleCrystalIntensity(
  model: StructureModel,
  radiation: Radiation,
  h: number,
  k: number,
  l: number,
  scale: number,
): number {
  return scale * nuclearStructureFactorSquared(model, radiation, h, k, l);
}
