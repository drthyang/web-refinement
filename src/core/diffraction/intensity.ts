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
 * where α is the angle between the reflection's reciprocal vector and the PO
 * axis. Reference: Dollase, W. A. (1986), *J. Appl. Cryst.* 19, 267.
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
 * Debye–Scherrer (cylinder) absorption transmission A(μR, θ), ported verbatim
 * from GSAS-II's `Absorb` (cylinder geometry) — an analytical fit in μR and
 * sin²θ. Returns the transmitted fraction (≤ 1) that multiplies the calculated
 * intensity; μR = 0 ⇒ 1 (no absorption). Two branches at μR = 3.
 *
 * μR is the linear absorption coefficient × capillary radius; for a hard X-ray
 * synchrotron capillary it is typically small (≲ 1).
 */
export function cylinderAbsorption(muR: number, twoThetaDeg: number): number {
  if (muR <= 0) return 1;
  const theta = (twoThetaDeg / 2) * (Math.PI / 180);
  const sth2 = Math.sin(theta) ** 2;
  if (muR <= 3) {
    const t0 = 16.0 / (3 * Math.PI);
    const t1 = (25.99978 - 0.01911 * sth2 ** 0.25) * Math.exp(-0.024551 * sth2) + 0.109561 * Math.sqrt(sth2) - 26.04556;
    const t2 = -0.02489 - 0.39499 * sth2 + 1.219077 * sth2 ** 1.5 - 1.31268 * sth2 ** 2 + 0.871081 * sth2 ** 2.5 - 0.2327 * sth2 ** 3;
    const t3 = 0.003045 + 0.018167 * sth2 - 0.03305 * sth2 ** 2;
    const trns = -t0 * muR - t1 * muR ** 2 - t2 * muR ** 3 - t3 * muR ** 4;
    return Math.exp(trns);
  }
  const t1 = 1.433902 + 11.07504 * sth2 - 8.77629 * sth2 * sth2 + 10.02088 * sth2 ** 3 - 3.36778 * sth2 ** 4;
  const t2 = (0.013869 - 0.01249 * sth2) * Math.exp(3.27094 * sth2) + (0.337894 + 13.77317 * sth2) / (1.0 + 11.53544 * sth2) ** 1.555039;
  const t3 = 1.933433 / (1.0 + 23.12967 * sth2) ** 1.686715 - 0.13576 * Math.sqrt(sth2) + 1.163198;
  const t4 = 0.044365 - 0.04259 / (1.0 + 0.41051 * sth2) ** 148.4202;
  const trns = (t1 - t4) / (1.0 + t2 * (muR - 3.0)) ** t3 + t4;
  return Math.max(trns / 100, 1e-6);
}

/**
 * Lorentz(-polarization) factor for a powder experiment.
 *  - neutron (CW): L = 1 / (sin²θ · cosθ)
 *  - X-ray (CW):   Lp = [(1−P)·cos²2θ + P] / (sin²θ · cosθ), P = polarization
 *    fraction (GSAS-II Polariz.). P = 0.5 ⇒ the unpolarized (1+cos²2θ)/2 form;
 *    a monochromated synchrotron beam has P ≈ 0.9–0.95, which materially
 *    re-weights mid-angle reflections. Reference: Azaroff (1955); GSAS-II
 *    `Polarization`. Pecharsky & Zavalij, *Fundamentals of Powder Diffraction*.
 *  - neutron (TOF): L = d⁴ — the fixed-2θ time-of-flight Lorentz factor
 *    (Buras & Gerward; GSAS-II). The sin θ prefactor is constant per detector
 *    bank and absorbed into the refined scale.
 * Returns 1 when θ is undefined.
 */
export function lorentzPolarization(radiation: Radiation, d: number): number {
  if (radiation.kind === "neutron-tof") return d * d * d * d;
  const theta = braggTheta(d, radiation.wavelength);
  if (Number.isNaN(theta)) return 1;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lorentz = 1 / (sinT * sinT * cosT);
  if (radiation.kind === "xray") {
    const cos2T = Math.cos(2 * theta);
    const p = radiation.polarization ?? 0.5;
    return ((1 - p) * cos2T * cos2T + p) * lorentz;
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
  applyLorentz = true,
): PowderPeak[] {
  const peaks: PowderPeak[] = [];
  for (const r of reflections) {
    const f2 = nuclearStructureFactorSquared(model, radiation, r.h, r.k, r.l);
    // Pre-reduced synchrotron I(Q) (e.g. area-detector PDF beamlines) is already
    // Lorentz-corrected; re-applying the 2θ factor double-corrects and wildly
    // over-weights low Q. `applyLorentz=false` skips it for such data.
    const lp = applyLorentz ? lorentzPolarization(radiation, r.d) : 1;
    const poFactor = po ? marchDollase(model.cell, po.axis, r.h, r.k, r.l, po.ratio) : 1;
    // Scale multiplies LAST so unit-scale intensities scaled afterwards are
    // bit-identical to computing at the target scale directly — the invariant
    // the geometry cache in workflow/powder.ts relies on.
    const intensity = r.multiplicity * lp * poFactor * f2 * scale;
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
