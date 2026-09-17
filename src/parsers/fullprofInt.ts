/**
 * Reader for the FullProf **single-crystal integrated-intensity** format
 * (`.int`, `ABS(Irf) = 4`) — the reflection list produced by DataRed / HB-3A /
 * D9 / D19 pipelines and consumed by FullProf and Mag2Pol. The format itself
 * (its reflection type, Fortran-format field machinery, and the **writer**)
 * lives in [`core/export/fullprofInt.ts`](../core/export/fullprofInt.ts): core
 * may not import a parser, so the shared pieces live in core and this reader
 * imports them. Layout (FullProf manual, "CODFILn.hkl, CODFIL.int or HKLn.hkl"
 * section; verified against real HB-3A files, 2026-07):
 *
 *   line 1 : free-text title
 *   line 2 : Fortran format for the reflection rows, e.g. `(3i4,2f8.2,i4,3f8.4)`
 *   line 3 : R_lambda  Itypdata  Ipow      (free format)
 *            Itypdata: 0 = F²/σ(F²) input, 1 = F/σ(F); Ipow: 0 = single crystal,
 *            1 = twinned, 2 = powder integrated-intensity clusters.
 *   [k-variant only]
 *     next : Nk — the number of propagation vectors (free format)
 *     next : Nk lines `nv k1 k2 k3` (ordinal + components, free format)
 *   data   : one reflection per line, fixed-width per the declared format:
 *            h k l [nv] Gobs σ(Gobs) [cod] [trailing coefficients]
 *
 * The satellite convention is **addition**: a row with k index `nv` is the
 * reflection H + k_nv (the −k satellite is a separate positive ordinal in the
 * k list — no source documents a signed per-row index). The k variant is
 * detected from the declared format: four leading integer fields (`4i…`) mean
 * an `nv` column follows `l`; three mean a plain nuclear file. The count line
 * is read free-format (tolerates both the left-justified real-file layout and
 * the `(32x,i2)` layout documented for the older Irf<4 family).
 *
 * The field widths are taken from the *declared* Fortran format on line 2, so
 * the reader adapts to the width variants across datasets rather than assuming
 * fixed columns; the writer re-emits through the same declared format, making
 * parse → write byte-stable on files this writer produced.
 */

import {
  parseFortranFields,
  leadingIntCount,
  type FullProfIntField,
  type FullProfIntReflection,
} from "@/core/export/fullprofInt";
import type { Vec3 } from "@/core/math/types";

/** One malformed-input diagnostic: where, what was expected, what was found. */
export interface FullProfIntProblem {
  /** 1-based line number in the input text. */
  readonly line: number;
  readonly expected: string;
  readonly found: string;
}

/** A parsed reflection row; satellites carry their 1-based k-list ordinal.
 *  Defined with the format in core (see the module header). */
export type { FullProfIntReflection };

export interface FullProfIntParse {
  readonly reflections: FullProfIntReflection[];
  /** Declared propagation vectors (k variant only), in file (ordinal) order. */
  readonly kVectors?: Vec3[];
  /** Wavelength (Å) from the R_lambda line, if present. */
  readonly wavelength?: number;
  /** Itypdata flag from the wavelength line (0 = F², 1 = F), if present. */
  readonly itypdata?: number;
  /** Ipow flag from the wavelength line (0/1/2), if present. */
  readonly ipow?: number;
  /** The declared Fortran format line, verbatim (for round-trip re-emission). */
  readonly format: string;
  readonly title: string;
  /** Rows skipped as unparseable (diagnostic; see `problems` for details). */
  readonly skipped: number;
  /** Of `skipped`, the `0 0 0` forward-beam rows dropped by `skipForwardBeam`. */
  readonly forwardBeamSkipped: number;
  /** Line-numbered diagnostics for every skipped/suspect input line. */
  readonly problems: FullProfIntProblem[];
}

/** Slice a line into values by fixed field widths (per the declared format). */
function sliceByFields(line: string, fields: readonly FullProfIntField[]): (number | null)[] {
  const out: (number | null)[] = [];
  let col = 0;
  for (const f of fields) {
    const raw = line.slice(col, col + f.width);
    col += f.width;
    if (f.kind === "x") continue;
    const t = raw.trim();
    if (t === "") { out.push(null); continue; }
    const v = Number(t);
    // Normalize the writer artifact "-0" (seen in real HB-3A files) to plain 0.
    out.push(Number.isFinite(v) ? (v === 0 ? 0 : v) : null);
  }
  return out;
}

