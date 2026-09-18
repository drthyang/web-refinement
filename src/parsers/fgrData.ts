/**
 * PDFgui / PDFfit2 fit-output (`.fgr`) reader.
 *
 * An .fgr is not observed data — it is the *saved fit* PDFgui writes next to a
 * refinement: a `##### PDFgui fit` header carrying the refined reduction /
 * profile constants, then a five-column table
 *
 *   #L r(A)  G(r)  d_r  d_Gr  Gdiff
 *
 * where **G(r) is the CALCULATED nuclear curve** (it extends smoothly below
 * `fitrmin`, where an observed G(r) would ride the −4πρ₀r ramp) and Gdiff is
 * the observed − calculated residual. The observed pattern is their sum.
 *
 * Two consumers, hence two signals: `"observed"` rebuilds G_obs = G_calc +
 * G_diff (fit the total curve here); `"difference"` exposes the residual
 * itself — for a neutron fit against a nuclear-only model this is the
 * magnetic PDF signal, the quantity `diffpy.mpdf`'s fitting examples read from
 * exactly this file kind (`getDiffData`). The generic `.gr` reader must NOT be
 * used on these files: its column heuristics land on the calculated curve.
 *
 * Pure `string → data`; no DOM, no side effects.
 */

import type { PdfPattern, PdfPoint, PdfScatteringType } from "@/core/diffraction/types";

/** A parsed PDFgui fit export: refined-fit metadata plus the three curves. */
export interface FgrFit {
  readonly scatteringType: PdfScatteringType;
  /** Fourier-termination Qmax of the reduction (Å⁻¹). */
  readonly qmax?: number;
  /** Refined instrument damping Qdamp (Å⁻¹) of the NUCLEAR fit. */
  readonly qdamp?: number;
  /** Refined r-dependent broadening Qbroad (Å⁻¹) of the nuclear fit. */
  readonly qbroad?: number;
  /** Refined PDF scale of the nuclear fit (PDFgui `dscale`). */
  readonly dscale?: number;
  /** Nuclear-fit window (Å) — the range G(r)calc was refined over. */
  readonly fitrmin?: number;
  readonly fitrmax?: number;
  readonly r: number[];
  /** PDFgui's calculated nuclear G(r) (the file's `G(r)` column). */
  readonly gCalc: number[];
  /** Observed − calculated residual (the `Gdiff` column). */
  readonly gDiff: number[];
  /** Reconstructed observed curve: gCalc + gDiff. */
  readonly gObs: number[];
}

/** Which curve {@link fgrToPattern} exposes as the pattern's `gObs`. */
export type FgrSignal = "observed" | "difference";

/** True if `text`/`filename` is a PDFgui fit export (for format routing). */
export function looksLikeFgr(text: string, filename = ""): boolean {
  if (/\.fgr$/i.test(filename)) return true;
  const head = text.slice(0, 800);
  return /#{2,}\s*PDFgui fit/i.test(head) || /#\s*l\s+r\s*\(a\)\s+g\(r\)\s+d_r\s+d_gr\s+gdiff/i.test(head);
}

