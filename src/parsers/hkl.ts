/**
 * Parser for single-crystal reflection intensity tables.
 *
 * Accepts free-form whitespace-separated rows: `h k l Iobs [sigma]`. Blank lines
 * and `#`/`!` comment lines are ignored. This covers the common SHELX-style HKL
 * and simple exported reflection lists.
 *
 * The `0 0 0` row. SHELX HKLF files end with an all-zero line (indices and
 * intensity 0, no σ) that terminates the data — never a reflection, so reading
 * stops there. A `0 0 0` row that carries an intensity is the forward beam in a
 * nuclear file (not a Bragg reflection: refining it fits k·|F(000)|² to a
 * meaningless number, and with σ = 0 at unit weight) but the satellite at k
 * itself in a fundamental-indexed magnetic file — so dropping it is opt-in
 * (`skipForwardBeam`); the nuclear loaders ask for it.
 */

import type { SingleCrystalReflection } from "@/core/diffraction/types";

export interface HklParseOptions {
  /** Drop `0 0 0` rows that carry an intensity (the forward beam). Default false. */
  readonly skipForwardBeam?: boolean;
}

export interface HklParse {
  readonly reflections: SingleCrystalReflection[];
  /** `0 0 0` rows dropped by `skipForwardBeam` (the all-zero SHELX terminator is not counted). */
  readonly forwardBeamSkipped: number;
}

export function parseHklRows(text: string, opts: HklParseOptions = {}): HklParse {
  const reflections: SingleCrystalReflection[] = [];
  let forwardBeamSkipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 4 || parts.slice(0, 4).some((v) => Number.isNaN(v))) continue;
    const [h, k, l, iObs] = parts as [number, number, number, number];
    const sigma = parts.length >= 5 && !Number.isNaN(parts[4]!) ? parts[4]! : undefined;
    if (h === 0 && k === 0 && l === 0) {
      // SHELX end-of-data terminator: all zero, no σ — nothing after it is data.
      if (iObs === 0 && !(sigma !== undefined && sigma > 0)) break;
      if (opts.skipForwardBeam) { forwardBeamSkipped++; continue; }
    }
    reflections.push({ h, k, l, iObs, ...(sigma !== undefined ? { sigma } : {}) });
  }
  return { reflections, forwardBeamSkipped };
}

/** The reflections alone (see `parseHklRows` for the forward-beam drop count). */
export function parseHkl(text: string, opts: HklParseOptions = {}): SingleCrystalReflection[] {
  return parseHklRows(text, opts).reflections;
}
