/**
 * GSAS-II export pieces: the instrument-parameter file (`.instprm`) and the
 * `build_gpx.py` helper that assembles a real `.gpx` via GSASIIscriptable.
 *
 * A `.gpx` is a Python pickle of GSAS-II's internal data tree — impractical and
 * version-fragile to hand-write — so we emit the files GSAS-II *imports* (CIF
 * phase via the existing cif.ts, this `.instprm`, and data) plus a tiny script
 * that builds the `.gpx` with the official scriptable API. Script verified
 * against the GSASIIscriptable source (G2Project / add_phase /
 * add_powder_histogram / add_single_histogram / set_refinements 'Limits' and
 * 'Background' {type, refine, no. coeffs, coeffs} / save).
 *
 * The `.instprm` header warns "do not add/delete items!", so each instrument
 * Type emits exactly the key set GSAS-II expects (PXC / PNC / PNT), matching the
 * bundled instrument files. Pure string producers; saving/zipping are UI.
 *
 * Profile conventions (verified against GSASIImath getCWsig/getTOFsig/
 * getTOFbeta/getTOFalpha):
 *  - CW: σ² = U·tan²θ + V·tanθ + W (centideg², a Gaussian VARIANCE). MATERIA
 *    stores FWHM² (the instprm loader multiplies by 8 ln2), so U,V,W are divided
 *    by 8 ln2 on the way out. X, Y are FWHM in both (no conversion).
 *  - TOF: α = alpha/d; β = beta-0 + beta-1/d⁴ + beta-q/d²;
 *    σ² = sig-0 + sig-1·d² + sig-2·d⁴ + sig-q·d — the same terms MATERIA uses,
 *    so they map one-to-one. MATERIA's constant rise term α₀ has no GSAS-II
 *    counterpart (reported, not silently folded).
 */

import type { InstrumentParameters } from "@/core/diffraction/instrument";

const INSTPRM_HEADER = "#GSAS-II instrument parameter file; do not add/delete items!";

/** GSAS-II Gaussian variance σ² → MATERIA FWHM² (the instprm loader's factor). */
export const GSAS_SIG2_TO_FWHM2 = 8 * Math.log(2);

/** Instrument values keyed by their GSAS-II `.instprm` names (e.g. "U", "sig-1"). */
export type InstprmValues = Readonly<Record<string, number>>;

/** Serialize an instrument to a GSAS-II `.instprm`. `values` (GSAS-II keys,
 *  GSAS-II units — see {@link gsas2InstrumentValues}) override the defaults,
 *  e.g. with the refined profile. */
export function instrumentToInstprm(inst: InstrumentParameters, values: InstprmValues = {}): string {
  const rows: Array<[string, number | string]> =
    inst.kind === "tof" ? tofRows(inst) : cwRows(inst);
  const out = rows.map(([k, v]): [string, number | string] => [k, values[k] ?? v]);
  return [INSTPRM_HEADER, ...out.map(([k, v]) => `${k}:${v}`)].join("\n") + "\n";
}

function cwRows(inst: Extract<InstrumentParameters, { kind: "constantWavelength" }>): Array<[string, number | string]> {
  const xray = inst.radiationKind !== "neutron";
  // PXC (X-ray CW) and PNC (neutron CW) share the profile keys; PXC adds
  // Polariz. and Source. The model's U,V,W are FWHM² → back to GSAS-II σ².
  // A lab tube's doublet is Lam1, Lam2 and I(L2)/I(L1); a monochromatic beam is Lam.
  const k2 = xray ? inst.kAlpha2 : undefined;
  const rows: Array<[string, number | string]> = [
    ["Type", xray ? "PXC" : "PNC"],
    ["Bank", 1.0],
    ...(k2 ? [["Lam1", inst.wavelength], ["Lam2", k2.wavelength]] as Array<[string, number]> : [["Lam", inst.wavelength]] as Array<[string, number]>),
    ["Zero", inst.zero ?? 0],
  ];
  if (xray) rows.push(["Polariz.", inst.polarization ?? 0.5]);
  if (k2) rows.push(["I(L2)/I(L1)", k2.ratio]);
  rows.push(
    ["U", (inst.u ?? 0) / GSAS_SIG2_TO_FWHM2],
    ["V", (inst.v ?? 0) / GSAS_SIG2_TO_FWHM2],
    ["W", (inst.w ?? 0) / GSAS_SIG2_TO_FWHM2],
    ["X", inst.x ?? 0],
    ["Y", inst.y ?? 0],
    ["Z", 0],
    ["SH/L", 0.002],
    ["Azimuth", 0.0],
  );
  if (xray) rows.push(["Source", ""]);
  return rows;
}

