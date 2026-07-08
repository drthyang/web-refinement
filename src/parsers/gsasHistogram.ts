/**
 * Parser for GSAS **standard powder data** histogram files (`.gsa` / `.gss` /
 * `.fxye`) — the raw pattern format written by GSAS-II, Mantid (POWGEN), and many
 * diffractometers. This is *not* the GSAS-II CSV export (that is
 * [`gsasPattern.ts`](./gsasPattern.ts)); this is the `BANK`-record format:
 *
 *   <title line>
 *   # optional comment lines (Mantid metadata, instrument, DIFC, …)
 *   BANK <bank#> <nchan> <nrec> <BINTYP> <c1> <c2> <c3> <c4> <DATTYP>
 *   <data records…>
 *   [BANK … for the next detector bank]
 *
 * **Binning types (BINTYP)** set the x-axis:
 *  - `CONST` — constant-step **constant-wavelength** data. c1/c2 are the start and
 *    step in **centidegrees** (÷100 → 2θ degrees).
 *  - `SLOG`  — constant Δt/t **time-of-flight** data. c1 = start TOF (µs), c2 = max
 *    TOF (µs), c3 = Δt/t. Channel *centers* follow Tᵢ = c1·(1+c3)^(i+½) — validated
 *    against the explicit FXYE abscissa of real POWGEN files (see the tests).
 *  - `RALF` — ISIS TOF (µs×32); explicit-abscissa data (FXYE/FXY) parse fine, but
 *    reconstructing implicit channels (STD/ESD) is not supported here.
 *
 * **Data types (DATTYP)** set the record layout:
 *  - `FXYE` — free-format `X Y E` per line (E = esd). The common modern format.
 *  - `FXY`  — free-format `X Y`; esd defaults to √max(Y,1).
 *  - `STD`  — fixed 8-col fields, GSAS count-packed: 2-col repeat count n + 6-col
 *    intensity I; esd = √(I/n). Ten fields per 80-col record; X from BINTYP.
 *  - `ESD`  — fixed 16-col fields: 8-col intensity + 8-col esd; X from BINTYP.
 *
 * For CW the abscissa is centidegrees ÷ 100; for TOF it is µs. Only `FXYE`/`FXY`
 * (explicit X) plus `CONST`/`SLOG` implicit-X reconstruction are externally
 * validated; `STD`/`ESD` packing follows GSAS-II's `G2pwd_fxye` reader and is
 * covered by synthetic round-trip tests. See docs/LIMITATIONS.md.
 */

import type {
  PowderPattern,
  PowderPoint,
  PowderXUnit,
  Radiation,
} from "@/core/diffraction/types";

const TOF_BINS = new Set(["SLOG", "RALF", "LOG2"]);
const KNOWN_DATA_TYPES = new Set(["FXYE", "FXY", "STD", "ESD", "ALT"]);
const DEFAULT_CW_WAVELENGTH = 1.5406;

/**
 * A real BANK data record: `BANK <int> <int> <int> <BINTYP…>`. Requires the
 * three integer counts so a prose line that merely starts with "BANK " (e.g. a
 * title "BANK ALIGNMENT run 2024") is never mistaken for a data record.
 */
const BANK_RE = /^\s*BANK\s+\d+\s+\d+\s+\d+\s+[A-Za-z]/;
function isBankLine(line: string): boolean {
  return BANK_RE.test(line);
}

/** A single detector bank parsed from a `.gsa` file. */
export interface GsasBank {
  /** Bank number as declared on the BANK record. */
  readonly bankNumber: number;
  /** Declared channel count (`nchan`). */
  readonly nchan: number;
  /** Binning type token (uppercased): CONST, SLOG, RALF, … */
  readonly binType: string;
  /** Data record type token (uppercased): FXYE, FXY, STD, ESD, … */
  readonly dataType: string;
  /** The BCOEF numeric parameters between BINTYP and DATTYP. */
  readonly coefficients: readonly number[];
  /** Abscissa unit implied by the binning (tof for SLOG/RALF, twoTheta for CONST). */
  readonly xUnit: PowderXUnit;
  readonly points: readonly PowderPoint[];
}

/** A parsed GSAS histogram file: header metadata plus one or more banks. */
export interface GsasHistogram {
  readonly title: string;
  readonly comments: readonly string[];
  /** Wavelength (Å) parsed from the header, when present (CW convenience). */
  readonly wavelength?: number;
  readonly banks: readonly GsasBank[];
}

function sfloat(s: string): number {
  const t = s.trim();
  if (t === "") return 0;
  const v = Number(t);
  return Number.isFinite(v) ? v : 0;
}

function sint(s: string): number {
  const t = s.trim();
  if (t === "") return 0;
  const v = parseInt(t, 10);
  return Number.isFinite(v) ? v : 0;
}

/** TOF channel centers for constant-Δt/t (SLOG): Tᵢ = start·(1+Δ)^(i+½), µs. */
export function slogChannelCenters(startTof: number, deltaTOverT: number, nchan: number): number[] {
  const out = new Array<number>(nchan);
  const factor = 1 + deltaTOverT;
  for (let i = 0; i < nchan; i++) out[i] = startTof * Math.pow(factor, i + 0.5);
  return out;
}

