/**
 * The FullProf **single-crystal integrated-intensity** format (`.int`,
 * `ABS(Irf) = 4`): its reflection type, its Fortran-format field machinery, and
 * the **writer**. Pure string/number producers — no DOM, no parser layer.
 *
 * The matching reader lives in [`src/parsers/fullprofInt.ts`](../../parsers/fullprofInt.ts)
 * and imports the field machinery from here, which is the allowed direction:
 * `src/parsers` may depend on `src/core`, never the reverse (ARCHITECTURE.md
 * "the golden rule"). Reader and writer therefore slice and emit through the
 * SAME declared-format expansion, which is what makes parse → write byte-stable
 * on files this writer produced.
 *
 * Layout (FullProf manual, "CODFILn.hkl, CODFIL.int or HKLn.hkl" section;
 * verified against real HB-3A files, 2026-07):
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
 * reflection H + k_nv. The k variant is signalled by four leading integer
 * fields (`4i…`) in the declared format; three mean a plain nuclear file.
 *
 * PENDING EXTERNAL VALIDATION: no golden currently exercises the k-vector
 * header against FullProf itself — the k path follows the manual + a real
 * HB-3A magnetic file (MnWO4, `(4i5,2f8.2,i4,3f8.2)`); cross-check an exported
 * file in FullProf before trusting it for publication (IMPROVEMENT_PLAN Phase 3).
 */

import type { SingleCrystalReflection } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";

/** A `.int` reflection row; satellites carry their 1-based k-list ordinal. */
export interface FullProfIntReflection extends SingleCrystalReflection {
  /** 1-based index into `kVectors`: this row is the satellite H + k[kIndex−1]. */
  readonly kIndex?: number;
  /** Scale-factor / domain code column (`cod`), when the format declares it. */
  readonly code?: number;
}

/** One field of a Fortran format: column width, type, and (f/e/g) decimals. */
export interface FullProfIntField {
  readonly width: number;
  readonly kind: "i" | "f" | "e" | "g" | "a" | "x";
  readonly decimals?: number;
}

/**
 * Expand a Fortran format like `(3i4,2f8.2,i4,6f8.0)` into a flat field list
 * with column widths (and decimals, kept for re-emission). `nX` (blank) fields
 * are kept as skips so column offsets stay aligned. Descriptors other than
 * i/f/e/g/a/x are ignored.
 */
export function parseFortranFields(format: string): FullProfIntField[] {
  const inner = format.trim().replace(/^\(/, "").replace(/\)\s*$/, "");
  const fields: FullProfIntField[] = [];
  for (const rawTok of inner.split(",")) {
    const tok = rawTok.trim();
    // repeat? type-letter width [.decimals]
    const m = tok.match(/^(\d*)\s*([ifegax])\s*(\d+)?(?:\.(\d+))?/i);
    if (!m) continue;
    const repeat = m[1] ? parseInt(m[1], 10) : 1;
    const kind = m[2]!.toLowerCase() as FullProfIntField["kind"];
    const width = m[3] ? parseInt(m[3], 10) : kind === "x" ? repeat : 0;
    const decimals = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
    if (kind === "x") { fields.push({ width: repeat, kind: "x" }); continue; }
    for (let r = 0; r < repeat; r++) fields.push({ width, kind, ...(decimals !== undefined ? { decimals } : {}) });
  }
  return fields;
}

/** Count the leading consecutive integer fields (h k l [nv]) of a format. */
export function leadingIntCount(fields: readonly FullProfIntField[]): number {
  let n = 0;
  for (const f of fields) {
    if (f.kind === "x") continue;
    if (f.kind !== "i") break;
    n++;
  }
  return n;
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
function emitField(value: number, f: FullProfIntField): string {
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