function tofRows(inst: Extract<InstrumentParameters, { kind: "tof" }>): Array<[string, number | string]> {
  // PNT (neutron TOF): the full back-to-back-exponential + Gaussian σ key set
  // GSAS-II expects; the instrument's own calibration where it has one.
  // fltPath is derived from difC for a 90° bank (difC = 252.816·2 sinθ·L).
  const twoTheta = 90.0;
  const fltPath = inst.difC / (252.816 * 2 * Math.sin((twoTheta / 2) * (Math.PI / 180)));
  return [
    ["Type", "PNT"],
    ["Bank", 1.0],
    ["difC", inst.difC],
    ["difA", inst.difA ?? 0],
    ["difB", inst.difB ?? 0],
    ["Zero", inst.zero ?? 0],
    ["alpha", inst.alpha ?? 0],
    ["beta-0", inst.beta0 ?? 0],
    ["beta-1", inst.beta1 ?? 0],
    ["beta-q", inst.betaQ ?? 0],
    ["sig-0", inst.sig0 ?? 0],
    ["sig-1", inst.sig1 ?? 0],
    ["sig-2", inst.sig2 ?? 0],
    ["sig-q", inst.sigQ ?? 0],
    ["X", 0],
    ["Y", 0],
    ["Z", 0],
    ["2-theta", twoTheta],
    ["fltPath", Number(fltPath.toFixed(4))],
    ["Azimuth", 0.0],
  ];
}

/** The refined profile, in MATERIA's own conventions (what the fit used). */
export interface RefinedInstrumentProfile {
  /** Zero shift (2θ° CW, µs TOF). */
  readonly zero?: number;
  /** CW Caglioti FWHM² (centideg²). */
  readonly caglioti?: { readonly u: number; readonly v: number; readonly w: number };
  /** CW single Gaussian FWHM (degrees), when no Caglioti terms were used. */
  readonly peakWidth?: number;
  /** CW Lorentzian X (1/cosθ), Y (tanθ), centideg FWHM. */
  readonly lorentzian?: { readonly x: number; readonly y: number };
  /** CW FCJ axial divergence S/L, H/L. */
  readonly axial?: { readonly sl: number; readonly hl: number };
  /** TOF calibration. */
  readonly tof?: { readonly difC: number; readonly difA: number; readonly difB: number };
  /** TOF peak shape (σ² = sig0 + sig1·d² + sig2·d⁴ + sigQ·d; α = α₀ + α₁/d). */
  readonly tofProfile?: {
    readonly alpha0: number; readonly alpha1: number;
    readonly beta0: number; readonly beta1: number; readonly betaQ: number;
    readonly sig0: number; readonly sig1: number; readonly sig2: number; readonly sigQ: number;
  };
}

/**
 * Map the refined profile onto GSAS-II `.instprm` keys/units. Returns the values
 * plus notes for terms GSAS-II cannot express (so the README can say so instead
 * of silently changing the model).
 */
