/**
 * Reader for the FullProf **single-crystal integrated-intensity** format
 * (`.int`) — the reflection list produced from HB-3A/DEMAND, D9/D19, and other
 * single-crystal instruments and refined by FullProf/JANA. Layout:
 *
 *   line 1 : title  (e.g. "Crystal")
 *   line 2 : Fortran format, e.g. `(3i4,2f8.2,i4,6f8.0)`
 *   line 3 : wavelength  [flags…]
 *   data   : one reflection per line, fixed-width per the declared format:
 *            h k l  I  σ(I)  [domain]  [6 geometry columns]
 *
 * The intensities are integrated I ∝ |F|² (σ is σ(I)); the trailing columns are
 * per-reflection geometry (domain code + direction cosines) used by FullProf for
 * absorption/extinction and, for magnetic data, the interaction geometry — not
 * needed for a nuclear F² refinement, which uses only h k l I σ.
 *
 * The field widths are taken from the *declared* Fortran format on line 2, so
 * the reader adapts to the format variants across datasets rather than assuming
 * fixed columns. Reference: FullProf manual (Rodríguez-Carvajal), single-crystal
 * job (Cry = 1) `.int` input.
 */

import type { SingleCrystalReflection } from "@/core/diffraction/types";

export interface FullProfIntParse {
  readonly reflections: SingleCrystalReflection[];
  /** Wavelength (Å) from line 3, if present. */
  readonly wavelength?: number;
  readonly title: string;
  /** Rows skipped as unparseable (diagnostic). */
  readonly skipped: number;
}

/** One field of a Fortran format: its column width and type. */
interface Field { readonly width: number; readonly kind: "i" | "f" | "e" | "g" | "a" | "x"; }

/**
 * Expand a Fortran format like `(3i4,2f8.2,i4,6f8.0)` into a flat field list
 * with column widths. `nX` (blank) fields are kept as skips so column offsets
 * stay aligned. Descriptors other than i/f/e/g/a/x are ignored.
 */
export function parseFortranFields(format: string): Field[] {
  const inner = format.trim().replace(/^\(/, "").replace(/\)\s*$/, "");
  const fields: Field[] = [];
  for (const rawTok of inner.split(",")) {
    const tok = rawTok.trim();
    // repeat? type-letter width [.decimals]
    const m = tok.match(/^(\d*)\s*([ifegax])\s*(\d+)?/i);
    if (!m) continue;
    const repeat = m[1] ? parseInt(m[1], 10) : 1;
    const kind = m[2]!.toLowerCase() as Field["kind"];
    const width = m[3] ? parseInt(m[3], 10) : kind === "x" ? repeat : 0;
    if (kind === "x") { fields.push({ width: repeat, kind: "x" }); continue; }
    for (let r = 0; r < repeat; r++) fields.push({ width, kind });
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
    out.push(Number.isFinite(v) ? v : null);
  }
  return out;
}

const FORMAT_RE = /^\s*\([0-9ifegaxIFEGAX.,\s]+\)\s*$/;

/** True for text that looks like a FullProf single-crystal `.int` file. */
export function looksLikeFullProfInt(text: string): boolean {
  const lines = text.split(/\r?\n/, 6);
  return lines.some((l) => FORMAT_RE.test(l) && /[if]\d/i.test(l));
}

/**
 * Parse a FullProf single-crystal `.int` file. Reads h k l I σ(I) via the
 * declared Fortran format; trailing geometry columns are ignored. Reflections
 * with non-finite h/k/l or a non-positive σ default handled downstream.
 */
export function parseFullProfInt(text: string): FullProfIntParse {
  const lines = text.split(/\r?\n/);
  const title = (lines[0] ?? "").trim();

  // Locate the Fortran format line and the wavelength line just after it.
  let fmtIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (FORMAT_RE.test(lines[i]!) && /[if]\d/i.test(lines[i]!)) { fmtIdx = i; break; }
  }
  if (fmtIdx < 0) throw new Error("FullProf .int: no Fortran format line found");
  const fields = parseFortranFields(lines[fmtIdx]!);

  // Wavelength: first number on the line after the format.
  let wavelength: number | undefined;
  let dataStart = fmtIdx + 1;
  const waveLine = lines[fmtIdx + 1];
  if (waveLine !== undefined) {
    const w = Number(waveLine.trim().split(/\s+/)[0]);
    if (Number.isFinite(w) && w > 0 && w < 100) { wavelength = w; dataStart = fmtIdx + 2; }
  }

  const reflections: SingleCrystalReflection[] = [];
  let skipped = 0;
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const v = sliceByFields(line, fields);
    const h = v[0]; const k = v[1]; const l = v[2]; const iObs = v[3]; const sigma = v[4];
    if (h == null || k == null || l == null || !Number.isInteger(h) || !Number.isInteger(k) || !Number.isInteger(l)) {
      skipped++;
      continue;
    }
    if (iObs == null) { skipped++; continue; }
    reflections.push({
      h, k, l,
      iObs,
      ...(sigma != null && sigma > 0 ? { sigma } : {}),
    });
  }

  return { reflections, ...(wavelength !== undefined ? { wavelength } : {}), title, skipped };
}
