/**
 * Parser for two-/three-column powder data: `x y [sigma]`. Blank and comment
 * lines (`#`, `!`) are skipped. The x-unit and radiation are supplied by the
 * caller (from file metadata or the UI), not inferred from the numbers.
 */

import type { PowderPattern, PowderPoint, PowderXUnit, Radiation } from "@/core/diffraction/types";

export interface PowderParseOptions {
  readonly id: string;
  readonly name: string;
  readonly xUnit: PowderXUnit;
  readonly radiation: Radiation;
  readonly wavelength?: number;
}

export function parsePowderData(text: string, opts: PowderParseOptions): PowderPattern {
  const points: PowderPoint[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const parts = line.split(/[\s,]+/).map(Number);
    if (parts.length < 2 || Number.isNaN(parts[0]!) || Number.isNaN(parts[1]!)) continue;
    const x = parts[0]!;
    const yObs = parts[1]!;
    const sigma = parts.length >= 3 && !Number.isNaN(parts[2]!) ? parts[2]! : undefined;
    points.push({ x, yObs, ...(sigma !== undefined ? { sigma } : {}) });
  }
  return {
    id: opts.id,
    name: opts.name,
    xUnit: opts.xUnit,
    radiation: opts.radiation,
    points,
    ...(opts.wavelength !== undefined ? { wavelength: opts.wavelength } : {}),
  };
}
