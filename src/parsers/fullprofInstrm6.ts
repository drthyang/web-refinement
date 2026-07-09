/**
 * Reader for FullProf's **INSTRM = 6** powder format — "D2B, 3T2, G4.2 (ILL,
 * LLB)". This is a constant-wavelength neutron pattern that shares the `.dat`
 * extension with several other ILL templates but is a *distinct* layout — the
 * source of much community confusion. Structure:
 *
 *   line 1 : title  (free text; may carry non-ASCII, e.g. the Å symbol)
 *   line 2 : … step …   (several fields; one is the 2θ step, e.g. 0.100)
 *   line 3 : 2θ_start    (a lone number)
 *   line 4 : monitors    (normalisation counts)
 *   data   : fixed-width `(I2, I6)` pairs, 10 per 80-column line — the I2 is a
 *            detector-block index (cycles 1→10), *not* a per-point flag and
 *            *not* a run-length; the I6 is the intensity. Read the I6 values in
 *            file order to get the pattern.
 *   end    : negative sentinels (-1000, -10000)
 *
 * Distinguished from the ILL "numor" `.dat` (see illPowder.ts) by its header:
 * INSTRM=6 has a lone-number 2θ_start line and an all-numeric step line, where
 * the numor format instead carries a `DD-MON-YY HH:MM:SS` line and an
 * `NPTS … CALIBRATED` line. Reference: FullProf manual (Rodríguez-Carvajal),
 * data-format code Ins = 6.
 */

import type { PowderPattern, PowderPoint, Radiation } from "@/core/diffraction/types";

/** Fixed-width `(I2, I6)` pairs of one 80-column record: {block index, count}. */
function decodePairs(line: string): { flag: number; count: number }[] {
  const out: { flag: number; count: number }[] = [];
  for (let i = 0; i + 8 <= Math.max(line.length, 8) && i < 80; i += 8) {
    const field = line.slice(i, i + 8);
    if (field.trim() === "") continue;
    const c = field.slice(2, 8).trim();
    if (c === "") continue;
    const count = Number(c);
    if (!Number.isFinite(count)) continue;
    const f = field.slice(0, 2).trim();
    out.push({ flag: f === "" ? 1 : Number(f), count });
  }
  return out;
}

/** Header numeric tokens of a line (empty if it is the title / non-numeric). */
function numTokens(line: string): number[] {
  const toks = line.trim().split(/\s+/).filter((t) => t !== "");
  const nums = toks.map(Number);
  return nums.every(Number.isFinite) ? nums : [];
}

const isSentinel = (line: string): boolean => /^-1000\d*$/.test(line.trim());

/** A genuine data record: ≥5 fixed-width pairs, all integer counts, small
 *  integer block indices. Excludes the free-format numeric header lines (whose
 *  step 0.100 / monitor decimals are non-integer when column-sliced). */
function isDataLine(line: string): boolean {
  const pairs = decodePairs(line);
  if (pairs.length < 5) return false;
  return pairs.every((p) => Number.isInteger(p.count) && p.count >= 0 && Number.isInteger(p.flag) && p.flag >= 1 && p.flag <= 99);
}

/** True for a FullProf INSTRM=6 (D2B/3T2/G4.2) powder file. */
export function looksLikeInstrm6(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.length < 6) return false;
  if (!lines.some(isSentinel)) return false;
  const head = lines.slice(0, 6);
  // A lone 2θ-start line (one number, |x| < 180) after the title …
  const loneStart = head.some((l, i) => { const n = numTokens(l); return i >= 1 && n.length === 1 && Math.abs(n[0]!) < 180; });
  // … and a multi-field step line carrying a small positive non-integer (the step).
  const stepLine = head.some((l) => { const n = numTokens(l); return n.length >= 3 && n.some((v) => v > 0 && v < 5 && !Number.isInteger(v)); });
  return loneStart && stepLine;
}

export interface Instrm6Options {
  readonly id: string;
  readonly name: string;
  readonly radiation: Radiation;
  readonly wavelength?: number;
}

/** Wavelength (Å) named in the header, e.g. "Lambda (Å): 2.6". */
function headerWavelength(title: string): number | undefined {
  const m = title.match(/lambda[^0-9]*([0-9]*\.?[0-9]+)/i);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 && v < 20 ? v : undefined;
}

/**
 * Parse a FullProf INSTRM=6 powder file into a 2θ `PowderPattern`. Throws with a
 * clear message if the header layout (2θ_start / step) can't be recovered.
 */
export function parseFullProfInstrm6(text: string, opts: Instrm6Options): PowderPattern {
  const lines = text.split(/\r?\n/);
  const title = (lines[0] ?? "").replace(/[^\x20-\x7E]/g, "").trim(); // drop the non-ASCII Å byte

  // Data starts at the first line that decodes to several (I2,I6) pairs — robust
  // to the exact header length.
  let dataStart = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isDataLine(lines[i]!)) { dataStart = i; break; }
  }
  if (dataStart < 0) throw new Error("INSTRM=6 powder file: no (I2,I6) data block found");

  // Header: the lone-number line is 2θ_start; the small positive non-integer in a
  // multi-field line is the step.
  let twoThetaStart: number | undefined;
  let step: number | undefined;
  for (let i = 1; i < dataStart; i++) {
    const n = numTokens(lines[i]!);
    if (n.length === 1 && Math.abs(n[0]!) < 180) twoThetaStart = n[0];
    else if (n.length >= 3) { const s = n.find((v) => v > 0 && v < 5 && !Number.isInteger(v)); if (s !== undefined) step = s; }
  }
  if (twoThetaStart === undefined || step === undefined || !(step > 0)) {
    throw new Error(`INSTRM=6 powder file: could not read 2θ start/step (start=${twoThetaStart}, step=${step})`);
  }

  // Intensities: the I6 value of each pair, in file order, until the sentinel.
  const counts: number[] = [];
  let stop = false;
  for (let i = dataStart; i < lines.length && !stop; i++) {
    if (isSentinel(lines[i]!)) break;
    for (const { count } of decodePairs(lines[i]!)) {
      if (count <= -1000) { stop = true; break; }
      counts.push(count);
    }
  }
  if (counts.length === 0) throw new Error("INSTRM=6 powder file: no intensity data found");

  const wavelength = opts.wavelength ?? headerWavelength(lines[0] ?? "");
  const points: PowderPoint[] = counts.map((y, i) => ({
    x: twoThetaStart! + i * step!,
    yObs: y,
    sigma: Math.sqrt(Math.max(y, 1)),
  }));

  return {
    id: opts.id,
    name: opts.name || title || "pattern",
    xUnit: "twoTheta",
    radiation: wavelength !== undefined ? { kind: "neutron", wavelength } : opts.radiation,
    points,
    ...(wavelength !== undefined ? { wavelength } : {}),
  };
}
