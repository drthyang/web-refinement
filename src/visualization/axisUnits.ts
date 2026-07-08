/**
 * Display-axis unit conversions for the powder plot. The observed data and the
 * refinement always live in the pattern's *native* abscissa (2θ, Q, d, or TOF);
 * this module converts x-values to a chosen display unit purely for viewing, so
 * the user can inspect the same pattern against 2θ, Q, d-spacing, or (for
 * time-of-flight data) TOF without touching the model.
 *
 * All conversions route through d-spacing:
 *   2θ ↔ d  needs a wavelength (constant-wavelength only);
 *   Q  ↔ d  is purely geometric (Q = 2π/d);
 *   TOF ↔ d needs the diffractometer constants difC/difA/difB/Zero.
 * A conversion that lacks its prerequisite (e.g. 2θ for pre-reduced Q data with
 * no wavelength) is simply not offered.
 */

import type { PowderPattern, PowderXUnit } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { dFromTof, tofFromD } from "@/core/diffraction/instrument";

export type DisplayUnit = PowderXUnit;

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

interface TofConstants {
  readonly difC: number;
  readonly difA: number;
  readonly difB: number;
  readonly zero: number;
}

/** Everything the conversions need, resolved once from the pattern + instrument. */
export interface AxisContext {
  readonly native: PowderXUnit;
  readonly wavelength?: number;
  readonly tof?: TofConstants;
}

export function axisContext(pattern: PowderPattern, instrument?: InstrumentParameters): AxisContext {
  const wavelength =
    pattern.wavelength ??
    (pattern.radiation.kind !== "neutron-tof" ? pattern.radiation.wavelength : undefined) ??
    (instrument?.kind === "constantWavelength" ? instrument.wavelength : undefined);
  const tof =
    instrument?.kind === "tof"
      ? { difC: instrument.difC, difA: instrument.difA ?? 0, difB: instrument.difB ?? 0, zero: instrument.zero ?? 0 }
      : undefined;
  return { native: pattern.xUnit, ...(wavelength !== undefined ? { wavelength } : {}), ...(tof ? { tof } : {}) };
}

/**
 * Units the user may switch the display to. TOF is offered only for TOF data
 * (never for a constant-wavelength instrument); 2θ only when a wavelength is
 * known; d and Q whenever the native unit can be reduced to d.
 */
export function availableDisplayUnits(ctx: AxisContext): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  if (ctx.native === "tof") {
    units.push("tof"); // TOF only for TOF data
  } else if (ctx.wavelength !== undefined) {
    units.push("twoTheta"); // 2θ needs a wavelength ⇒ constant-wavelength only
  }
  const canReachD =
    ctx.native === "dSpacing" ||
    ctx.native === "q" ||
    (ctx.native === "twoTheta" && ctx.wavelength !== undefined) ||
    (ctx.native === "tof" && ctx.tof !== undefined);
  if (canReachD) units.push("dSpacing", "q");
  if (!units.includes(ctx.native)) units.unshift(ctx.native);
  return units;
}

/** Native abscissa value → d-spacing (Å). NaN when the conversion is unavailable. */
function toD(x: number, unit: PowderXUnit, ctx: AxisContext): number {
  switch (unit) {
    case "dSpacing":
      return x;
    case "q":
      return x !== 0 ? TWO_PI / x : NaN;
    case "twoTheta":
      return ctx.wavelength !== undefined ? ctx.wavelength / (2 * Math.sin((x / 2) * DEG)) : NaN;
    case "tof":
      return ctx.tof ? dFromTof({ kind: "tof", ...ctx.tof }, x) : NaN;
  }
}

/** d-spacing (Å) → target abscissa value. NaN when the conversion is unavailable. */
function fromD(d: number, unit: PowderXUnit, ctx: AxisContext): number {
  switch (unit) {
    case "dSpacing":
      return d;
    case "q":
      return d !== 0 ? TWO_PI / d : NaN;
    case "twoTheta": {
      if (ctx.wavelength === undefined) return NaN;
      const arg = ctx.wavelength / (2 * d);
      return arg > 1 ? NaN : (2 * Math.asin(arg)) / DEG;
    }
    case "tof":
      return ctx.tof ? tofFromD({ kind: "tof", ...ctx.tof }, d) : NaN;
  }
}

export function convertAxisValue(x: number, from: PowderXUnit, to: PowderXUnit, ctx: AxisContext): number {
  if (from === to) return x;
  return fromD(toD(x, from, ctx), to, ctx);
}

export function convertAxisArray(
  xs: readonly number[],
  from: PowderXUnit,
  to: PowderXUnit,
  ctx: AxisContext,
): number[] {
  if (from === to) return xs.slice();
  return xs.map((x) => convertAxisValue(x, from, to, ctx));
}

/**
 * Convert an inclusive [min, max] window between units. Conversions can reverse
 * ordering (e.g. larger 2θ ⇒ smaller d), so the endpoints are re-sorted.
 */
export function convertInterval(
  interval: { readonly min: number; readonly max: number },
  from: PowderXUnit,
  to: PowderXUnit,
  ctx: AxisContext,
): { min: number; max: number } {
  const a = convertAxisValue(interval.min, from, to, ctx);
  const b = convertAxisValue(interval.max, from, to, ctx);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/** Axis label with unit, e.g. "2θ (°)". */
export function axisLabel(unit: DisplayUnit): string {
  switch (unit) {
    case "twoTheta":
      return "2θ (°)";
    case "q":
      return "Q (Å⁻¹)";
    case "dSpacing":
      return "d (Å)";
    case "tof":
      return "TOF (µs)";
  }
}

/** Short label for a unit toggle button. */
export function axisShortLabel(unit: DisplayUnit): string {
  switch (unit) {
    case "twoTheta":
      return "2θ";
    case "q":
      return "Q";
    case "dSpacing":
      return "d";
    case "tof":
      return "TOF";
  }
}
