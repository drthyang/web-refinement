/**
 * Reduced pair-distribution-function (`.gr` / `.sq` / `.fq`) reader.
 *
 * PDF fitting consumes an *already reduced* G(r) (like PDFgui / DiffPy — the raw
 * intensity → S(Q) → G(r) reduction is a separate discipline, deferred; see
 * PDF_MPDF_ROADMAP §3.6). This parser reads the two real-world header dialects
 * we validate against:
 *
 *   1. **diffpy PDFgetX3** — an INI-style `key = value` config block
 *      (`mode = xray`, `composition = Ga Nb4 Se8`, `qmax = 28`, `qmaxinst`,
 *      `rpoly`, `rstep`, …) followed by `#### start data` and a two-column
 *      `r  G(r)` table (properly normalized, O(1)).
 *   2. **Mantid** (POWGEN) — a SPEC-style header (`#Comment: neutron, Qmin=…,
 *      Qmax=…`, `#L r G(r) dr dG(r)`) and a four-column table (G scaled by the
 *      instrument, absorbed by the fit scale).
 *
 * Both reduce to the same shape: `#`/label/blank lines are metadata, numeric rows
 * are data (col 0 = r, col 1 = G, optional dG column), and a `#L` column-label
 * line — when present — names the columns authoritatively.
 *
 * Pure `string → PdfPattern`; no DOM, no side effects.
 */

import type { PdfPattern, PdfPoint, PdfScatteringType } from "@/core/diffraction/types";

export interface ParsePdfOptions {
  /** Display name; defaults to the filename or "PDF pattern". */
  readonly name?: string;
  /** Dataset id; defaults to a slug of the name. */
  readonly id?: string;
  /** Source filename, used for the name default and scattering-type hints. */
  readonly filename?: string;
  /** Force the scattering type instead of detecting it from the header. */
  readonly scatteringType?: PdfScatteringType;
}

/** First finite number captured by `re` (group 1), or undefined. */
function num(header: string, re: RegExp): number | undefined {
  const m = header.match(re);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

/** Detect neutron vs X-ray from the header; explicit `mode=` wins over keywords. */
function detectScatteringType(header: string): PdfScatteringType {
  if (/\bmode\s*[=:]\s*neutron/i.test(header)) return "neutron";
  if (/\bmode\s*[=:]\s*x-?ray/i.test(header)) return "xray";
  if (/\bneutron/i.test(header)) return "neutron";
  if (/\bx-?ray/i.test(header)) return "xray";
  return "xray"; // synchrotron PDF is the common default; caller can override
}

/**
 * Column indices for r, G, and (optional) dG, from a `#L`/`#l` label line when
 * present, else positional defaults resolved against the observed column count.
 */
function resolveColumns(labelLine: string | undefined, ncol: number): { r: number; g: number; sigma: number } {
  if (labelLine) {
    const toks = labelLine.replace(/^#\s*l\b/i, "").trim().split(/\s+/);
    const find = (re: RegExp) => toks.findIndex((t) => re.test(t));
    const r = find(/^r(\(|$|\b)/i);
    const g = find(/^g/i);
    const sigma = find(/^dg/i); // dG(r); the dr column (r-uncertainty) is ignored
    if (r >= 0 && g >= 0) return { r, g, sigma };
  }
  // Positional: r, G, [dr, dG] (4-col Mantid) or r, G, [dG] (3-col) or r, G.
  const sigma = ncol >= 4 ? 3 : ncol === 3 ? 2 : -1;
  return { r: 0, g: 1, sigma };
}

/** True if `text`/`filename` looks like a reduced-PDF file (for format routing). */
export function looksLikePdf(text: string, filename = ""): boolean {
  if (/\.(gr|sgr|sq|fq)$/i.test(filename)) return true;
  const head = text.slice(0, 800);
  return (
    /diffpy\.pdfgetx/i.test(head) ||
    /pdf\s+from\s+mantid/i.test(head) ||
    /outputtype\s*=\s*gr/i.test(head) ||
    /#\s*l\s+r\b.*\bg\(/i.test(head) ||
    /g\(\s*å?\s*\$?\^?\{?-?2/i.test(head) // G(Å^-2) ordinate label
  );
}

/** Parse a reduced-PDF file into a {@link PdfPattern}. Never throws on data rows. */
export function parsePdfData(text: string, opts: ParsePdfOptions = {}): PdfPattern {
  const lines = text.split(/\r?\n/);
  const headerParts: string[] = [];
  let labelLine: string | undefined;
  const rows: number[][] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^#\s*l\b/i.test(line)) {
      labelLine = line;
      headerParts.push(line);
      continue;
    }
    const firstTok = line.split(/[\s,]+/)[0] ?? "";
    const startsNumeric = /^[+-]?\.?\d/.test(firstTok);
    if (!startsNumeric || line.startsWith("#") || line.startsWith("!")) {
      headerParts.push(line);
      continue;
    }
    const nums = line.split(/[\s,]+/).map(Number);
    if (nums.length >= 2 && Number.isFinite(nums[0]!) && Number.isFinite(nums[1]!)) {
      rows.push(nums);
    }
  }

  const header = headerParts.join("\n");
  const cols = resolveColumns(labelLine, rows[0]?.length ?? 2);

  const points: PdfPoint[] = [];
  for (const row of rows) {
    const r = row[cols.r];
    const g = row[cols.g];
    if (r === undefined || g === undefined || !Number.isFinite(r) || !Number.isFinite(g)) continue;
    const s = cols.sigma >= 0 ? row[cols.sigma] : undefined;
    points.push(s !== undefined && Number.isFinite(s) ? { r, gObs: g, sigma: s } : { r, gObs: g });
  }

  const name = opts.name ?? opts.filename?.replace(/\.[^.]+$/, "") ?? "PDF pattern";
  const id = opts.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const composition = header.match(/composition\s*=\s*([^\n#]+)/i)?.[1]?.trim();
  const rstep =
    num(header, /rstep\s*[=:]\s*([0-9.eE+-]+)/i) ??
    (points.length >= 2 ? Number((points[1]!.r - points[0]!.r).toFixed(6)) : undefined);

  // "qmaxinst" is matched by its own key; the `[^a-z]`/start anchor on the `qmax`
  // pattern stops it from swallowing the `qmaxinst = …` line.
  const meta: Record<string, number> = {};
  const put = (key: string, value: number | undefined) => {
    if (value !== undefined) meta[key] = value;
  };
  put("qmax", num(header, /(?:^|[^a-z])q\s*max\s*[=:]\s*([0-9.eE+-]+)/im));
  put("qmin", num(header, /(?:^|[^a-z])q\s*min\s*[=:]\s*([0-9.eE+-]+)/im));
  put("qmaxInst", num(header, /qmaxinst\s*[=:]\s*([0-9.eE+-]+)/i));
  put("qdamp", num(header, /(?:^|[^a-z])qdamp\s*[=:]\s*([0-9.eE+-]+)/i));
  put("qbroad", num(header, /(?:^|[^a-z])qbroad\s*[=:]\s*([0-9.eE+-]+)/i));
  put("rpoly", num(header, /rpoly\s*[=:]\s*([0-9.eE+-]+)/i));
  if (rstep !== undefined) put("rstep", rstep);

  return {
    id,
    name,
    scatteringType: opts.scatteringType ?? detectScatteringType(header),
    points,
    ...meta,
    ...(composition ? { composition } : {}),
  };
}
