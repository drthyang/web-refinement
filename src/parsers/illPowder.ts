/**
 * Reader for the classic **ILL constant-wavelength powder format** (D1B / D20,
 * "numor" ASCII), as produced at the ILL and read by FullProf. Layout:
 *
 *   line 1  : number of patterns (integer)
 *   line 2  : `DD-MON-YY HH:MM:SS  USER  TITLE`
 *   line 3  : run/numor identifiers (integers)
 *   line 4  : monitor  time  2θ_start  …  step  …   (12 floats)
 *   line 5  : NPTS  <5 floats>  <free-text comment, e.g. vanadium calibration>
 *   data    : NPTS × (flag, counts) pairs, 10 pairs per line
 *   trailer : negative sentinels (-1000, -10000)
 *
 * The leading integer of every data pair is a per-point flag (a detector-cell /
 * validity code), constant `1` in practice — it is *not* a run-length count:
 * two equal consecutive counts appear as two separate pairs, never compressed.
 * We take the second element of each pair as the intensity, place points on a
 * 2θ_start + i·step grid, and give σ = √counts (raw-count Poisson weight).
 *
 * The wavelength is not carried reliably in the data header — it comes from the
 * instrument (`.irf`); the caller supplies the radiation. Reference: the ILL
 * D1B/D20 data format used by FullProf (Rodríguez-Carvajal, FullProf manual).
 */

import type { PowderPattern, PowderPoint, Radiation } from "@/core/diffraction/types";

/** True for text that looks like the ILL D1B/D20 CW powder format. */
export function looksLikeIllD1b(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim() !== "")?.trim();
  const loneInteger = firstNonEmpty !== undefined && /^\d+$/.test(firstNonEmpty);
  // ILL numor header carries a `DD-MON-YY HH:MM:SS` timestamp.
  const hasNumorDate = lines.some((l) => /\b\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{1,2}:\d{2}:\d{2}/.test(l));
  // The data block ends with a large negative sentinel (-1000 / -10000).
  const hasSentinel = lines.some((l) => {
    const t = l.trim();
    return /^-\d{4,}$/.test(t) && Number(t) <= -1000;
  });
  return hasSentinel && (loneInteger || hasNumorDate);
}

/** Locate the `NPTS <floats> <comment>` header line: integer-first, with text,
 *  and not the `DD-MON-YY` timestamp line. Returns its index and NPTS. */
function findNptsLine(lines: readonly string[]): { index: number; npts: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const m = t.match(/^(\d+)\b/);
    if (!m) continue;
    if (/^\d{1,2}-[A-Za-z]{3}-\d{2}/.test(t)) continue; // the date line
    if (!/[A-Za-z]/.test(t)) continue; // needs the trailing comment text
    return { index: i, npts: parseInt(m[1]!, 10) };
  }
  return null;
}

export interface IllParseOptions {
  readonly id: string;
  readonly name: string;
  readonly radiation: Radiation;
  /** Wavelength (Å) for the pattern header, usually from the loaded instrument. */
  readonly wavelength?: number;
}

/**
 * Parse an ILL D1B/D20 CW powder file into a 2θ `PowderPattern`. Throws with a
 * clear message if the fixed header layout can't be located, rather than
 * silently producing a wrong x-axis.
 */
export function parseIllD1b(text: string, opts: IllParseOptions): PowderPattern {
  const lines = text.split(/\r?\n/);
  const npl = findNptsLine(lines);
  if (!npl) throw new Error("ILL powder file: could not find the NPTS/comment header line");

  // The parameters line (monitor, time, 2θ_start, …, step, …) is the nearest
  // preceding all-numeric line with enough fields.
  let params: number[] | null = null;
  for (let i = npl.index - 1; i >= 0; i--) {
    const toks = lines[i]!.trim().split(/\s+/).filter((t) => t !== "");
    if (toks.length === 0) continue;
    const nums = toks.map(Number);
    if (nums.every(Number.isFinite) && nums.length >= 9) { params = nums; break; }
  }
  if (!params) throw new Error("ILL powder file: could not find the 2θ-start/step parameter line");

  const twoThetaStart = params[2]!;
  const step = params[8]!;
  if (!(step > 0 && step < 10) || !(twoThetaStart > -20 && twoThetaStart < 170)) {
    throw new Error(`ILL powder file: implausible 2θ start/step (start=${twoThetaStart}, step=${step})`);
  }

  // Intensities: read numbers after the NPTS line until the negative sentinel,
  // then take the second of each (flag, counts) pair.
  const nums: number[] = [];
  let stop = false;
  for (let i = npl.index + 1; i < lines.length && !stop; i++) {
    for (const tok of lines[i]!.trim().split(/\s+/)) {
      if (tok === "") continue;
      const v = Number(tok);
      if (!Number.isFinite(v)) continue;
      if (v <= -1000) { stop = true; break; }
      nums.push(v);
    }
  }
  const counts: number[] = [];
  for (let i = 1; i < nums.length; i += 2) counts.push(nums[i]!);
  if (counts.length === 0) throw new Error("ILL powder file: no intensity data found");

  const n = npl.npts > 0 ? Math.min(npl.npts, counts.length) : counts.length;
  const points: PowderPoint[] = [];
  for (let i = 0; i < n; i++) {
    const y = counts[i]!;
    points.push({ x: twoThetaStart + i * step, yObs: y, sigma: Math.sqrt(Math.max(y, 1)) });
  }

  return {
    id: opts.id,
    name: opts.name,
    xUnit: "twoTheta",
    radiation: opts.radiation,
    points,
    ...(opts.wavelength !== undefined ? { wavelength: opts.wavelength } : {}),
  };
}