export function gsas2InstrumentValues(kind: "cw" | "tof", p: RefinedInstrumentProfile): { values: Record<string, number>; notes: string[] } {
  const values: Record<string, number> = {};
  const notes: string[] = [];
  if (p.zero !== undefined) values.Zero = p.zero;
  if (kind === "cw") {
    if (p.caglioti) {
      values.U = p.caglioti.u / GSAS_SIG2_TO_FWHM2;
      values.V = p.caglioti.v / GSAS_SIG2_TO_FWHM2;
      values.W = p.caglioti.w / GSAS_SIG2_TO_FWHM2;
    } else if (p.peakWidth !== undefined) {
      // A constant FWHM (degrees) → W alone, in centideg² variance.
      values.U = 0;
      values.V = 0;
      values.W = (p.peakWidth * 100) ** 2 / GSAS_SIG2_TO_FWHM2;
    }
    if (p.lorentzian) {
      values.X = p.lorentzian.x;
      values.Y = p.lorentzian.y;
      values.Z = 0;
    }
    if (p.axial) values["SH/L"] = Math.max(p.axial.sl + p.axial.hl, 0.002);
    return { values, notes };
  }
  if (p.tof) {
    values.difC = p.tof.difC;
    values.difA = p.tof.difA;
    values.difB = p.tof.difB;
  }
  const t = p.tofProfile;
  if (t) {
    values.alpha = t.alpha1;
    values["beta-0"] = t.beta0;
    values["beta-1"] = t.beta1;
    values["beta-q"] = t.betaQ;
    values["sig-0"] = t.sig0;
    values["sig-1"] = t.sig1;
    values["sig-2"] = t.sig2;
    values["sig-q"] = t.sigQ;
    // MATERIA's TOF profile is Gaussian ⊗ back-to-back exponentials: no Lorentzian.
    values.X = 0;
    values.Y = 0;
    values.Z = 0;
    if (t.alpha0 !== 0) notes.push(`α₀ = ${t.alpha0} (constant rise-time term) has no GSAS-II key (GSAS-II α = alpha/d); omitted.`);
  }
  return { values, notes };
}

/**
 * Patch values into an existing `.instprm`, keeping every other line (and the
 * key order) verbatim. Only single-bank files are patched — a multi-bank file
 * returns `undefined` so the caller ships it untouched.
 */
export function patchInstprm(text: string, values: InstprmValues): string | undefined {
  const lines = text.split(/\r?\n/);
  const banks = lines.filter((l) => /^\s*Type\s*:/i.test(l)).length;
  if (banks !== 1 || lines.some((l) => /^\s*#\s*Bank\s*\d/i.test(l))) return undefined;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z0-9_./-]+)(\s*:\s*)(.*)$/);
    if (!m || line.trim().startsWith("#")) return line;
    const key = m[2]!;
    const v = values[key];
    if (v === undefined) return line;
    return `${m[1]}${key}${m[3]}${v}`;
  });
  return out.join("\n");
}

export interface GpxScriptOptions {
  /** Output project filename, e.g. "MnO.gpx". */
  readonly gpxName: string;
  /** CIF phase file in the bundle (the main phase). */
  readonly cifFile: string;
  /** Phase name for GSAS-II. */
  readonly phaseName: string;
  /** Further phases (multi-phase fit): CIF file + phase name each. */
  readonly extraPhases?: readonly { readonly cifFile: string; readonly phaseName: string }[];
  /** Data file in the bundle. */
  readonly dataFile: string;
  /** `.instprm` file (powder only). */
  readonly instprmFile?: string;
  /** Powder or single-crystal histogram. */
  readonly histogramKind: "powder" | "single";
  /** Optional importer format hint for the data file (else GSAS-II auto-detects). */
  readonly dataFmthint?: string;
  /** Powder fit limits [low, high] in the data unit (2θ° or TOF µs). */
  readonly limits?: readonly [number, number];
  /** Powder background as GSAS-II "lin interpolate" values (evenly spaced
   *  across the fitted data, first to last point). */
  readonly background?: readonly number[];
}

/** Python float literal (finite, compact). */
function py(x: number): string {
  return Number.isFinite(x) ? String(Number(x.toPrecision(10))) : "0.0";
}

