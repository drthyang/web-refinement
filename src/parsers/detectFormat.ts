/**
 * Robust format resolver for loaded diffraction data.
 *
 * One decision point classifies a file into **data type** (powder vs single
 * crystal) and, for powder, its **x-axis unit** (2θ, Q, d-spacing, or TOF). The
 * resolver follows a priority chain — most authoritative signal first — so the
 * result is never a silent guess:
 *
 *   1. an explicit user OVERRIDE (from the UI);
 *   2. an explicit UNIT in the file HEADER / column labels;
 *   3. the loaded INSTRUMENT file (authoritative for constant-wavelength vs TOF);
 *   4. a FILENAME / format pattern;
 *   5. a numeric-RANGE heuristic (last resort, low confidence).
 *
 * Every result carries `source`, `confidence`, and a human-readable `note`, so
 * the UI can show how the unit was decided and offer an override. This mirrors
 * the filename-plus-header detection used across the sibling apps (rmc-toolkits'
 * `detect_plot_kind` / `bragg_is_tof`).
 */

import type { PowderXUnit, Radiation } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";

export type DataType = "powder" | "single-crystal";
export type DetectionSource = "override" | "header" | "instrument" | "filename" | "heuristic";

export interface DetectedFormat {
  readonly dataType: DataType;
  /** Powder abscissa unit. Meaningless (defaulted) for single-crystal data. */
  readonly xUnit: PowderXUnit;
  readonly radiation: Radiation;
  /** How the primary (unit / type) decision was reached. */
  readonly source: DetectionSource;
  readonly confidence: "high" | "medium" | "low";
  /** Human-readable explanation shown in the UI. */
  readonly note: string;
}

export interface DetectInput {
  readonly text: string;
  readonly filename: string;
  readonly instrument?: InstrumentParameters | undefined;
  readonly override?: { dataType?: DataType; xUnit?: PowderXUnit } | undefined;
}

const DEFAULT_WAVELENGTH = 1.54;

/** Non-numeric header/comment lines within the first `n` lines, lower-cased. */
function headerLines(text: string, n = 25): string {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < n; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    // A line with no digit-led numeric token is treated as header/label text.
    const firstTok = line.split(/[\s,]+/)[0] ?? "";
    if (!/^[+-]?\.?\d/.test(firstTok) || /[a-zµåΑ-Ωα-ω]/i.test(line.replace(/e[+-]?\d/gi, ""))) {
      out.push(line.toLowerCase());
    }
  }
  return out.join("\n");
}

/** First numeric tokens per data row (skips comments/blank/label lines). */
function numericRows(text: string, max = 200): number[][] {
  const rows: number[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const toks = line.split(/[\s,]+/);
    const nums = toks.map(Number);
    // Require the first token to be a finite number to count as a data row.
    if (nums.length >= 2 && Number.isFinite(nums[0]!) && Number.isFinite(nums[1]!)) {
      rows.push(nums);
      if (rows.length >= max) break;
    }
  }
  return rows;
}

/** A GSAS-II CSV pattern export — a definitively recognizable TOF histogram. */
export function isGsasCsvPattern(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return /(^|\n)\s*"?limits"?\s*,/.test(head) || (/(^|,)\s*"?obs"?\s*,/.test(head) && head.includes("calc"));
}

/** Reflection list if most sampled rows begin with three integer Miller indices. */
export function looksLikeReflectionList(text: string): boolean {
  if (/reflection list|fo\*\*2|fc\*\*2/i.test(text)) return true;
  const rows = numericRows(text, 40);
  if (rows.length < 3) return false;
  const isIntTriple = (r: number[]) =>
    r.length >= 4 &&
    Number.isInteger(r[0]!) && Number.isInteger(r[1]!) && Number.isInteger(r[2]!) &&
    // Miller indices are small; guard against 3 large integers that are really data.
    Math.abs(r[0]!) < 100 && Math.abs(r[1]!) < 100 && Math.abs(r[2]!) < 100;
  const frac = rows.filter(isIntTriple).length / rows.length;
  return frac > 0.8;
}

