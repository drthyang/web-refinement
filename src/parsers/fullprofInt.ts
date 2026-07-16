/**
 * Reader **and writer** for the FullProf **single-crystal integrated-intensity**
 * format (`.int`, `ABS(Irf) = 4`) — the reflection list produced by DataRed /
 * HB-3A / D9 / D19 pipelines and consumed by FullProf and Mag2Pol. Layout
 * (FullProf manual, "CODFILn.hkl, CODFIL.int or HKLn.hkl" section; verified
 * against real HB-3A files, 2026-07):
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
 * PENDING EXTERNAL VALIDATION: no golden currently exercises the k-vector
 * header against FullProf itself — the k path follows the manual + a real
 * HB-3A magnetic file (MnWO4, `(4i5,2f8.2,i4,3f8.2)`); cross-check an exported
 * file in FullProf before trusting it for publication (IMPROVEMENT_PLAN Phase 3).
 *
 * The field widths are taken from the *declared* Fortran format on line 2, so
 * the reader adapts to the width variants across datasets rather than assuming
 * fixed columns; the writer re-emits through the same declared format, making
 * parse → write byte-stable on files this writer produced.
 */

import type { SingleCrystalReflection } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";

/** One malformed-input diagnostic: where, what was expected, what was found. */
export interface FullProfIntProblem {
  /** 1-based line number in the input text. */
  readonly line: number;
  readonly expected: string;
  readonly found: string;
}

/** A parsed reflection row; satellites carry their 1-based k-list ordinal. */
export interface FullProfIntReflection extends SingleCrystalReflection {
  /** 1-based index into `kVectors`: this row is the satellite H + k[kIndex−1]. */
  readonly kIndex?: number;
  /** Scale-factor / domain code column (`cod`), when the format declares it. */
  readonly code?: number;
}

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
  /** Line-numbered diagnostics for every skipped/suspect input line. */
  readonly problems: FullProfIntProblem[];
}

/** One field of a Fortran format: column width, type, and (f/e/g) decimals. */
interface Field { readonly width: number; readonly kind: "i" | "f" | "e" | "g" | "a" | "x"; readonly decimals?: number; }

/**
 * Expand a Fortran format like `(3i4,2f8.2,i4,6f8.0)` into a flat field list
 * with column widths (and decimals, kept for re-emission). `nX` (blank) fields
 * are kept as skips so column offsets stay aligned. Descriptors other than
 * i/f/e/g/a/x are ignored.
 */
export function parseFortranFields(format: string): Field[] {
  const inner = format.trim().replace(/^\(/, "").replace(/\)\s*$/, "");
  const fields: Field[] = [];
  for (const rawTok of inner.split(",")) {
    const tok = rawTok.trim();
    // repeat? type-letter width [.decimals]
    const m = tok.match(/^(\d*)\s*([ifegax])\s*(\d+)?(?:\.(\d+))?/i);
    if (!m) continue;
    const repeat = m[1] ? parseInt(m[1], 10) : 1;
    const kind = m[2]!.toLowerCase() as Field["kind"];
    const width = m[3] ? parseInt(m[3], 10) : kind === "x" ? repeat : 0;
    const decimals = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
    if (kind === "x") { fields.push({ width: repeat, kind: "x" }); continue; }
    for (let r = 0; r < repeat; r++) fields.push({ width, kind, ...(decimals !== undefined ? { decimals } : {}) });
  }
  return fields;
}

/** Slice a line into values by fixed field widths (per the declared format). */
function sliceByFields(line: string, fields: readonly Field[]): (number | null)[] {
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

/** Count the leading consecutive integer fields (h k l [nv]) of a format. */
function leadingIntCount(fields: readonly Field[]): number {
  let n = 0;
  for (const f of fields) {
    if (f.kind === "x") continue;
    if (f.kind !== "i") break;
    n++;
  }
  return n;
}

export interface FullProfIntParseOptions {
  /** Throw on the first structural/row problem (line + expected vs found)
   *  instead of skipping — the paired-load path uses this so a malformed file
   *  is rejected loudly rather than silently truncated. Default false. */
  readonly strict?: boolean;
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
    problems,
  };
}

