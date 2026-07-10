/**
 * Parser for instrument parameters, accepting the GSAS-II `.instprm` `key:value`
 * format (and lenient `key value` / `key=value` variants) and the FullProf
 * `.irf` resolution format. Recognizes the TOF calibration (difC/difA/difB/Zero)
 * and constant-wavelength (Lam/wavelength + Caglioti U,V,W). Unknown keys are ignored.
 */

import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { recognizeInstrument, facilityLabel } from "@/parsers/instrumentRegistry";

/**
 * This app's internal Caglioti U,V,W are **FWHM² coefficients** in centidegrees²
 * (FWHM² = U·tan²θ + V·tanθ + W; see `gaussianFwhm` in diffraction/profile.ts,
 * which takes the √ directly). Two source conventions must be normalised to it:
 *
 *  - FullProf U,V,W are FWHM² in **degrees²** → ×10⁴ (1° = 100 cdeg, squared).
 *    Verified: D1B (1.614, −1.077, 0.363) → FWHM ≈ 0.43° at 2θ = 40°.
 *  - GSAS / GSAS-II U,V,W give the Gaussian **variance σ²** in centidegrees²
 *    (GSAS-II: σ² = U tan²θ + V tanθ + W, FWHM_G = √(8 ln2)·σ), so they must be
 *    ×8 ln2 to become FWHM². Without this the Gaussian is √(8 ln2) ≈ 2.35× too
 *    narrow — negligible once U,V,W refine, but fatal to the *seed* for
 *    high-resolution data (e.g. synchrotron 11-BM peaks came out ~2.5 m° instead
 *    of the real ~6–10 m°, collapsing the scale so the calc never matched).
 */
const FP_UVW_DEG2_TO_CENTIDEG2 = 1e4;
const GSAS_SIG2_TO_FWHM2 = 8 * Math.log(2); // σ² → FWHM² (≈ 5.545)

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

/**
 * True for a classic GSAS instrument-parameter file: the column-formatted `INS`
 * records (`HTYPE`, `ICONS`, `PRCF…`), as written by GSAS and by GSAS-II's
 * "export → GSAS instrument". Distinct from the GSAS-II `.instprm` `key:value`
 * format, which has no `INS` prefix and no `ICONS` record.
 */
export function looksLikeGsasPrm(text: string): boolean {
  return /^INS\b/m.test(text) && /\bICONS\b/.test(text);
}

/**
 * Parse a classic GSAS `.prm`/`.inst` instrument file. `HTYPE`'s 2nd/3rd letters
 * give the radiation (N/X) and CW-vs-TOF (C/T); `ICONS` carries the wavelength +
 * zero (CW) or difC/difA/Zero (TOF). For CW the Gaussian profile terms GU,GV,GW —
 * the first three coefficients of the first `PRCF` row, already in GSAS
 * centidegrees² (this app's convention, so no scaling) — seed the Caglioti U,V,W.
 * GSAS's CW zero is in centidegrees; this app's CW zero is in degrees (÷100).
 */
