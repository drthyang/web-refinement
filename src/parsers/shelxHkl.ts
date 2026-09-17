/**
 * SHELX reflection-file parser: **HKLF 4** intensity data and **FCF** (CIF
 * reflection loops), the two formats single-crystal refinements are exchanged
 * in. Produces `Reflection2` (I = F², σ, optional batch) for the merge/refine
 * path.
 *
 * HKLF 4 is a fixed-column format — `3I4, 2F8.2, I4` = h,k,l, F², σ(F²), batch —
 * NOT free whitespace: a batch number can butt against σ with no space, and a
 * blank field is a real zero. Reading it by whitespace is not a lax variant of
 * this, it is a DIFFERENT parse: an intensity of 10000.00 or more fills its
 * F8.2 field and butts against `l`, so `   1   2   310000.00  100.00   1`
 * splits as l = 310000 and I = 100 — the σ column silently becomes the
 * intensity. We read by column, and fall back to whitespace splitting only for
 * rows that clearly are not fixed-width (e.g. hand-edited exports), so both the
 * canonical file and lax variants load.
 *
 * The `0 0 0` row. An all-zero line with no intensity terminates the data block
 * (SHELX convention); trailing batch/scale directives after it are ignored. A
 * `0 0 0` row that CARRIES an intensity is the forward beam in a nuclear file
 * (not a Bragg reflection) but the satellite at k itself in a
 * fundamental-indexed magnetic file — so dropping it is opt-in
 * (`skipForwardBeam`), the same contract `parsers/hkl.ts` offers.
 *
 * References: G. M. Sheldrick, "A short history of SHELX", Acta Cryst. A64
 * (2008) 112; SHELX-2018 manual, HKLF instruction and .fcf LIST 4.
 */

import type { Reflection2 } from "@/core/diffraction/merge";

export interface ShelxParseOptions {
  /** Drop `0 0 0` rows that carry an intensity (the forward beam). Default false. */
  readonly skipForwardBeam?: boolean;
}

export interface ShelxHklParse {
  readonly reflections: Reflection2[];
  /** True when at least one row carried a batch number ≠ 1 (multi-scan data). */
  readonly hasBatches: boolean;
  /** Rows skipped as unparseable (diagnostic; 0 for a clean file). */
  readonly skipped: number;
  /** `0 0 0` rows dropped by `skipForwardBeam` (the all-zero terminator is not counted). */
  readonly forwardBeamSkipped: number;
}

/** True when the text is a CIF reflection loop (a SHELX `.fcf`, LIST 4/6). */
export function isCifReflectionLoop(text: string): boolean {
  return /^\s*_refln[_.]index_h\b/im.test(text);
}

function fixedField(line: string, start: number, width: number): number | null {
  const raw = line.slice(start, start + width).trim();
  if (raw === "") return 0; // a blank fixed field is a real zero (esp. batch)
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** Parse one HKLF-4 data line; null when it is not a reflection row. */
function parseHklfLine(line: string): (Reflection2 & { batch: number }) | null {
  // Prefer fixed columns (3I4, 2F8, I4). Guard: the first 12 cols must hold
  // three integers.
  const h = fixedField(line, 0, 4);
  const k = fixedField(line, 4, 4);
  const l = fixedField(line, 8, 4);
  const fixedOk =
    h !== null && k !== null && l !== null &&
    Number.isInteger(h) && Number.isInteger(k) && Number.isInteger(l) &&
    line.length >= 28;
  if (fixedOk) {
    const intensity = fixedField(line, 12, 8);
    const sigma = fixedField(line, 20, 8);
    if (intensity !== null && sigma !== null) {
      const batch = fixedField(line, 28, 4) ?? 1;
      return { h, k, l, intensity, sigma, batch: batch === 0 ? 1 : batch };
    }
  }
  // Free-format fallback: h k l I σ [batch].
  const parts = line.trim().split(/\s+/).map(Number);
  if (parts.length >= 5 && parts.slice(0, 3).every((v) => Number.isInteger(v)) && parts.slice(0, 5).every((v) => Number.isFinite(v))) {
    const [fh, fk, fl, fi, fs] = parts as [number, number, number, number, number];
    const batch = parts.length >= 6 && Number.isFinite(parts[5]!) ? parts[5]! : 1;
    return { h: fh, k: fk, l: fl, intensity: fi, sigma: fs, batch: batch === 0 ? 1 : batch };
  }
  return null;
}

/** Parse SHELX HKLF-4 intensity data. Stops at the `0 0 0` terminator line. */
export function parseShelxHkl(text: string, opts: ShelxParseOptions = {}): ShelxHklParse {
  const reflections: Reflection2[] = [];
  let hasBatches = false;
  let skipped = 0;
  let forwardBeamSkipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const row = parseHklfLine(rawLine);
    if (!row) { skipped++; continue; }
    if (row.h === 0 && row.k === 0 && row.l === 0) {
      // End-of-data terminator: all zero, no σ — nothing after it is data.
      if (row.intensity === 0 && row.sigma <= 0) break;
      if (opts.skipForwardBeam) { forwardBeamSkipped++; continue; }
    }
    if (row.batch !== 1) hasBatches = true;
    reflections.push({ h: row.h, k: row.k, l: row.l, intensity: row.intensity, sigma: row.sigma, ...(row.batch !== 1 ? { batch: row.batch } : {}) });
  }
  return { reflections, hasBatches, skipped, forwardBeamSkipped };
}