/** 2θ channel centers (degrees) for CONST binning: (start + step·i)/100. */
export function constChannelCenters(startCentideg: number, stepCentideg: number, nchan: number): number[] {
  const out = new Array<number>(nchan);
  for (let i = 0; i < nchan; i++) out[i] = (startCentideg + stepCentideg * i) / 100;
  return out;
}

function isTofBin(binType: string): boolean {
  return TOF_BINS.has(binType);
}

/** Parse a `BANK …` header line into its fields. */
function parseBankLine(line: string): {
  bankNumber: number;
  nchan: number;
  nrec: number;
  binType: string;
  coefficients: number[];
  dataType: string;
} {
  const tok = line.trim().split(/\s+/);
  // tok[0] === "BANK"; then bank#, nchan, nrec, BINTYP, coeffs…, DATTYP
  const bankNumber = sint(tok[1] ?? "");
  const nchan = sint(tok[2] ?? "");
  const nrec = sint(tok[3] ?? "");
  const binType = (tok[4] ?? "").toUpperCase();
  // The data type is the last recognized DATTYP token (scanning from the end, so
  // a trailing comment after it — "… FXYE ! POWGEN bank 2" — is ignored). If the
  // record omits it (all-numeric tail), GSAS defaults to STD.
  let dtIdx = -1;
  for (let i = tok.length - 1; i >= 5; i--) {
    if (KNOWN_DATA_TYPES.has((tok[i] ?? "").toUpperCase())) {
      dtIdx = i;
      break;
    }
  }
  const dataType = dtIdx >= 0 ? tok[dtIdx]!.toUpperCase() : "STD";
  const coeffEnd = dtIdx >= 0 ? dtIdx : tok.length;
  // BCOEFs are the numeric tokens between BINTYP and DATTYP.
  const coefficients = tok.slice(5, coeffEnd).filter((t) => t !== "" && Number.isFinite(Number(t))).map(sfloat);
  return { bankNumber, nchan, nrec, binType, coefficients, dataType };
}

/** Reconstruct implicit channel abscissae for STD/ESD from the binning params. */
function implicitChannelX(binType: string, coefficients: readonly number[], nchan: number): number[] {
  const c1 = coefficients[0] ?? 0;
  const c2 = coefficients[1] ?? 0;
  const c3 = coefficients[2] ?? 0;
  if (binType === "CONST") return constChannelCenters(c1, c2, nchan);
  if (binType === "SLOG") return slogChannelCenters(c1, c3, nchan);
  throw new Error(
    `GSAS ${binType} binning with implicit-abscissa data (STD/ESD) is not supported; ` +
      `re-export as FXYE (explicit X Y E).`,
  );
}

function pointFromYE(x: number, y: number, e: number): PowderPoint {
  const sigma = e > 0 ? e : Math.sqrt(Math.max(y, 1));
  return { x, yObs: y, sigma };
}

/** Parse the data records of one bank (raw, untrimmed lines) into points. */
function parseBankData(
  binType: string,
  dataType: string,
  coefficients: readonly number[],
  nchan: number,
  rawLines: readonly string[],
): PowderPoint[] {
  const points: PowderPoint[] = [];
  const tof = isTofBin(binType);
  // CONST stores the abscissa in centidegrees; TOF stores µs (no scaling).
  const scaleExplicitX = tof ? 1 : 1 / 100;

  if (dataType === "FXYE" || dataType === "FXY") {
    for (const raw of rawLines) {
      if (points.length >= nchan) break;
      const line = raw.trim();
      if (line === "") continue;
      const v = line.split(/\s+/).map(Number);
      if (!Number.isFinite(v[0]!) || !Number.isFinite(v[1]!)) continue;
      const x = v[0]! * scaleExplicitX;
      const y = v[1]!;
      const e = dataType === "FXYE" && Number.isFinite(v[2]!) ? v[2]! : 0;
      points.push(pointFromYE(x, y, e));
    }
    return points;
  }

  // Fixed-column formats: X is implicit, reconstructed per channel index.
  const xs = implicitChannelX(binType, coefficients, nchan);
  let j = 0;
  if (dataType === "ESD") {
    for (const raw of rawLines) {
      if (j >= nchan) break;
      const line = raw.replace(/[\r\n]+$/, "");
      let broke = false;
      for (let i = 0; i + 8 <= Math.max(line.length, 80) && j < nchan; i += 16) {
        const yStr = line.slice(i, i + 8);
        if (yStr.trim() === "") { broke = true; break; }
        const y = sfloat(yStr);
        const e = sfloat(line.slice(i + 8, i + 16));
        points.push(pointFromYE(xs[j] ?? 0, y, e));
        j++;
      }
      if (broke) continue;
    }
    return points;
  }

  if (dataType === "STD") {
    for (const raw of rawLines) {
      if (j >= nchan) break;
      const line = raw.replace(/[\r\n]+$/, "");
      for (let i = 0; i + 8 <= Math.max(line.length, 80) && j < nchan; i += 8) {
        const field = line.slice(i, i + 8);
        if (field.trim() === "") break;
        // GSAS count-packing: 2-col repeat count n, 6-col intensity I; esd = √(I/n).
        const n = Math.max(sint(field.slice(0, 2)), 1);
        const y = Math.max(sfloat(field.slice(2, 8)), 0);
        const sigma = y > 0 ? Math.sqrt(y / n) : Math.sqrt(1);
        points.push({ x: xs[j] ?? 0, yObs: y, sigma });
        j++;
      }
    }
    return points;
  }

  throw new Error(`Unsupported GSAS data type "${dataType}" (supported: FXYE, FXY, STD, ESD).`);
}

