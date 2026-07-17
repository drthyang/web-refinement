/**
 * Unit-cell geometry: metric tensors, volume, d-spacings, and the
 * fractional↔Cartesian transform. All derived from the six cell parameters on
 * demand (never stored), so they cannot drift out of sync.
 *
 * Reciprocal convention is crystallographic (no 2π): a*·a = 1, and
 * |Q| = 2π/d is applied explicitly where needed.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { UnitCell } from "@/core/crystal/types";
import { inverse, mulVec } from "@/core/math/mat3";

const DEG = Math.PI / 180;


/** Direct metric tensor G (Å²). */
export function metricTensor(cell: UnitCell): Mat3 {
  const { a, b, c } = cell;
  const ca = Math.cos(cell.alpha * DEG);
  const cb = Math.cos(cell.beta * DEG);
  const cg = Math.cos(cell.gamma * DEG);
  return [
    [a * a, a * b * cg, a * c * cb],
    [a * b * cg, b * b, b * c * ca],
    [a * c * cb, b * c * ca, c * c],
  ];
}

/** Reciprocal metric tensor G* = G⁻¹ (Å⁻²). */
export function reciprocalMetricTensor(cell: UnitCell): Mat3 {
  return inverse(metricTensor(cell));
}

/**
 * GSAS-II-style reciprocal tensor coefficients A such that
 * 1/d² = A11·h² + A22·k² + A33·l² + A12·h·k + A13·h·l + A23·k·l.
 * Note A12 = 2·G*12 etc. (the off-diagonal factor of 2 is folded in).
 */
export interface ReciprocalTensorA {
  readonly a11: number;
  readonly a22: number;
  readonly a33: number;
  readonly a12: number;
  readonly a13: number;
  readonly a23: number;
}

export function reciprocalTensorA(cell: UnitCell): ReciprocalTensorA {
  const g = reciprocalMetricTensor(cell);
  return {
    a11: g[0][0],
    a22: g[1][1],
    a33: g[2][2],
    a12: 2 * g[0][1],
    a13: 2 * g[0][2],
    a23: 2 * g[1][2],
  };
}

/** Cell volume (Å³). */
export function cellVolume(cell: UnitCell): number {
  const ca = Math.cos(cell.alpha * DEG);
  const cb = Math.cos(cell.beta * DEG);
  const cg = Math.cos(cell.gamma * DEG);
  const factor = 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg;
  return cell.a * cell.b * cell.c * Math.sqrt(Math.max(factor, 0));
}

/** 1/d² for a reflection (Å⁻²). */
export function inverseDSquared(cell: UnitCell, h: number, k: number, l: number): number {
  const A = reciprocalTensorA(cell);
  return (
    A.a11 * h * h +
    A.a22 * k * k +
    A.a33 * l * l +
    A.a12 * h * k +
    A.a13 * h * l +
    A.a23 * k * l
  );
}

/** d-spacing for a reflection (Å). Returns Infinity for (000). */
export function dSpacing(cell: UnitCell, h: number, k: number, l: number): number {
  const inv = inverseDSquared(cell, h, k, l);
  if (inv <= 0) return Infinity;
  return 1 / Math.sqrt(inv);
}

/** |Q| = 2π/d (Å⁻¹). */
export function qMagnitude(cell: UnitCell, h: number, k: number, l: number): number {
  const d = dSpacing(cell, h, k, l);
  return d === Infinity ? 0 : (2 * Math.PI) / d;
}

/**
 * Orthogonalization matrix M mapping fractional → Cartesian coordinates
 * (Å), using the standard convention: a along x, b in the xy-plane, c
 * completing a right-handed frame. Cartesian = M · fractional.
 */
export function orthogonalizationMatrix(cell: UnitCell): Mat3 {
  const { a, b, c } = cell;
  const ca = Math.cos(cell.alpha * DEG);
  const cb = Math.cos(cell.beta * DEG);
  const cg = Math.cos(cell.gamma * DEG);
  const sg = Math.sin(cell.gamma * DEG);
  const v = cellVolume(cell);
  const cz = v / (a * b * sg); // = c · sqrt(...) / sg
  return [
    [a, b * cg, c * cb],
    [0, b * sg, (c * (ca - cb * cg)) / sg],
    [0, 0, cz],
  ];
}

export function fractionalToCartesian(cell: UnitCell, frac: Vec3): Vec3 {
  return mulVec(orthogonalizationMatrix(cell), frac);
}

/** Bragg angle θ (radians) for a given d and wavelength; NaN if beyond range. */
export function braggTheta(d: number, wavelength: number): number {
  const s = wavelength / (2 * d);
  if (s > 1) return NaN;
  return Math.asin(s);
}
