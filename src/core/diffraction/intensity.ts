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
import type { StructureModel, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { Reflection } from "@/core/diffraction/reflections";
import { braggTheta, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { mulVec } from "@/core/math/mat3";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";

/**
 * March–Dollase preferred-orientation correction for a reflection (hkl) given a
 * preferred-orientation axis (as reciprocal indices) and the March coefficient
 * r (r = 1 ⇒ no texture):
 *   P(α) = (r²·cos²α + sin²α / r)^(−3/2),
 * where α is the angle between the reflection's reciprocal vector and the PO axis.
 */
export function marchDollase(
  cell: UnitCell,
  poAxis: Vec3,
  h: number,
  k: number,
  l: number,
  ratio: number,
): number {
  if (ratio === 1) return 1;
  const g = reciprocalMetricTensor(cell);
  const hkl: Vec3 = [h, k, l];
  const gHkl = mulVec(g, hkl);
  const gPo = mulVec(g, poAxis);
  const dotHP = hkl[0] * gPo[0] + hkl[1] * gPo[1] + hkl[2] * gPo[2];
  const normH = Math.sqrt(hkl[0] * gHkl[0] + hkl[1] * gHkl[1] + hkl[2] * gHkl[2]);
  const normP = Math.sqrt(poAxis[0] * gPo[0] + poAxis[1] * gPo[1] + poAxis[2] * gPo[2]);
  if (normH < 1e-9 || normP < 1e-9) return 1;
  const cosA = Math.min(1, Math.max(-1, dotHP / (normH * normP)));
  const cos2 = cosA * cosA;
  const sin2 = 1 - cos2;
  return Math.pow(ratio * ratio * cos2 + sin2 / ratio, -1.5);
}

export interface PreferredOrientation {
  readonly axis: Vec3;
  readonly ratio: number;
}

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
  po?: PreferredOrientation,
): PowderPeak[] {
  const peaks: PowderPeak[] = [];
  for (const r of reflections) {
    const f2 = nuclearStructureFactorSquared(model, radiation, r.h, r.k, r.l);
    const lp = lorentzPolarization(radiation, r.d);
    const poFactor = po ? marchDollase(model.cell, po.axis, r.h, r.k, r.l, po.ratio) : 1;
    const intensity = scale * r.multiplicity * lp * poFactor * f2;
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