const FORMAT_RE = /^\s*\([0-9ifegaxIFEGAX.,\s]+\)\s*$/;

/** True for text that looks like a FullProf single-crystal `.int` file. */
export function looksLikeFullProfInt(text: string): boolean {
  const lines = text.split(/\r?\n/, 6);
  return lines.some((l) => FORMAT_RE.test(l) && /[if]\d/i.test(l));
}


export interface FullProfIntParseOptions {
  /** Throw on the first structural/row problem (line + expected vs found)
   *  instead of skipping — the paired-load path uses this so a malformed file
   *  is rejected loudly rather than silently truncated. Default false. */
  readonly strict?: boolean;
  /** Skip a `0 0 0` row — the forward beam, not a Bragg reflection — counting
   *  it in `forwardBeamSkipped` (and `skipped`) and recording it in `problems`,
   *  never as a strict-mode error (the file is well-formed). Off by default:
   *  in the FullProf single-k convention a magnetic file is indexed by the
   *  fundamental of each satellite, so its `0 0 0` row IS the satellite at k
   *  and must be kept — the nuclear-file loaders opt in. A propagation-vector
   *  row (`h k l nv`) is skipped only when its k-vector is zero. */
  readonly skipForwardBeam?: boolean;
}

/**
 * Parse a FullProf single-crystal `.int` file (plain or propagation-vector
 * variant). Reads h k l [nv] I σ(I) [cod] via the declared Fortran format;
 * remaining trailing columns are ignored. Every skipped line is recorded in
 * `problems` with its 1-based line number; `strict` turns the first problem
 * into a thrown Error of the form `line N: expected …, found …`.
 */