/** Scan header/label text for an explicit x-unit keyword. */
function unitFromHeader(header: string): PowderXUnit | null {
  if (/\b(tof|flight|time[- ]?of[- ]?flight)\b|µs|microsec|\busec\b/.test(header)) return "tof";
  if (/2[-\s]?theta|two[-\s]?theta|2θ|\bttheta\b|\bdeg(ree)?s?\b/.test(header)) return "twoTheta";
  if (/d[-\s]?spac|\bd[-\s]?spacing\b|\bd\s*\(|\bd\/a\b/.test(header)) return "dSpacing";
  if (/\bq\b|q[-\s]?space|momentum transfer|a\^?-?1|å\^?-?1|å⁻¹|angstrom\^?-?1/.test(header)) return "q";
  return null;
}

/** Numeric-range heuristic. Ambiguous by nature — always low confidence. */
function unitFromRange(rows: number[][]): { xUnit: PowderXUnit; note: string } {
  const xs = rows.map((r) => r[0]!).filter(Number.isFinite);
  const xMax = Math.max(...xs);
  const xMin = Math.min(...xs);
  if (xMax > 1000) return { xUnit: "tof", note: `x up to ${xMax.toFixed(0)} — reads as TOF (µs)` };
  if (xMax > 40) return { xUnit: "twoTheta", note: `x up to ${xMax.toFixed(1)} — reads as 2θ (°)` };
  // xMax ≤ ~40: genuinely ambiguous between Q (Å⁻¹), 2θ, and d (Å).
  if (xMin > 0.2 && xMax < 25 && xs[0]! > xs[xs.length - 1]!) {
    return { xUnit: "dSpacing", note: `x descends over ${xMin.toFixed(2)}–${xMax.toFixed(2)} — reads as d (Å); confirm` };
  }
  return { xUnit: "twoTheta", note: `x range ${xMin.toFixed(2)}–${xMax.toFixed(2)} is ambiguous (2θ/Q/d) — please confirm` };
}

function radiationFor(xUnit: PowderXUnit, instrument?: InstrumentParameters): Radiation {
  if (xUnit === "tof") return { kind: "neutron-tof" };
  const wavelength = instrument?.kind === "constantWavelength" ? instrument.wavelength : DEFAULT_WAVELENGTH;
  return { kind: "neutron", wavelength };
}

/** Resolve data type + x-unit for a loaded file. Never throws. */
export function detectDataFormat(input: DetectInput): DetectedFormat {
  const { text, instrument, override } = input;

  // --- Data type ---------------------------------------------------------
  const dataType: DataType =
    override?.dataType ?? (looksLikeReflectionList(text) ? "single-crystal" : "powder");

  if (dataType === "single-crystal") {
    return {
      dataType,
      xUnit: "twoTheta", // not used for reflection data
      radiation: instrument?.kind === "tof" ? { kind: "neutron-tof" } : radiationFor("twoTheta", instrument),
      source: override?.dataType ? "override" : looksLikeReflectionList(text) ? "header" : "heuristic",
      confidence: "high",
      note: "Reflection list (h k l I) — refined as single-crystal / extracted intensities.",
    };
  }

  // --- Powder x-unit, in priority order ----------------------------------
  if (override?.xUnit) {
    return { dataType, xUnit: override.xUnit, radiation: radiationFor(override.xUnit, instrument), source: "override", confidence: "high", note: "Unit set manually." };
  }

  // A definitively recognized file format wins over a generic instrument
  // setting (content introspection beats configuration).
  if (isGsasCsvPattern(text)) {
    return { dataType, xUnit: "tof", radiation: { kind: "neutron-tof" }, source: "header", confidence: "high", note: "GSAS-II CSV export — a TOF histogram." };
  }

  const header = headerLines(text);
  const headerUnit = unitFromHeader(header);
  if (headerUnit) {
    return { dataType, xUnit: headerUnit, radiation: radiationFor(headerUnit, instrument), source: "header", confidence: "high", note: `Unit read from the file header/columns (${headerUnit}).` };
  }

  if (instrument) {
    const xUnit: PowderXUnit = instrument.kind === "tof" ? "tof" : "twoTheta";
    return { dataType, xUnit, radiation: radiationFor(xUnit, instrument), source: "instrument", confidence: "high", note: `Unit from the loaded instrument (${instrument.kind === "tof" ? "TOF" : "constant-wavelength → 2θ"}).` };
  }

  const heur = unitFromRange(numericRows(text));
  return { dataType, xUnit: heur.xUnit, radiation: radiationFor(heur.xUnit, instrument), source: "heuristic", confidence: "low", note: `No unit in header or instrument; guessed from data range: ${heur.note}.` };
}
