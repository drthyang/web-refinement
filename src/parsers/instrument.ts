/**
 * Parser for instrument parameters, accepting the GSAS-II `.instprm` `key:value`
 * format (and lenient `key value` / `key=value` variants). Recognizes the TOF
 * calibration (difC/difA/difB/Zero) and constant-wavelength (Lam/wavelength).
 * Unknown keys are ignored.
 */

import type { InstrumentParameters } from "@/core/diffraction/instrument";

function readValues(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*[:=\s]\s*(-?\d[\d.eE+-]*)/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = parseFloat(m[2]!);
    if (!Number.isNaN(value)) values.set(key, value);
  }
  return values;
}

export function parseInstrumentParameters(text: string): InstrumentParameters {
  const v = readValues(text);
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
    return {
      kind: "constantWavelength",
      wavelength: lam,
      ...(v.get("zero") !== undefined ? { zero: v.get("zero")! } : {}),
    };
  }
  throw new Error("Instrument file has neither difC (TOF) nor a wavelength (CW)");
}