export function parseFullProfInt(text: string, opts: FullProfIntParseOptions = {}): FullProfIntParse {
  const lines = text.split(/\r?\n/);
  const title = (lines[0] ?? "").trim();
  const problems: FullProfIntProblem[] = [];
  const problem = (line: number, expected: string, found: string): void => {
    if (opts.strict) throw new Error(`FullProf .int: line ${line}: expected ${expected}, found ${found || "(empty)"}`);
    problems.push({ line, expected, found });
  };

  // Locate the Fortran format line and the wavelength line just after it.
  let fmtIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (FORMAT_RE.test(lines[i]!) && /[if]\d/i.test(lines[i]!)) { fmtIdx = i; break; }
  }
  if (fmtIdx < 0) throw new Error("FullProf .int: line 2: expected a Fortran format line like (3i4,2f8.2,i4), found none in the first 8 lines");
  const format = lines[fmtIdx]!.trim();
  const fields = parseFortranFields(format);
  const nInt = leadingIntCount(fields);
  const hasK = nInt >= 4; // h k l nv … — the satellite variant declares 4 leading ints

  // Does a line slice into a valid integer-hkl reflection row? Used to tell the
  // structural header line (line 3) apart from data when a file omits it.
  const isReflectionRow = (line: string): boolean => {
    const s = sliceByFields(line, fields);
    return Number.isInteger(s[0]) && Number.isInteger(s[1]) && Number.isInteger(s[2]) && s[hasK ? 4 : 3] != null;
  };

  // Wavelength line: R_lambda Itypdata Ipow (free format). Structurally line 3 —
  // consume it unless it parses as a reflection (a file that omits it). Accept
  // R_lambda = 0, which a TOF single-crystal file legitimately writes; a zero
  // wavelength is not a usable λ, so it is recorded as itypdata/ipow only and
  // `wavelength` stays undefined (the dataset's radiation carries the TOF flag).
  let wavelength: number | undefined;
  let itypdata: number | undefined;
  let ipow: number | undefined;
  let cursor = fmtIdx + 1;
  const waveLine = lines[cursor];
  if (waveLine !== undefined && waveLine.trim() !== "" && !isReflectionRow(waveLine)) {
    const toks = waveLine.trim().split(/\s+/).map(Number);
    const w = toks[0];
    if (w !== undefined && Number.isFinite(w) && w >= 0 && w < 100) {
      if (w > 0) wavelength = w;
      if (toks[1] !== undefined && Number.isInteger(toks[1])) itypdata = toks[1];
      if (toks[2] !== undefined && Number.isInteger(toks[2])) ipow = toks[2];
      cursor++;
    }
  }

  // Propagation-vector block (k variant): a count line, then one `nv k1 k2 k3`
  // line per vector. Free-format read: tolerant of both the left-justified
  // real-file layout and a column-shifted count.
  let kVectors: Vec3[] | undefined;
  if (hasK) {
    const countLine = lines[cursor];
    const nk = countLine !== undefined ? Number(countLine.trim().split(/\s+/)[0]) : NaN;
    if (!Number.isInteger(nk) || nk < 1 || nk > 24) {
      problem(cursor + 1, "the propagation-vector count (an integer 1–24; the format declares an nv column)", (countLine ?? "").trim());
    } else {
      cursor++;
      kVectors = [];
      for (let v = 0; v < nk; v++) {
        const kl = lines[cursor];
        const toks = kl !== undefined ? kl.trim().split(/\s+/).map(Number) : [];
        if (toks.length < 4 || toks.some((t) => !Number.isFinite(t))) {
          problem(cursor + 1, `propagation vector ${v + 1} as "nv k1 k2 k3"`, (kl ?? "").trim());
          break;
        }
        // `+ 0` normalizes the writer's -0 artifact to +0 (as sliceByFields does).
        kVectors.push([toks[1]! + 0, toks[2]! + 0, toks[3]! + 0]);
        cursor++;
      }
    }
  }

  const reflections: FullProfIntReflection[] = [];
  let skipped = 0;
  let forwardBeamSkipped = 0;
  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("!")) continue;
    const v = sliceByFields(line, fields);
    const h = v[0]; const k = v[1]; const l = v[2];
    const base = hasK ? 4 : 3;
    const kIndex = hasK ? v[3] : undefined;
    const iObs = v[base]; const sigma = v[base + 1]; const code = v[base + 2];
    if (h == null || k == null || l == null || !Number.isInteger(h) || !Number.isInteger(k) || !Number.isInteger(l)) {
      skipped++;
      problem(i + 1, `integer h k l in the first ${hasK ? 4 : 3} fields of ${format}`, line.trimEnd());
      continue;
    }
    if (hasK && (kIndex == null || !Number.isInteger(kIndex) || kIndex < 1 || (kVectors !== undefined && kIndex > kVectors.length))) {
      skipped++;
      problem(i + 1, `a 1-based k index (nv ≤ ${kVectors?.length ?? "Nk"}) in field 4`, line.trimEnd());
      continue;
    }
    // The forward beam. A plain-format `0 0 0` row — or a k-variant row whose
    // propagation vector is zero — is not a Bragg reflection: refining it fits
    // k·|F(000)|² to a meaningless intensity (at unit weight when σ = 0, which
    // then wrecks the scale), and the σ-outlier filter can never reject a row
    // that has no σ. Opt-in (see `skipForwardBeam`): in a fundamental-indexed
    // magnetic file this row is the satellite at k. Recorded, never strict.
    if (opts.skipForwardBeam && h === 0 && k === 0 && l === 0) {
      const kv = hasK && kIndex != null ? kVectors?.[kIndex - 1] : undefined;
      if (!hasK || (kv !== undefined && kv.every((c) => c === 0))) {
        skipped++;
        forwardBeamSkipped++;
        problems.push({ line: i + 1, expected: "a Bragg reflection (0 0 0 is the forward beam — row skipped)", found: line.trimEnd() });
        continue;
      }
    }
    if (iObs == null) {
      skipped++;
      problem(i + 1, "a numeric intensity after the indices", line.trimEnd());
      continue;
    }
    reflections.push({
      h, k, l,
      iObs,
      ...(sigma != null && sigma > 0 ? { sigma } : {}),
      ...(hasK && kIndex != null ? { kIndex } : {}),
      ...(code != null && Number.isInteger(code) ? { code } : {}),
    });
  }

  return {
    reflections,
    ...(kVectors !== undefined && kVectors.length > 0 ? { kVectors } : {}),
    ...(wavelength !== undefined ? { wavelength } : {}),
    ...(itypdata !== undefined ? { itypdata } : {}),
    ...(ipow !== undefined ? { ipow } : {}),
    format,
    title,
    skipped,
    forwardBeamSkipped,
    problems,
  };
}