/**
 * Generate a `build_gpx.py` that assembles a `.gpx` from the bundle files via
 * GSASIIscriptable. Signatures verified against the GSAS-II source.
 */
export function buildGpxScript(opts: GpxScriptOptions): string {
  const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const hint = opts.dataFmthint ? `, fmthint=${q(opts.dataFmthint)}` : "";
  const lines: string[] = [
    "#!/usr/bin/env python",
    '"""Assemble a GSAS-II project (.gpx) from this bundle.',
    "",
    "Requires GSAS-II installed (https://gsas-ii.readthedocs.io).",
    "Run from this folder:  python build_gpx.py",
    "Generated by MATERIA Workbench.",
    '"""',
    "try:",
    "    from GSASII import GSASIIscriptable as G2sc",
    "except ImportError:  # older installs expose it on the path directly",
    "    try:",
    "        import GSASIIscriptable as G2sc",
    "    except ImportError:",
    "        # Legacy gsas2full installs keep the code in a flat directory that",
    "        # is never added to sys.path; probe the usual spots before failing.",
    "        import os",
    "        import sys",
    "        _home = os.path.expanduser('~')",
    "        _env = os.environ.get('GSASII_HOME')",
    "        _candidates = (",
    "            [_env, os.path.join(_env, 'GSASII'), os.path.join(_env, 'GSAS-II')]",
    "            if _env else []",
    "        ) + [",
    "            os.path.join(_home, 'gsas2full', 'GSASII'),",
    "            os.path.join(_home, 'g2full', 'GSAS-II'),",
    "            os.path.join(_home, 'gsas2main', 'GSAS-II'),",
    "        ]",
    "        for _dir in _candidates:",
    "            if os.path.isfile(os.path.join(_dir, 'GSASIIscriptable.py')):",
    "                sys.path.insert(0, _dir)",
    "                break",
    "        else:",
    "            raise ImportError(",
    "                'GSAS-II not found; install it or set GSASII_HOME to the '",
    "                'directory containing GSASIIscriptable.py')",
    "        import GSASIIscriptable as G2sc",
    "",
    `gpx = G2sc.G2Project(newgpx=${q(opts.gpxName)})`,
    `phase = gpx.add_phase(${q(opts.cifFile)}, phasename=${q(opts.phaseName)}, fmthint='CIF')`,
  ];
  const extras = opts.extraPhases ?? [];
  extras.forEach((ph, i) => {
    lines.push(`phase${i + 2} = gpx.add_phase(${q(ph.cifFile)}, phasename=${q(ph.phaseName)}, fmthint='CIF')`);
  });
  const phaseVars = ["phase", ...extras.map((_, i) => `phase${i + 2}`)].join(", ");
  if (opts.histogramKind === "single") {
    lines.push(`hist = gpx.add_single_histogram(${q(opts.dataFile)}, phase=phase${hint})`);
  } else {
    const iparams = opts.instprmFile ? `, ${q(opts.instprmFile)}` : "";
    lines.push(`hist = gpx.add_powder_histogram(${q(opts.dataFile)}${iparams}, phases=[${phaseVars}]${hint})`);
    if (opts.limits) {
      lines.push("", "# The fit range used in MATERIA.");
      lines.push(`hist.set_refinements({'Limits': [${py(opts.limits[0])}, ${py(opts.limits[1])}]})`);
    }
    if (opts.background && opts.background.length >= 3) {
      const coeffs = opts.background.map(py).join(", ");
      lines.push(
        "",
        "# MATERIA's refined background, sampled as GSAS-II 'lin interpolate' points",
        "# (evenly spaced from the first to the last fitted point); not refined yet.",
        "hist.set_refinements({'Background': {",
        "    'type': 'lin interpolate', 'refine': False,",
        `    'no. coeffs': ${opts.background.length},`,
        `    'coeffs': [${coeffs}],`,
        "}})",
      );
    }
  }
  lines.push("", "gpx.save()", `print('Wrote ${opts.gpxName}')`);
  return lines.join("\n") + "\n";
}
