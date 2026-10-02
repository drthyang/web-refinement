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

import type { PdfPattern, PdfPoint, PdfScatteringType, ReciprocalSpaceData } from "@/core/diffraction/types";
import { defaultTransformGrid, transformReciprocal } from "@/core/totalscattering/fourier";

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
 * Column indices for the abscissa (r or Q), the ordinate (G, S or F) and its
 * optional uncertainty (dG, dS or dF), from a `#L`/`#l` label line when
 * present (`#L r G(r) dr dG(r)`, PDFgetN's `#L Q S(Q) dQ dS(Q)`), else
 * positional defaults resolved against the observed column count.
 */
function resolveColumns(labelLine: string | undefined, ncol: number): { r: number; g: number; sigma: number } {
  if (labelLine) {
    const toks = labelLine.replace(/^#\s*l\b/i, "").trim().split(/\s+/);
    const find = (re: RegExp) => toks.findIndex((t) => re.test(t));
    const r = find(/^[rq](\(|$|\b)/i);
    const g = find(/^[gsf]/i);
    const sigma = find(/^d[gsf]/i); // dG/dS/dF; the dr/dQ abscissa-uncertainty column is ignored
    if (r >= 0 && g >= 0) return { r, g, sigma };
  }
  // Positional: r, G, [dr, dG] (4-col Mantid) or r, G, [dG] (3-col) or r, G.
  const sigma = ncol >= 4 ? 3 : ncol === 3 ? 2 : -1;
  return { r: 0, g: 1, sigma };
}

/** What a reduced total-scattering file contains: real-space G(r), or Q-space
 *  S(Q)/F(Q) (which the loader sine-transforms to G(r)). */
export type ReducedKind = "gr" | "sq" | "fq";

/**
 * Classify a reduced file, most authoritative signal first: the filename
 * extension, then an explicit header marker (PDFgetX3 `outputtype = …` or a
 * `#L` column label), then a numeric baseline heuristic — S(Q) oscillates
 * about 1 at high Q, F(Q)/G(r) about 0 (those two default to "gr", the safe
 * choice given F(Q) files essentially always carry the .fq extension).
 */
export function classifyReducedKind(text: string, filename = "", rows?: readonly (readonly number[])[]): ReducedKind {
  const ext = filename.match(/\.(gr|sgr|sq|fq)$/i)?.[1]?.toLowerCase();
  if (ext === "sq") return "sq";
  // RMCProfile's StoG writes its S(Q) to `.fq` files. Q·[S(Q) − 1] oscillates
  // about 0 at high Q and cannot settle FLAT at 1, so a `.fq` whose tail does
  // is S(Q) — misreading it as Q[S−1] would multiply the whole signal by Q.
  if (ext === "fq") return rows && flatUnitTail(rows) ? "sq" : "fq";
  if (ext === "gr" || ext === "sgr") return "gr";
  const head = text.slice(0, 1200);
  const out = head.match(/outputtype\s*=\s*(gr|sq|fq)/i)?.[1]?.toLowerCase();
  if (out === "sq" || out === "fq" || out === "gr") return out;
  if (/#\s*l\s+q\b.*\bs\s*\(\s*q/i.test(head)) return "sq";
  if (/#\s*l\s+q\b.*\bf\s*\(\s*q/i.test(head)) return "fq";
  if (/#\s*l\s+r\b/i.test(head)) return "gr";
  // Baseline heuristic over the last quarter of the table: S(Q) → ⟨y⟩ ≈ 1.
  if (rows && rows.length > 8) {
    const tail = rows.slice(Math.floor(rows.length * 0.75));
    const mean = tail.reduce((s, r) => s + (r[1] ?? 0), 0) / tail.length;
    if (Math.abs(mean - 1) < 0.15) return "sq";
  }
  return "gr";
}

/**
 * The last quarter of the ordinate column sits flat at 1: both halves of it
 * average within 0.15 of 1 and within 0.05 of each other. The flatness test
 * keeps a mis-normalized F(Q) (which ramps linearly with Q) from passing.
 */
function flatUnitTail(rows: readonly (readonly number[])[]): boolean {
  if (rows.length <= 8) return false;
  const tail = rows.slice(Math.floor(rows.length * 0.75));
  const half = Math.floor(tail.length / 2);
  const mean = (xs: readonly (readonly number[])[]): number => xs.reduce((s, r) => s + (r[1] ?? 0), 0) / xs.length;
  const a = mean(tail.slice(0, half));
  const b = mean(tail.slice(half));
  return Math.abs(a - 1) < 0.15 && Math.abs(b - 1) < 0.15 && Math.abs(a - b) < 0.05;
}

/** An S(Q) export named for its content: `PG3_55526_SQ.dat`, `sample_SofQ.txt`, `nom.s_of_q`. */
const SQ_NAME = /(^|[^a-z])(s_?of_?q|sq)([^a-z]|$)/i;

/** Numeric rows (≥ 2 columns) of a text table, for content checks. */
function numericRows(text: string): number[][] {
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === "" || /^[#!]/.test(t)) continue;
    const nums = t.split(/[\s,]+/).map(Number);
    if (nums.length >= 2 && nums.every(Number.isFinite)) rows.push(nums);
  }
  return rows;
}

/** True if `text`/`filename` looks like a reduced-PDF file (for format routing). */
export function looksLikePdf(text: string, filename = ""): boolean {
  if (/\.(gr|sgr|sq|fq)$/i.test(filename)) return true;
  // Mantid/ADDIE S(Q) exports (`# X Y E`, `.dat`) carry no PDF header at all:
  // route them by a name that SAYS S(Q) and an ordinate that settles flat at 1
  // — both, so neither a powder file called "SQ" nor a stray baseline-1 table
  // is captured.
  if (SQ_NAME.test(filename.replace(/\.[^.]+$/, "")) && flatUnitTail(numericRows(text))) return true;
  const head = text.slice(0, 800);
  return (
    /diffpy\.pdfgetx/i.test(head) ||
    /pdf\s+from\s+mantid/i.test(head) ||
    /outputtype\s*=\s*(gr|sq|fq)/i.test(head) ||
    /#\s*l\s+r\b.*\bg\(/i.test(head) ||
    /#\s*l\s+q\b.*\b[sf]\s*\(\s*q/i.test(head) || // S(Q)/F(Q) column labels
    /g\(\s*å?\s*\$?\^?\{?-?2/i.test(head) // G(Å^-2) ordinate label
  );
}

/**
 * The parsed Q-space rows as {@link ReciprocalSpaceData}: sorted by Q with
 * duplicate Q dropped (the transform needs a strictly ascending grid), and the
 * error column kept only when it is a usable one — every value finite and
 * ≥ 0 and at least one positive (Mantid writes an all-zero E column when it has
 * no errors, which is "no information", not "exact data").
 */
function reciprocalFromPoints(kind: "sq" | "fq", points: readonly PdfPoint[]): ReciprocalSpaceData {
  const sorted = [...points].sort((a, b) => a.r - b.r);
  const kept: PdfPoint[] = [];
  for (const p of sorted) if (kept.length === 0 || p.r > kept[kept.length - 1]!.r) kept.push(p);
  const q = kept.map((p) => p.r);
  const y = kept.map((p) => p.gObs);
  const sig = kept.map((p) => p.sigma);
  const usable = sig.every((v) => v !== undefined && Number.isFinite(v) && v >= 0) && sig.some((v) => v! > 0);
  return usable ? { kind, q, y, sigma: sig as number[] } : { kind, q, y };
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

  const scatteringType = opts.scatteringType ?? detectScatteringType(header);

  // Q-space data (S(Q)/F(Q)): sine-transform to G(r) at load time so the app's
  // entry point is uniform — any reduced file lands on a fittable G(r). The
  // data's own Q window becomes the model's termination Qmax (header bounds,
  // when present, win over the raw extent — PDFgetX3 files can carry data past
  // the qmax it would itself transform with). The ORIGINAL S(Q)/F(Q) — with its
  // error column, when the reduction wrote one — is retained on the pattern, and
  // σ_G(r) is propagated exactly through the same operator (fourier.ts).
  const kind = classifyReducedKind(text, opts.filename ?? "", rows);
  if (kind !== "gr" && points.length >= 8) {
    const reciprocal = reciprocalFromPoints(kind, points);
    const qLast = reciprocal.q[reciprocal.q.length - 1]!;
    const qmaxEff = meta["qmax"] ?? qLast;
    const qminEff = meta["qmin"] ?? 0;
    const rGrid = defaultTransformGrid();
    // A header window holding fewer than two nodes is a broken header, not a
    // reason to refuse the file: fall back to the data's own extent.
    let t: ReturnType<typeof transformReciprocal>;
    try {
      t = transformReciprocal(reciprocal, rGrid, { qmin: qminEff, qmax: qmaxEff });
    } catch {
      t = transformReciprocal(reciprocal, rGrid);
    }
    const sigma = t.sigma;
    return {
      id,
      name,
      scatteringType,
      points: rGrid.map((r, i) => (sigma ? { r, gObs: t.g[i]!, sigma: sigma[i]! } : { r, gObs: t.g[i]! })),
      qmax: qmaxEff,
      ...(qminEff > 0 ? { qmin: qminEff } : {}),
      ...(meta["qdamp"] !== undefined ? { qdamp: meta["qdamp"] } : {}),
      ...(meta["qbroad"] !== undefined ? { qbroad: meta["qbroad"] } : {}),
      rstep: 0.01,
      ...(composition ? { composition } : {}),
      sourceKind: kind,
      reciprocal,
      transform: { qmin: t.op.qmin, qmax: t.op.qmax, modification: t.op.modification, lowQ: t.op.lowQ },
    };
  }

  return {
    id,
    name,
    scatteringType,
    points,
    ...meta,
    ...(composition ? { composition } : {}),
    sourceKind: "gr",
  };
}