/**
 * Parse a SHELX/CIF **.fcf** reflection loop (LIST 4/6): a `loop_` with
 * `_refln_index_h/k/l` and `_refln_F_squared_meas` + `_..._sigma` (or
 * `_refln_F_meas` for LIST 6, squared on read). Column order is taken from the
 * loop header, so exports with reordered columns still load.
 */
export function parseFcf(text: string, opts: ShelxParseOptions = {}): ShelxHklParse {
  const lines = text.split(/\r?\n/);
  const reflections: Reflection2[] = [];
  let skipped = 0;
  let forwardBeamSkipped = 0;

  // Find a loop_ whose headers include the reflection index tags.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "loop_") continue;
    const tags: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim().startsWith("_")) {
      tags.push(lines[j]!.trim().toLowerCase());
      j++;
    }
    const col = (name: string): number => tags.indexOf(name);
    const hi = col("_refln_index_h");
    const ki = col("_refln_index_k");
    const li = col("_refln_index_l");
    if (hi < 0 || ki < 0 || li < 0) continue;
    const fSqMeas = col("_refln_f_squared_meas");
    const fSqSig = col("_refln_f_squared_sigma");
    const fMeas = col("_refln_f_meas");
    const fSig = col("_refln_f_sigma");
    const squared = fSqMeas >= 0;
    const iCol = squared ? fSqMeas : fMeas;
    const sCol = squared ? fSqSig : fSig;
    if (iCol < 0) continue;

    for (; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (t === "" || t === "loop_" || t.startsWith("_") || t.startsWith("#")) break;
      const parts = t.split(/\s+/);
      if (parts.length < tags.length) { if (t.length) skipped++; continue; }
      const h = Number(parts[hi]);
      const k = Number(parts[ki]);
      const l = Number(parts[li]);
      const rawI = Number(parts[iCol]);
      const rawS = sCol >= 0 ? Number(parts[sCol]) : 0;
      if (![h, k, l, rawI].every(Number.isFinite)) { skipped++; continue; }
      // A CIF loop has no terminator row, so every `0 0 0` here is a forward
      // beam (nuclear) or the satellite at k (fundamental-indexed magnetic).
      if (h === 0 && k === 0 && l === 0 && opts.skipForwardBeam) { forwardBeamSkipped++; continue; }
      // LIST 6 gives F and σ(F); convert to F² with error propagation σ(F²)=2Fσ(F).
      const intensity = squared ? rawI : rawI * rawI;
      const sigma = squared ? (Number.isFinite(rawS) ? rawS : 0) : 2 * Math.abs(rawI) * (Number.isFinite(rawS) ? rawS : 0);
      reflections.push({ h, k, l, intensity, sigma });
    }
    if (reflections.length) break;
  }
  return { reflections, hasBatches: false, skipped, forwardBeamSkipped };
}