export interface FullProfIntWriteOptions {
  readonly title?: string;
  /** Wavelength (Å) for the R_lambda line. */
  readonly wavelength: number;
  /** Itypdata flag (0 = F²/σ(F²), 1 = F/σ(F)). Default 0. */
  readonly itypdata?: number;
  /** Ipow flag (0 single crystal / 1 twinned / 2 powder clusters). Default 0. */
  readonly ipow?: number;
  /**
   * Fortran format for the rows. Default `(3i4,2f8.2,i4)`, or `(4i4,2f8.2,i4)`
   * when `kVectors` are given (the extra leading integer is the nv column).
   * A parsed file's own `format` can be passed back for a stable round-trip.
   */
  readonly format?: string;
  /** Propagation vectors — written as the k-count + `nv k1 k2 k3` block, with
   *  each reflection's `kIndex` in the nv column (satellite = H + k_nv). */
  readonly kVectors?: readonly Vec3[];
}

/** Fixed-width emit of one value per field; throws when a value cannot fit. */
function emitField(value: number, f: Field): string {
  const s = f.kind === "i" ? String(Math.round(value)) : value.toFixed(f.decimals ?? 2);
  if (s.length > f.width) {
    throw new Error(`FullProf .int writer: value ${s} does not fit its ${f.kind}${f.width} field — widen the format`);
  }
  return s.padStart(f.width);
}

/**
 * Write a FullProf single-crystal `.int` file (plain or propagation-vector
 * variant). Rows are emitted through the declared Fortran format: h k l [nv]
 * I σ [cod]; declared trailing fields beyond `cod` are left empty (as real
 * DataRed files do), and blank/X descriptors are emitted as spaces so the
 * reader's fixed-width column offsets stay aligned. PENDING EXTERNAL VALIDATION
 * for the k variant (see the module header): cross-check in FullProf itself.
 */
export function writeFullProfInt(
  reflections: readonly FullProfIntReflection[],
  opts: FullProfIntWriteOptions,
): string {
  const hasK = opts.kVectors !== undefined && opts.kVectors.length > 0;
  const format = opts.format ?? (hasK ? "(4i4,2f8.2,i4)" : "(3i4,2f8.2,i4)");
  const fields = parseFortranFields(format); // keep X descriptors for offset-preserving output
  const nInt = leadingIntCount(fields);
  // The nv column is signalled by 4 leading integer fields; keep the format and
  // the kVectors consistent (both directions) so a mismatched call fails loudly
  // instead of silently mis-slicing the intensity into the nv slot.
  if (hasK && nInt < 4) throw new Error(`FullProf .int writer: k vectors given but the format ${format} declares only ${nInt} leading integer fields (need 4 for the nv column)`);
  if (!hasK && nInt >= 4) throw new Error(`FullProf .int writer: the format ${format} declares ${nInt} leading integer fields (an nv column) but no kVectors were given — the reader would expect a propagation-vector block`);

  const lines: string[] = [
    opts.title ?? "Crystal",
    format,
    `${opts.wavelength.toFixed(4)} ${opts.itypdata ?? 0} ${opts.ipow ?? 0}`,
  ];
  if (hasK) {
    lines.push(String(opts.kVectors!.length));
    opts.kVectors!.forEach((kv, i) => lines.push(`${i + 1} ${kv[0]} ${kv[1]} ${kv[2]}`));
  }

  for (const r of reflections) {
    const values: number[] = hasK
      ? [r.h, r.k, r.l, r.kIndex ?? 1, r.iObs, r.sigma ?? 0, r.code ?? 1]
      : [r.h, r.k, r.l, r.iObs, r.sigma ?? 0, r.code ?? 1];
    let row = "";
    let vi = 0;
    for (const f of fields) {
      if (f.kind === "x") { row += " ".repeat(f.width); continue; } // preserve blank columns
      if (vi >= values.length) break;
      row += emitField(values[vi]!, f);
      vi++;
    }
    lines.push(row);
  }
  return lines.join("\n") + "\n";
}
