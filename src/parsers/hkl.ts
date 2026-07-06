/**
 * Parser for single-crystal reflection intensity tables.
 *
 * Accepts free-form whitespace-separated rows: `h k l Iobs [sigma]`. Blank lines
 * and `#`/`!` comment lines are ignored. This covers the common SHELX-style HKL
 * and simple exported reflection lists.
 */

import type { SingleCrystalReflection } from "@/core/diffraction/types";

export function parseHkl(text: string): SingleCrystalReflection[] {
  const reflections: SingleCrystalReflection[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 4 || parts.slice(0, 4).some((v) => Number.isNaN(v))) continue;
    const [h, k, l, iObs] = parts as [number, number, number, number];
    const sigma = parts.length >= 5 && !Number.isNaN(parts[4]!) ? parts[4]! : undefined;
    reflections.push({ h, k, l, iObs, ...(sigma !== undefined ? { sigma } : {}) });
  }
  return reflections;
}