/** Wavelength (Å) from a header line like "… Wavelength: 1.5 A". */
function parseWavelength(header: string): number | undefined {
  const m = header.match(/wavelength[:=\s]+([0-9]*\.?[0-9]+)\s*a\b/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** True when the text looks like a GSAS standard powder histogram (a BANK record). */
export function isGsasHistogram(text: string): boolean {
  // Scan the whole file (a BANK record can sit behind a long metadata header),
  // so this stays consistent with gsasHistogramUnit — otherwise a big-header file
  // would be classed TOF by the unit probe yet not routed to this parser.
  for (const line of text.split(/\r?\n/)) {
    if (isBankLine(line) && /\b(FXYE|FXY|STD|ESD|ALT|SLOG|CONST|RALF|LOG2)\b/i.test(line)) {
      return true;
    }
  }
  return false;
}

/** The abscissa unit implied by a GSAS histogram's first bank, or null if not one. */
export function gsasHistogramUnit(text: string): PowderXUnit | null {
  for (const line of text.split(/\r?\n/)) {
    if (isBankLine(line)) {
      const { binType } = parseBankLine(line);
      return isTofBin(binType) ? "tof" : "twoTheta";
    }
  }
  return null;
}

/** Parse a complete GSAS histogram file (all banks). */
export function parseGsasHistogram(text: string): GsasHistogram {
  const lines = text.split(/\r?\n/);
  const bankLineIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBankLine(lines[i]!)) bankLineIdx.push(i);
  }
  if (bankLineIdx.length === 0) {
    throw new Error("Not a GSAS histogram file (no BANK record found).");
  }

  // Header = everything before the first BANK line.
  const headerLines = lines.slice(0, bankLineIdx[0]);
  const title = (headerLines.find((l) => l.trim() !== "") ?? "").trim();
  const comments = headerLines.filter((l) => l.trim().startsWith("#")).map((l) => l.trim());
  const wavelength = parseWavelength(headerLines.join("\n"));

  const banks: GsasBank[] = [];
  for (let b = 0; b < bankLineIdx.length; b++) {
    const start = bankLineIdx[b]!;
    const end = b + 1 < bankLineIdx.length ? bankLineIdx[b + 1]! : lines.length;
    const header = parseBankLine(lines[start]!);
    const dataLines = lines.slice(start + 1, end);
    const points = parseBankData(header.binType, header.dataType, header.coefficients, header.nchan, dataLines);
    banks.push({
      bankNumber: header.bankNumber,
      nchan: header.nchan,
      binType: header.binType,
      dataType: header.dataType,
      coefficients: header.coefficients,
      xUnit: isTofBin(header.binType) ? "tof" : "twoTheta",
      points,
    });
  }

  return { title, comments, ...(wavelength !== undefined ? { wavelength } : {}), banks };
}

export interface GsasHistogramPatternOptions {
  /** Select a bank by its declared bank number; defaults to the first bank. */
  readonly bank?: number;
  /** Override the radiation (e.g. from a loaded instrument file). */
  readonly radiation?: Radiation;
}

/**
 * Parse a GSAS histogram into a single {@link PowderPattern} (mirrors
 * `parseGsasCsvPattern`'s `(text, id, name)` signature). Selects the first bank
 * unless `bank` is given; derives the abscissa unit and a neutron/neutron-TOF
 * radiation from the binning, both overridable via `options.radiation`.
 */
export function parseGsasHistogramPattern(
  text: string,
  id: string,
  name: string,
  options: GsasHistogramPatternOptions = {},
): PowderPattern {
  const hist = parseGsasHistogram(text);
  const bank =
    options.bank !== undefined
      ? hist.banks.find((bk) => bk.bankNumber === options.bank) ?? hist.banks[0]!
      : hist.banks[0]!;
  if (!bank || bank.points.length === 0) {
    throw new Error("GSAS histogram had no usable data points.");
  }

  const tof = bank.xUnit === "tof";
  const radiation: Radiation =
    options.radiation ??
    (tof ? { kind: "neutron-tof" } : { kind: "neutron", wavelength: hist.wavelength ?? DEFAULT_CW_WAVELENGTH });

  return {
    id,
    name,
    xUnit: bank.xUnit,
    radiation,
    points: bank.points,
    ...(!tof && hist.wavelength !== undefined ? { wavelength: hist.wavelength } : {}),
  };
}