export function parseGsasPrm(text: string): InstrumentParameters {
  const lines = text.split(/\r?\n/);
  // Text after a named field on its `INS …` record (fixed columns, so slice by
  // the keyword rather than tokenising the bank/flag columns before it).
  const after = (name: string): string | undefined => {
    for (const l of lines) {
      if (!/^INS\b/.test(l)) continue;
      const i = l.indexOf(name);
      if (i >= 0) return l.slice(i + name.length);
    }
    return undefined;
  };
  const nums = (s: string | undefined): number[] =>
    s ? s.trim().split(/\s+/).map(Number).filter(Number.isFinite) : [];

  const htype = after("HTYPE")?.trim().split(/\s+/)[0]?.toUpperCase();
  // ICONS is fixed 10-column: for CW  lam1 lam2 zero [trans] POLA IPOLA …; for
  // TOF  difC difA Zero. Read the leading values by whitespace (robust to spacing)
  // but the polarization by fixed column — field 4 (transmission) is often blank,
  // so only the column position reliably locates POLA.
  const iconsRaw = after("ICONS") ?? "";
  const icons = nums(iconsRaw);
  const iconsCol = (n: number): number | undefined => {
    const f = iconsRaw.slice(n * 10, n * 10 + 10).trim();
    if (f === "") return undefined;
    const v = Number(f);
    return Number.isFinite(v) ? v : undefined;
  };
  const radiationKind: "neutron" | "xray" | undefined =
    htype?.[1] === "X" ? "xray" : htype?.[1] === "N" ? "neutron" : undefined;
  // CW-vs-TOF from HTYPE's 3rd letter; fall back to the ICONS magnitude (difC is
  // in the hundreds–thousands, a wavelength is < ~10 Å).
  const isTof = htype ? htype[2] === "T" : icons.length > 0 && (icons[0] ?? 0) > 50;

  if (isTof) {
    const [difC, difA, zero] = icons;
    if (difC === undefined) throw new Error("GSAS .prm: TOF ICONS record has no difC");
    return {
      kind: "tof",
      difC,
      ...(difA ? { difA } : {}),
      ...(zero !== undefined ? { zero } : {}),
    };
  }

  const lam1 = icons[0];
  if (lam1 === undefined || lam1 <= 0) throw new Error("GSAS .prm: CW ICONS record has no wavelength");
  const zeroCentideg = icons[2];
  // First PRCF coefficient row (e.g. `PRCF11`): GU GV GW (GP) for CW profile
  // functions 1–4 — the first three are the Gaussian Caglioti terms.
  // PRCF row 1 (`PRCF11`): GU GV GW (GP) — the Gaussian Caglioti terms. PRCF row 2
  // (`PRCF12`): LX LY (S/L H/L) — the Lorentzian broadening (GSAS X, Y; unlike the
  // Gaussian σ² these are already FWHM coefficients, so no 8 ln2 factor). The
  // Lorentzian is the instrument's *calibrated* resolution — seeding it (rather
  // than an arbitrary X=1) is what lets sharp synchrotron peaks fit.
  const prcfRow1 = lines.find((l) => /PRCF11\b/.test(l));
  const uvw = prcfRow1 ? nums(prcfRow1.slice(prcfRow1.search(/PRCF11/) + "PRCF11".length)) : [];
  const prcfRow2 = lines.find((l) => /PRCF12\b/.test(l));
  const lxy = prcfRow2 ? nums(prcfRow2.slice(prcfRow2.search(/PRCF12/) + "PRCF12".length)) : [];
  // POLA (fixed-column field 5) is the X-ray polarization fraction for the Lp
  // correction; ~0.99 for a synchrotron like 11-BM, 0.5 for an unpolarized tube.
  const pola = iconsCol(4);
  return {
    kind: "constantWavelength",
    ...(radiationKind !== undefined ? { radiationKind } : {}),
    wavelength: lam1,
    ...(zeroCentideg ? { zero: zeroCentideg / 100 } : {}),
    ...(uvw.length >= 3 ? {
      u: uvw[0]! * GSAS_SIG2_TO_FWHM2,
      v: uvw[1]! * GSAS_SIG2_TO_FWHM2,
      w: uvw[2]! * GSAS_SIG2_TO_FWHM2,
    } : {}),
    ...(lxy.length >= 2 ? { x: lxy[0]!, y: lxy[1]! } : {}),
    ...(radiationKind === "xray" && pola !== undefined && pola > 0 && pola <= 1 ? { polarization: pola } : {}),
  };
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
  if (looksLikeGsasPrm(text)) return parseGsasPrm(text);
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
      ...(v.get("u") !== undefined ? { u: v.get("u")! * GSAS_SIG2_TO_FWHM2 } : {}),
      ...(v.get("v") !== undefined ? { v: v.get("v")! * GSAS_SIG2_TO_FWHM2 } : {}),
      ...(v.get("w") !== undefined ? { w: v.get("w")! * GSAS_SIG2_TO_FWHM2 } : {}),
      // Lorentzian X, Y are already FWHM coefficients (no 8 ln2), the instrument's
      // calibrated size/strain broadening — seed them so sharp peaks fit on load.
      ...(v.get("x") !== undefined ? { x: v.get("x")! } : {}),
      ...(v.get("y") !== undefined ? { y: v.get("y")! } : {}),
      ...(v.get("polariz.") !== undefined ? { polarization: v.get("polariz.")! } : {}),
    };
  }
  throw new Error("Instrument file has neither difC (TOF) nor a wavelength (CW)");
}
