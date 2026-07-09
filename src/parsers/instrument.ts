/**
 * Parser for instrument parameters, accepting the GSAS-II `.instprm` `key:value`
 * format (and lenient `key value` / `key=value` variants) and the FullProf
 * `.irf` resolution format. Recognizes the TOF calibration (difC/difA/difB/Zero)
 * and constant-wavelength (Lam/wavelength + Caglioti U,V,W). Unknown keys are ignored.
 */

import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { recognizeInstrument, facilityLabel } from "@/parsers/instrumentRegistry";

/**
 * FullProf's Caglioti U,V,W are FWHM² coefficients in **degrees²** (FWHM² =
 * U·tan²θ + V·tanθ + W). This app follows GSAS-II, whose U,V,W are in
 * **centidegrees²** (the width comes out in centidegrees, later ÷100 to degrees;
 * see workflow/powder.ts). 1° = 100 cdeg and the terms are squared, so the
 * conversion is ×100² = ×10⁴. Verified: D1B (1.614, −1.077, 0.363) → FWHM ≈ 0.43°
 * at 2θ = 40°.
 */
const FP_UVW_DEG2_TO_CENTIDEG2 = 1e4;

/** True for a FullProf `.irf` resolution file (keyword-led lines, not key:value). */
export function looksLikeFullProfIrf(text: string): boolean {
  return /^\s*(JOBT|PROF|WAVE|THRG|GEOM|TOFRG|D2TOF|NPROF)\b/im.test(text);
}

/** Numeric tokens of a line, or [] if it is a comment / keyword-led line. */
function numericLine(line: string): number[] {
  const t = line.trim();
  if (t === "" || t.startsWith("!") || /^[A-Za-z]/.test(t)) return [];
  const nums = t.split(/\s+/).map(Number);
  return nums.every(Number.isFinite) ? nums : [];
}

/** Value(s) after a FullProf keyword line, e.g. `WAVE 2.524 2.524 1.0`. */
function irfKeyword(text: string, key: string): number[] | null {
  const m = text.match(new RegExp(`^\\s*${key}\\s+(.+)$`, "im"));
  if (!m) return null;
  return m[1]!.trim().split(/\s+/).map(Number).filter(Number.isFinite);
}

/**
 * Parse a FullProf `.irf`. Constant-wavelength files (WAVE + a bare U V W X Y Z
 * line, e.g. D1B/D20) become a CW instrument with Caglioti U,V,W; TOF files
 * (D2TOF: Dtt1 Dtt2 Dtt_1overD Zero) become a TOF calibration. The numerical
 * per-d profile table (NPROF 9) is not consumed — only the calibration is.
 */
export function parseFullProfIrf(text: string): InstrumentParameters {
  const d2tof = irfKeyword(text, "D2TOF");
  if (d2tof && d2tof.length >= 1) {
    const [dtt1, dtt2, dtt1overD, zero] = d2tof;
    return {
      kind: "tof",
      difC: dtt1!,
      ...(dtt2 !== undefined ? { difA: dtt2 } : {}),
      ...(dtt1overD !== undefined ? { difB: dtt1overD } : {}),
      ...(zero !== undefined ? { zero } : {}),
    };
  }

  const wave = irfKeyword(text, "WAVE");
  if (wave && wave.length >= 1) {
    const jobt = text.match(/^\s*JOBT\s+([A-Za-z]+)/im)?.[1]?.toUpperCase();
    const radiationKind: "neutron" | "xray" | undefined =
      jobt?.startsWith("NEUT") ? "neutron" : jobt?.startsWith("XR") ? "xray" : undefined;
    // The Caglioti row is the first bare numeric line with ≥3 values (U V W …).
    const uvw = text.split(/\r?\n/).map(numericLine).find((n) => n.length >= 3);
    const zero = irfKeyword(text, "ZER")?.[0];
    return {
      kind: "constantWavelength",
      ...(radiationKind !== undefined ? { radiationKind } : {}),
      wavelength: wave[0]!,
      ...(zero !== undefined ? { zero } : {}),
      ...(uvw ? {
        u: uvw[0]! * FP_UVW_DEG2_TO_CENTIDEG2,
        v: uvw[1]! * FP_UVW_DEG2_TO_CENTIDEG2,
        w: uvw[2]! * FP_UVW_DEG2_TO_CENTIDEG2,
      } : {}),
    };
  }

  throw new Error("FullProf .irf: neither a WAVE (CW) nor a D2TOF (TOF) calibration found");
}

function readValues(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Keys may carry a dot or slash (GSAS-II `Polariz.`, `SH/L`).
    const m = line.match(/^([A-Za-z0-9_./]+)\s*[:=\s]\s*(-?\d[\d.eE+-]*)/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = parseFloat(m[2]!);
    if (!Number.isNaN(value)) values.set(key, value);
  }
  return values;
}

function gsasType(text: string): string | undefined {
  const m = text.match(/^\s*Type\s*[:=\s]\s*([A-Za-z0-9]+)/im);
  return m?.[1]?.toUpperCase();
}

export function parseInstrumentParameters(text: string): InstrumentParameters {
  return withRecognizedName(text, parseInstrumentBase(text));
}

/** Attach the beamline name + facility label if the header names a known instrument. */
function withRecognizedName(text: string, inst: InstrumentParameters): InstrumentParameters {
  const known = recognizeInstrument(text);
  if (!known) return inst;
  return { ...inst, name: known.name, facility: facilityLabel(known) };
}

function parseInstrumentBase(text: string): InstrumentParameters {
  if (looksLikeFullProfIrf(text)) return parseFullProfIrf(text);
  const v = readValues(text);
  const type = gsasType(text);
  const difC = v.get("difc");
  if (difC !== undefined) {
    const params: Extract<InstrumentParameters, { kind: "tof" }> = {
      kind: "tof",
      difC,
      ...(v.get("difa") !== undefined ? { difA: v.get("difa")! } : {}),
      ...(v.get("difb") !== undefined ? { difB: v.get("difb")! } : {}),
      ...(v.get("zero") !== undefined ? { zero: v.get("zero")! } : {}),
    };
    return params;
  }
  const lam = v.get("lam") ?? v.get("lam1") ?? v.get("wavelength") ?? v.get("lambda");
  if (lam !== undefined) {
    const radiationKind = type?.includes("X") ? "xray" : type?.includes("N") ? "neutron" : undefined;
    return {
      kind: "constantWavelength",
      ...(radiationKind !== undefined ? { radiationKind } : {}),
      wavelength: lam,
      ...(v.get("zero") !== undefined ? { zero: v.get("zero")! } : {}),
      ...(v.get("u") !== undefined ? { u: v.get("u")! } : {}),
      ...(v.get("v") !== undefined ? { v: v.get("v")! } : {}),
      ...(v.get("w") !== undefined ? { w: v.get("w")! } : {}),
      ...(v.get("polariz.") !== undefined ? { polarization: v.get("polariz.")! } : {}),
    };
  }
  throw new Error("Instrument file has neither difC (TOF) nor a wavelength (CW)");
}