function num(header: string, re: RegExp): number | undefined {
  const m = header.match(re);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

/** Parse a PDFgui .fgr fit export. Tolerant of malformed rows (skipped). */
export function parseFgr(text: string): FgrFit {
  const lines = text.split(/\r?\n/);
  const headerParts: string[] = [];
  let labelLine: string | undefined;
  const rows: number[][] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (/^#\s*l\b/i.test(line)) {
      labelLine = line;
      continue;
    }
    const startsNumeric = /^[+-]?\.?\d/.test(line.split(/\s+/)[0] ?? "");
    if (!startsNumeric || line.startsWith("#")) {
      headerParts.push(line);
      continue;
    }
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 2 && nums.every(Number.isFinite)) rows.push(nums);
  }
  const header = headerParts.join("\n");

  // Column indices from the #L line when present, else the canonical layout.
  let cR = 0, cG = 1, cDiff = 4;
  if (labelLine) {
    const toks = labelLine.replace(/^#\s*l\b/i, "").trim().split(/\s+/);
    const r = toks.findIndex((t) => /^r(\(|$)/i.test(t));
    const g = toks.findIndex((t) => /^g\s*\(/i.test(t) || /^g$/i.test(t));
    const d = toks.findIndex((t) => /^gdiff/i.test(t));
    if (r >= 0 && g >= 0) { cR = r; cG = g; cDiff = d; }
  }

  const r: number[] = [];
  const gCalc: number[] = [];
  const gDiff: number[] = [];
  const gObs: number[] = [];
  for (const row of rows) {
    const rv = row[cR];
    const gv = row[cG];
    if (rv === undefined || gv === undefined) continue;
    // Without a Gdiff column the residual is 0 and "observed" degrades to the
    // calculated curve — parseable, but flagged by the zero gDiff.
    const dv = cDiff >= 0 ? row[cDiff] ?? 0 : 0;
    r.push(rv);
    gCalc.push(gv);
    gDiff.push(dv);
    gObs.push(gv + dv);
  }

  const stype = header.match(/stype\s*=\s*([NX])/i)?.[1]?.toUpperCase();
  const scatteringType: PdfScatteringType =
    stype === "N" || (!stype && /neutron/i.test(header)) ? "neutron" : "xray";

  const qmax = num(header, /(?:^|[^a-z])qmax\s*=\s*([0-9.eE+-]+)/im);
  const qdamp = num(header, /(?:^|[^a-z])qdamp\s*=\s*([0-9.eE+-]+)/im);
  const qbroad = num(header, /(?:^|[^a-z])qbroad\s*=\s*([0-9.eE+-]+)/im);
  const dscale = num(header, /(?:^|[^a-z])dscale\s*=\s*([0-9.eE+-]+)/im);
  const fitrmin = num(header, /fitrmin\s*=\s*([0-9.eE+-]+)/i);
  const fitrmax = num(header, /fitrmax\s*=\s*([0-9.eE+-]+)/i);

  return {
    scatteringType,
    ...(qmax !== undefined ? { qmax } : {}),
    ...(qdamp !== undefined ? { qdamp } : {}),
    ...(qbroad !== undefined ? { qbroad } : {}),
    ...(dscale !== undefined ? { dscale } : {}),
    ...(fitrmin !== undefined ? { fitrmin } : {}),
    ...(fitrmax !== undefined ? { fitrmax } : {}),
    r, gCalc, gDiff, gObs,
  };
}

export interface FgrToPatternOptions {
  readonly name?: string;
  readonly id?: string;
  readonly filename?: string;
  /** "observed" (default): gObs = Gcalc + Gdiff. "difference": the residual. */
  readonly signal?: FgrSignal;
}

/** Materialize one of the .fgr curves as a fittable {@link PdfPattern}. */
export function fgrToPattern(fgr: FgrFit, opts: FgrToPatternOptions = {}): PdfPattern {
  const signal: FgrSignal = opts.signal ?? "observed";
  const y = signal === "difference" ? fgr.gDiff : fgr.gObs;
  const points: PdfPoint[] = fgr.r.map((r, i) => ({ r, gObs: y[i]! }));
  const stem = opts.name ?? opts.filename?.replace(/\.[^.]+$/, "") ?? "PDFgui fit";
  const name = signal === "difference" ? `${stem} (Gdiff)` : stem;
  const id = opts.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const rstep = fgr.r.length >= 2 ? Number((fgr.r[1]! - fgr.r[0]!).toFixed(6)) : undefined;
  return {
    id,
    name,
    scatteringType: fgr.scatteringType,
    points,
    // The refined nuclear-fit constants ride along as the pattern's metadata —
    // the right seeds for re-fitting the observed curve. A difference-signal
    // consumer (mPDF) typically overrides qdamp with its own damping.
    ...(fgr.qmax !== undefined ? { qmax: fgr.qmax } : {}),
    ...(fgr.qdamp !== undefined ? { qdamp: fgr.qdamp } : {}),
    ...(fgr.qbroad !== undefined ? { qbroad: fgr.qbroad } : {}),
    ...(rstep !== undefined ? { rstep } : {}),
    sourceKind: signal === "difference" ? "fgr-diff" : "fgr",
  };
}
