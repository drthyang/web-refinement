/**
 * Export-bundle assembler: turns a refinement (structure + dataset + instrument
 * + refined parameters) into the set of files a user drops into FullProf or
 * GSAS-II. Pure — returns `ZipEntry[]`; the UI zips (via zipStore) and downloads.
 *
 * Two program-specific bundles (one click each):
 *  - FullProf: `<name>.pcr` (every phase) + data (`.dat` XYDATA / `.int`) + README
 *  - GSAS-II:  one `.cif` per phase + `.instprm` (powder) + data (`.xye`/`.hkl`)
 *              + `build_gpx.py` + README
 *
 * `refinementBundle` is the entry point for a finished fit: it applies the
 * refined values to every phase AND derives the refined instrument profile,
 * background curve and fit range, so both programs start from the model the
 * workbench converged to — not just its structure.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { DiffractionDataset, PowderPattern, Radiation } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { RefinementParameter, ParameterBinding, ParameterKind } from "@/core/refinement/types";
import type { ZipEntry } from "@/core/export/zip";
import type { BackgroundType } from "@/core/diffraction/background";
import { evaluateBackground } from "@/core/diffraction/background";
import { structureToCif, type CifRefinementMeta } from "@/core/export/cif";
import { structureToPcr, type PcrExportOptions, type PcrPhase } from "@/core/export/fullprof";
import {
  instrumentToInstprm, buildGpxScript, gsas2InstrumentValues, patchInstprm,
  type RefinedInstrumentProfile,
} from "@/core/export/gsas2";
import {
  powderDataXye, powderDataFullProf, singleCrystalHkl, singleCrystalInt, radiationWavelength, hklf4ScaleFactor,
} from "@/core/export/data";
import { applyParameters, type AppliedModel } from "@/core/workflow/apply";
import { phaseBindingsFor } from "@/core/workflow/multiPhase";
import { resolveTies } from "@/core/refinement/constraints";

/** A further phase of a multi-phase fit, as it goes into the bundle. */
export interface BundlePhase {
  readonly structure: StructureModel;
  /** Refined phase scale (a starting value for FullProf). */
  readonly scale?: number;
  /** March–Dollase preferred orientation of this phase. */
  readonly po?: { readonly axis: readonly [number, number, number]; readonly ratio: number };
}

export interface BundleOptions {
  /** Base filename (default: sanitized structure name). */
  readonly name?: string;
  /** Full instrument parameters; derived from the dataset radiation if omitted. */
  readonly instrument?: InstrumentParameters;
  /** Refined parameters + bindings (for CIF value(su) annotation). */
  readonly params?: readonly RefinementParameter[];
  readonly bindings?: readonly ParameterBinding[];
  /** Refinement agreement metadata for the CIF. */
  readonly refinement?: CifRefinementMeta;
  /** Standard BNS label for a magnetic phase. */
  readonly magneticLabel?: string;
  /** The user's original instrument file (verbatim). When it is a single-bank
   *  GSAS-II `.instprm`, the refined profile is patched into a copy of it
   *  (every other line kept) instead of regenerating from the lossy instrument
   *  model; the untouched original always ships alongside. */
  readonly rawInstrument?: { readonly name: string; readonly text: string };
  /** The user's original data file (verbatim), shipped alongside the portable
   *  re-serialized data so the exact input travels with the bundle. */
  readonly rawData?: { readonly name: string; readonly text: string };
  /** Main-phase scale + preferred orientation (refined values). */
  readonly primary?: Omit<BundlePhase, "structure">;
  /** The other phases of a multi-phase fit (at their refined values). */
  readonly extraPhases?: readonly BundlePhase[];
  /** The refined instrument profile, in MATERIA's conventions. */
  readonly profile?: RefinedInstrumentProfile;
  /** The refined background curve y_b(x) (pattern units). */
  readonly backgroundCurve?: (x: number) => number;
  /** Anchors of an interpolating background (its values transfer exactly). */
  readonly backgroundAnchors?: readonly number[];
  /** The fit range used (only a range narrower than the data has an effect). */
  readonly fitRange?: { readonly min?: number; readonly max?: number };
  /** Refined quantities neither program receives from the bundle. */
  readonly notExported?: readonly string[];
}

type SingleCrystalData = Extract<DiffractionDataset, { reflections: unknown }>;

function isSingleCrystal(dataset: DiffractionDataset): dataset is SingleCrystalData {
  return "reflections" in dataset;
}

/** Filesystem-safe base name. */
function sanitize(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "structure";
}

/** Keep a user's original filename (with its extension) but make it zip-safe. */
function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned && cleaned !== "." ? cleaned : "";
}

/** Does a raw instrument file look like a GSAS-II `.instprm` (usable verbatim)? */
function isInstprm(name: string, text: string): boolean {
  return /\.instprm$/i.test(name)
    || /#\s*GSAS-II instrument parameter file/i.test(text)
    || /(^|\n)\s*Type\s*:\s*(PNT|PXC|PNC)\b/i.test(text);
}

/** The detector-bank 2θ a GSAS-II `.instprm` declares (TOF), if any. */
function instprmTwoTheta(text: string | undefined): number | undefined {
  const m = text?.match(/^\s*2-theta\s*:\s*(-?\d[\d.eE+-]*)/im);
  const v = m ? parseFloat(m[1]!) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

/** A minimal instrument when the caller doesn't supply full parameters. */
function deriveInstrument(radiation: Radiation): InstrumentParameters {
  if (radiation.kind === "neutron-tof") return { kind: "tof", difC: 0 };
  return {
    kind: "constantWavelength",
    wavelength: radiation.wavelength,
    radiationKind: radiation.kind === "xray" ? "xray" : "neutron",
    ...(radiation.kind === "xray" && radiation.polarization !== undefined ? { polarization: radiation.polarization } : {}),
  };
}

export type BundleTarget = "fullprof" | "gsas2";

export interface RefinementBundleOptions extends BundleOptions {
  /** The refinement's parameters, carrying the refined values (and `esd`). */
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  /** Ids of the other phases in a multi-phase fit, whose bindings are left out
   *  of the main phase. Pass the phases themselves as `phases` to export them. */
  readonly otherPhaseIds?: readonly string[];
  /** The other phases of a multi-phase fit, as loaded; exported at their
   *  refined values (own bindings + the shared instrument profile). */
  readonly phases?: readonly StructureModel[];
  /** Background basis the refinement used (default Chebyshev). */
  readonly backgroundType?: BackgroundType;
}

/** Kinds the bundle carries (everything else is reported as not exported). */
const EXPORTED_KINDS = new Set<ParameterKind>([
  "scale", "background", "cellLength", "cellAngle", "atomX", "atomY", "atomZ", "positionShift",
  "occupancy", "bIso", "uAniso", "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY",
  "asymSL", "asymHL", "zeroShift", "tofCalibration", "tofProfile", "poRatio", "mustrainIso",
]);

/** Readable names for the kinds the bundle does not carry. */
const KIND_NAMES: Partial<Record<ParameterKind, string>> = {
  sampleDisplacement: "sample displacement",
  sampleTransparency: "sample transparency",
  absorption: "absorption (muR)",
  surfaceRoughA: "surface roughness",
  surfaceRoughB: "surface roughness",
  extinction: "extinction",
  stephensStrain: "Stephens anisotropic microstrain",
  anisoSizePerp: "uniaxial crystallite size",
  anisoSizePar: "uniaxial crystallite size",
  mustrainPerp: "uniaxial microstrain",
  mustrainPar: "uniaxial microstrain",
  magneticScale: "the magnetic phase",
  momentX: "the magnetic phase",
  momentY: "the magnetic phase",
  momentZ: "the magnetic phase",
  momentMode: "the magnetic phase",
};

/**
 * The cross-check bundle of a refinement. Everything the fit converged to is
 * applied first — cell, positions, ADPs, occupancies for every phase, and the
 * shared instrument profile (zero, peak shape, TOF calibration), background and
 * fit range — so the files carry the refined model, not the starting one.
 * Bindings aimed at another phase are left out of the main phase, so a
 * multi-phase fit cannot cross-apply a cell.
 */
export function refinementBundle(
  target: BundleTarget,
  structure: StructureModel,
  dataset: DiffractionDataset,
  opts: RefinementBundleOptions,
): ZipEntry[] {
  const others = new Set([...(opts.otherPhaseIds ?? []), ...(opts.phases ?? []).map((p) => p.id)]);
  const values = resolveTies(opts.params, Object.fromEntries(opts.params.map((p) => [p.id, p.value])));
  const primaryApplied = applyParameters(structure, opts.bindings.filter((b) => !others.has(b.targetId)), values);
  const extraPhases: BundlePhase[] = (opts.phases ?? []).map((ph) => {
    const a = applyParameters(ph, phaseBindingsFor(opts.bindings, ph.id), values);
    return { structure: a.model, ...phaseExtras(a, opts.bindings, ph.id) };
  });
  const kinds = new Set(opts.bindings.map((b) => b.kind));
  const notExported = [...new Set([...kinds].filter((k) => !EXPORTED_KINDS.has(k)).map((k) => KIND_NAMES[k] ?? k))];
  const bundleOpts: BundleOptions = {
    ...opts,
    primary: phaseExtras(primaryApplied, opts.bindings, undefined),
    extraPhases,
    ...(!isSingleCrystal(dataset) ? powderExtras(dataset, primaryApplied, kinds, opts.backgroundType ?? "chebyshev") : {}),
    ...(notExported.length ? { notExported } : {}),
  };
  const refined = primaryApplied.model;
  return target === "fullprof" ? fullprofBundle(refined, dataset, bundleOpts) : gsas2Bundle(refined, dataset, bundleOpts);
}

/** Scale + preferred orientation of one phase (only when actually bound). */
function phaseExtras(
  a: AppliedModel,
  bindings: readonly ParameterBinding[],
  phaseId: string | undefined,
): Omit<BundlePhase, "structure"> {
  const scaleBound = bindings.some((b) => b.kind === "scale" && (phaseId === undefined || b.targetId === phaseId));
  return {
    ...(scaleBound ? { scale: a.scale } : {}),
    ...(a.po ? { po: { axis: a.po.axis, ratio: a.po.ratio } } : {}),
  };
}

/** The refined instrument profile + background of a powder fit, in model units. */
function powderExtras(
  pattern: PowderPattern,
  a: AppliedModel,
  kinds: ReadonlySet<ParameterKind>,
  bgType: BackgroundType,
): Pick<BundleOptions, "profile" | "backgroundCurve" | "backgroundAnchors"> {
  // An isotropic TOF Mustrain is the ∝d² Gaussian strain term: fold its
  // σ_T² ≈ (difC·ε)²·d² into Sig-1, since neither file carries it separately
  // here (ε is already dimensionless on the applied model).
  const tofProfile = a.tofProfile && a.mustrainIso && a.tof
    ? { ...a.tofProfile, sig1: a.tofProfile.sig1 + (a.tof.difC * a.mustrainIso) ** 2 }
    : a.tofProfile;
  const profile: RefinedInstrumentProfile = {
    zero: a.zeroShift,
    ...(a.caglioti ? { caglioti: a.caglioti } : {}),
    ...(!a.caglioti && kinds.has("peakWidth") ? { peakWidth: a.peakWidth } : {}),
    ...(a.lorentzian ? { lorentzian: a.lorentzian } : {}),
    ...(a.axial ? { axial: a.axial } : {}),
    ...(a.tof ? { tof: a.tof } : {}),
    ...(tofProfile ? { tofProfile } : {}),
  };
  if (!kinds.has("background") || a.background.length === 0 || pattern.points.length < 2) return { profile };
  const xs = pattern.points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const coeffs = a.background;
  const backgroundCurve = (x: number): number => evaluateBackground(x, coeffs, bgType, xMin, xMax);
  // An interpolating background is exact at its own anchors (GSAS-II style).
  if ((bgType === "linInterpolate" || bgType === "logInterpolate") && coeffs.length >= 2) {
    const n = coeffs.length;
    const log = bgType === "logInterpolate" && xMin > 0;
    const backgroundAnchors = Array.from({ length: n }, (_, i) =>
      log ? Math.exp(Math.log(xMin) + (i * (Math.log(xMax) - Math.log(xMin))) / (n - 1)) : xMin + (i * (xMax - xMin)) / (n - 1));
    return { profile, backgroundCurve, backgroundAnchors };
  }
  return { profile, backgroundCurve };
}

/** Direct-call fallback (no derived `profile`): the refined TOF shape read off
 *  the parameter list by id (`tof_<key>`, see buildStructureRefinement), with an
 *  isotropic Mustrain folded into Sig-1 as σ_T² ≈ (difC·ε)²·d². */
function tofShapeFromParams(
  params: readonly RefinementParameter[] | undefined,
  instrument: InstrumentParameters | undefined,
): PcrExportOptions["tofShape"] | undefined {
  if (!params || !params.some((p) => p.id.startsWith("tof_") || p.id === "mustrainIso")) return undefined;
  const val = (id: string): number | undefined => params.find((p) => p.id === id)?.value;
  const shape: Record<string, number> = {};
  for (const key of ["sig0", "sig1", "sig2", "sigQ", "alpha0", "alpha1", "beta0", "beta1", "betaQ"] as const) {
    const v = val(`tof_${key}`);
    if (v !== undefined) shape[key] = v;
  }
  const mustrain = val("mustrainIso");
  if (mustrain !== undefined && mustrain > 0 && instrument?.kind === "tof") {
    shape.sig1 = (shape.sig1 ?? 0) + (instrument.difC * mustrain * 1e-6) ** 2;
  }
  return Object.keys(shape).length > 0 ? shape : undefined;
}

/** `n` evenly spaced abscissae from lo to hi, inclusive. */
function linspace(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo + (i * (hi - lo)) / (n - 1));
}

/** Data span, fitted span and the excluded tails outside the fit range. */
function powderSpan(pattern: PowderPattern, fitRange: BundleOptions["fitRange"]) {
  const xs = pattern.points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const lo = fitRange?.min !== undefined && fitRange.min > xMin ? fitRange.min : xMin;
  const hi = fitRange?.max !== undefined && fitRange.max < xMax ? fitRange.max : xMax;
  const inFit = xs.filter((x) => x >= lo && x <= hi);
  const first = inFit.length ? Math.min(...inFit) : xMin;
  const last = inFit.length ? Math.max(...inFit) : xMax;
  const excluded: [number, number][] = [];
  const margin = Math.max(1, (xMax - xMin) * 0.01);
  if (lo > xMin) excluded.push([xMin - margin, lo]);
  if (hi < xMax) excluded.push([hi, xMax + margin]);
  return { xMin, xMax, lo, hi, first, last, excluded, narrowed: excluded.length > 0 };
}

/** FullProf bundle: `.pcr` + data + README (+ verbatim originals when present). */
export function fullprofBundle(structure: StructureModel, dataset: DiffractionDataset, opts: BundleOptions = {}): ZipEntry[] {
  const name = sanitize(opts.name ?? structure.name);
  const sc = isSingleCrystal(dataset);
  const dataName = `${name}.${sc ? "int" : "dat"}`;
  const data = isSingleCrystal(dataset) ? singleCrystalInt(dataset) : powderDataFullProf(dataset, name);
  const wl = radiationWavelength(dataset.radiation);
  const radiationKind = dataset.radiation.kind === "xray" ? "xray" as const : "neutron" as const;
  const phases: PcrPhase[] = [{ structure, ...(opts.primary ?? {}) }, ...(opts.extraPhases ?? [])];
  const base: PcrExportOptions = { title: name, datFile: dataName, radiationKind, phases, ...(wl ? { wavelength: wl } : {}) };
  let pcr: string;
  let narrowed = false;
  if (isSingleCrystal(dataset)) {
    pcr = structureToPcr(structure, { ...base, singleCrystal: true });
  } else {
    const span = powderSpan(dataset, opts.fitRange);
    narrowed = span.narrowed;
    const prof = opts.profile;
    let instrument = opts.instrument;
    if (instrument?.kind === "tof" && prof?.tof) instrument = { ...instrument, ...prof.tof };
    const bank = instprmTwoTheta(opts.rawInstrument?.text);
    const tofShape = prof?.tofProfile ?? tofShapeFromParams(opts.params, opts.instrument);
    const caglioti = prof?.caglioti
      ?? (prof?.peakWidth !== undefined ? { u: 0, v: 0, w: (prof.peakWidth * 100) ** 2 } : undefined);
    pcr = structureToPcr(structure, {
      ...base,
      ...(instrument ? { instrument } : {}),
      dataRange: [span.xMin, span.xMax],
      background: fullprofBackground(dataset, opts, span),
      ...(span.narrowed ? { excluded: span.excluded } : {}),
      ...(prof?.zero !== undefined ? { zero: prof.zero } : {}),
      ...(caglioti ? { caglioti } : {}),
      ...(prof?.lorentzian ? { lorentzian: prof.lorentzian } : {}),
      ...(prof?.axial ? { axial: prof.axial } : {}),
      ...(tofShape ? { tofShape } : {}),
      ...(bank !== undefined ? { twoThetaBank: bank } : {}),
    });
  }
  const entries: ZipEntry[] = [
    { name: `${name}.pcr`, data: pcr },
    { name: dataName, data },
  ];
  // Ship the user's exact originals verbatim (never the .pcr's own names, to
  // avoid clobbering the portable generated files).
  const reserved = new Set([`${name}.pcr`, dataName, "README.txt"]);
  const rawInstrName = addVerbatim(entries, opts.rawInstrument, reserved);
  const rawDataName = addVerbatim(entries, opts.rawData, reserved);
  entries.push({
    name: "README.txt",
    data: fullprofReadme({ name, sc, dataName, phases, opts, narrowed, rawInstrName, rawDataName }),
  });
  return entries;
}

/** Background anchors for the `.pcr`: the refined curve (exact at an
 *  interpolating background's own anchors, else sampled densely enough for
 *  FullProf's linear interpolation), or a windowed-minimum estimate from the
 *  data when no refined background is known. With a fit window the curve is
 *  sampled inside it only: a polynomial extrapolated into the excluded tails
 *  is meaningless (and can go negative). */
function fullprofBackground(
  pattern: PowderPattern,
  opts: BundleOptions,
  span: { readonly first: number; readonly last: number; readonly narrowed: boolean },
): (readonly [number, number])[] {
  const curve = opts.backgroundCurve;
  if (curve && pattern.points.length >= 2) {
    const anchors = opts.backgroundAnchors && !span.narrowed ? opts.backgroundAnchors : linspace(span.first, span.last, 24);
    return anchors.map((x) => [x, curve(x)] as const);
  }
  return windowedMinBackground(pattern);
}

/** Windowed-minimum background estimate (12 anchors) from the observed data. */
function windowedMinBackground(pattern: PowderPattern): (readonly [number, number])[] {
  const pts = pattern.points;
  if (pts.length < 2) return [];
  const nAnchors = 12;
  const background: [number, number][] = [];
  for (let i = 0; i < nAnchors; i++) {
    const lo = Math.floor((i * pts.length) / nAnchors);
    const hi = Math.floor(((i + 1) * pts.length) / nAnchors);
    let yMin = Infinity;
    let xAt = pts[lo]!.x;
    for (let j = lo; j < hi; j++) {
      const p = pts[j]!;
      if (p.yObs < yMin) { yMin = p.yObs; xAt = p.x; }
    }
    if (Number.isFinite(yMin)) background.push([xAt, Math.max(0, yMin)]);
  }
  return background;
}

/** Push a verbatim original file into the bundle under a zip-safe, non-colliding
 *  name; returns the name used (or undefined when there's nothing to add). */
function addVerbatim(
  entries: ZipEntry[],
  file: { readonly name: string; readonly text: string } | undefined,
  reserved: Set<string>,
): string | undefined {
  if (!file) return undefined;
  let out = sanitizeFilename(file.name) || "original.txt";
  while (reserved.has(out)) out = `original_${out}`;
  reserved.add(out);
  entries.push({ name: out, data: file.text });
  return out;
}

/** GSAS-II bundle: a `.cif` per phase + `.instprm` (powder) + data + build_gpx.py + README. */
export function gsas2Bundle(structure: StructureModel, dataset: DiffractionDataset, opts: BundleOptions = {}): ZipEntry[] {
  const name = sanitize(opts.name ?? structure.name);
  const sc = isSingleCrystal(dataset);
  const cif = structureToCif(structure, {
    blockName: name,
    ...(opts.params ? { params: opts.params } : {}),
    ...(opts.bindings ? { bindings: opts.bindings } : {}),
    ...(opts.refinement ? { refinement: opts.refinement } : {}),
    ...(opts.magneticLabel ? { magneticLabel: opts.magneticLabel } : {}),
  });
  const dataName = `${name}.${sc ? "hkl" : "xye"}`;
  const data = isSingleCrystal(dataset) ? singleCrystalHkl(dataset) : powderDataXye(dataset);
  const entries: ZipEntry[] = [{ name: `${name}.cif`, data: cif }, { name: dataName, data }];
  const reserved = new Set([`${name}.cif`, dataName, `${name}.gpx`, `${name}.instprm`, "build_gpx.py", "README.txt"]);

  // Further phases: one CIF each, at their refined values.
  const extraCifs: { cifFile: string; phaseName: string }[] = [];
  (opts.extraPhases ?? []).forEach((ph, i) => {
    const phaseName = sanitize(ph.structure.name || `phase${i + 2}`);
    let cifFile = `${phaseName}.cif`;
    while (reserved.has(cifFile)) cifFile = `phase${i + 2}_${cifFile}`;
    reserved.add(cifFile);
    entries.push({ name: cifFile, data: structureToCif(ph.structure, { blockName: phaseName }) });
    extraCifs.push({ cifFile, phaseName });
  });

  // The instrument, carrying the refined profile in GSAS-II units. A loaded
  // single-bank `.instprm` is patched (every other line kept verbatim) and the
  // untouched original ships alongside; a multi-bank file goes verbatim; with
  // no `.instprm` a complete one is generated from the model + refined profile.
  let instprmFile: string | undefined;
  let instprmMode: InstprmMode | undefined;
  let instNotes: string[] = [];
  let rawInstrName: string | undefined;
  if (!sc) {
    const inst = opts.instrument ?? deriveInstrument(dataset.radiation);
    const mapped = opts.profile
      ? gsas2InstrumentValues(inst.kind === "tof" ? "tof" : "cw", opts.profile)
      : { values: {}, notes: [] as string[] };
    instNotes = mapped.notes;
    const raw = opts.rawInstrument;
    if (raw && isInstprm(raw.name, raw.text)) {
      const patched = Object.keys(mapped.values).length > 0 ? patchInstprm(raw.text, mapped.values) : undefined;
      if (patched !== undefined) {
        instprmFile = `${name}.instprm`;
        entries.push({ name: instprmFile, data: patched });
        instprmMode = "patched";
        rawInstrName = addVerbatim(entries, raw, reserved);
      } else {
        instprmFile = sanitizeFilename(raw.name) || `${name}.instprm`;
        while (reserved.has(instprmFile) && instprmFile !== `${name}.instprm`) instprmFile = `original_${instprmFile}`;
        reserved.add(instprmFile);
        entries.push({ name: instprmFile, data: raw.text });
        instprmMode = "verbatim";
        rawInstrName = instprmFile;
        instNotes = [];
      }
    } else {
      instprmFile = `${name}.instprm`;
      entries.push({ name: instprmFile, data: instrumentToInstprm(inst, mapped.values) });
      instprmMode = "generated";
      rawInstrName = addVerbatim(entries, raw, reserved);
    }
  }

  // Fit limits + the refined background as GSAS-II 'lin interpolate' points,
  // spaced from the first to the last fitted point exactly as GSAS-II places them.
  let limits: [number, number] | undefined;
  let background: number[] | undefined;
  if (!isSingleCrystal(dataset)) {
    const span = powderSpan(dataset, opts.fitRange);
    if (span.narrowed) limits = [span.lo, span.hi];
    const curve = opts.backgroundCurve;
    if (curve) {
      const n = opts.backgroundAnchors && !span.narrowed ? opts.backgroundAnchors.length : 20;
      background = linspace(span.first, span.last, Math.max(n, 3)).map((x) => curve(x));
    }
  }
  const hklScale = isSingleCrystal(dataset) ? hklf4ScaleFactor(dataset) : 1;

  entries.push({
    name: "build_gpx.py",
    data: buildGpxScript({
      gpxName: `${name}.gpx`,
      cifFile: `${name}.cif`,
      phaseName: name,
      dataFile: dataName,
      histogramKind: sc ? "single" : "powder",
      ...(extraCifs.length ? { extraPhases: extraCifs } : {}),
      ...(instprmFile ? { instprmFile } : {}),
      ...(sc ? { dataFmthint: "HKLF" } : {}),
      ...(limits ? { limits } : {}),
      ...(background ? { background } : {}),
    }),
  });
  const rawDataName = addVerbatim(entries, opts.rawData, reserved);
  entries.push({
    name: "README.txt",
    data: gsas2Readme({
      name, sc, dataName, instprmFile, instprmMode, rawInstrName, rawDataName, instNotes,
      extraCifs: extraCifs.map((c) => c.cifFile), limits, background: background !== undefined, hklScale,
      notExported: opts.notExported ?? [], magnetic: opts.magneticLabel !== undefined,
    }),
  });
  return entries;
}

type InstprmMode = "patched" | "verbatim" | "generated";

/** A space-group symbol carrying an origin/setting suffix ("F d -3 m:2"). */
function hasSettingSuffix(structure: StructureModel): boolean {
  return /:/.test(structure.spaceGroup.hermannMauguin ?? "");
}

function fullprofReadme(r: {
  name: string;
  sc: boolean;
  dataName: string;
  phases: readonly PcrPhase[];
  opts: BundleOptions;
  narrowed: boolean;
  rawInstrName: string | undefined;
  rawDataName: string | undefined;
}): string {
  const { name, sc, dataName, phases, opts } = r;
  const lines = [
    `FullProf bundle for ${name} — generated by MATERIA Workbench.`,
    ``,
    `Files:`,
    `  ${name}.pcr   control file: ${phases.length} phase${phases.length > 1 ? "s" : ""} (cell, space group, atoms${sc ? "" : ", profile"}).`,
    `  ${dataName}   ${sc ? "single-crystal reflections (h k l F² σ cod), FullProf .int" : "powder data (X, Yobs, σ) with an XYDATA header — Ins = 10"}.`,
  ];
  if (r.rawInstrName) lines.push(`  ${r.rawInstrName}   your original instrument file, verbatim (for reference or the .pcr Irf).`);
  if (r.rawDataName) lines.push(`  ${r.rawDataName}   your original data file, verbatim (the exact input; ${dataName} is the portable re-serialization).`);
  lines.push(
    ``,
    `Run:  fp2k ${name}   (reads ${name}.pcr + ${dataName}; or open the .pcr in WinPLOTR / EdPCR).`,
    ``,
    `What carries over (refined values, all refinement codes 0):`,
    `  - every phase's cell, positions, ADPs (anisotropic as beta_ij, N_t = 2) and occupancies.`,
    `    Occ is in FullProf's convention: site fraction × m_site / m_general.`,
  );
  if (!sc) {
    lines.push(
      `  - zero shift, peak shape (${opts.instrument?.kind === "tof" ? "TOF Sig/alpha/beta, Npr 9" : "Caglioti U,V,W + Lorentzian X,Y + S_L/D_L, Npr 7"}),`,
      `    ${opts.instrument?.kind === "tof" ? "TOF calibration (Dtt1/Dtt2/Dtt_1overd)" : "wavelength"}, preferred orientation,`,
      `  - background as ${opts.backgroundCurve ? "the refined curve sampled at interpolation points" : "a data-minimum estimate (no refined background given)"}${r.narrowed ? "," : "."}`,
    );
    if (r.narrowed) lines.push(`  - the fit range, as excluded regions.`);
  }
  lines.push(
    ``,
    `Refine first in FullProf:`,
    `  - scale factor(s): FullProf's scale has different units (cell volume, scattering-length`,
    `    units), so the value is only a starting point — free the scale before comparing R-factors.`,
  );
  if (!sc && opts.instrument?.kind !== "tof") {
    lines.push(`  - X-ray data: check Cthm/Rpolarz (monochromator polarization) for your geometry.`);
  }
  const sigQ = opts.profile?.tofProfile?.sigQ ?? (opts.instrument?.kind === "tof" ? opts.instrument.sigQ : undefined) ?? 0;
  if (!sc && sigQ !== 0) {
    lines.push(
      `  - Sig-0 / Sig-1: the fit has a Gaussian term sigma^2 += ${+sigQ.toPrecision(6)}·d (GSAS-II sig-q), but`,
      `    FullProf's Sig-Q d-dependence is undocumented, so it was left 0 — refine Sig-0/Sig-1 to absorb it.`,
    );
  }
  if (opts.notExported && opts.notExported.length) {
    lines.push(``, `Not carried by this file (re-add in FullProf if needed): ${opts.notExported.join(", ")}.`);
  }
  if (phases.some((p) => hasSettingSuffix(p.structure))) {
    lines.push(``, `Space-group setting: a symbol with an origin/setting suffix (e.g. ":2") was written as-is;`, `confirm FullProf picks the same origin choice as the CIF.`);
  }
  lines.push(``);
  return lines.join("\n");
}

function gsas2Readme(r: {
  name: string;
  sc: boolean;
  dataName: string;
  instprmFile: string | undefined;
  instprmMode: InstprmMode | undefined;
  rawInstrName: string | undefined;
  rawDataName: string | undefined;
  instNotes: readonly string[];
  extraCifs: readonly string[];
  limits: readonly [number, number] | undefined;
  background: boolean;
  hklScale: number;
  notExported: readonly string[];
  magnetic: boolean;
}): string {
  const { name, sc, dataName } = r;
  const phases = [`${name}.cif`, ...r.extraCifs].join(", ");
  const instImport = sc || !r.instprmFile ? "" : `, ${r.instprmFile} (instrument)`;
  const lines = [
    `GSAS-II bundle for ${name} — generated by MATERIA Workbench.`,
    ``,
    `Option A — script (recommended): run  python build_gpx.py  (needs GSAS-II) to`,
    `           assemble ${name}.gpx via GSASIIscriptable${sc ? "" : ", with the fit limits and background set"}.`,
    `Option B — GUI: import ${phases} (phase${r.extraCifs.length ? "s" : ""})${instImport} and ${dataName} (data).`,
    ``,
    `The .gpx is a GSAS-II internal (pickled) project, so it is built by the`,
    `script rather than written directly.`,
  ];
  if (r.instprmMode === "patched") {
    lines.push(``, `Instrument: ${r.instprmFile} is your original .instprm with the refined profile`, `(zero, peak shape${sc ? "" : ", calibration"}) written in; every other line is unchanged.`, `The untouched original is ${r.rawInstrName}.`);
  } else if (r.instprmMode === "verbatim") {
    lines.push(``, `Instrument: ${r.instprmFile} is your original .instprm, used verbatim (a multi-bank`, `file is not patched) — refine the profile in GSAS-II before comparing.`);
  } else if (r.instprmMode === "generated") {
    lines.push(``, `Instrument: ${r.instprmFile} was generated from the refined instrument model.`);
    if (r.rawInstrName) lines.push(`Your original instrument file is included verbatim as ${r.rawInstrName}.`);
  }
  if (r.instNotes.length) lines.push(``, `Profile terms GSAS-II cannot express:`, ...r.instNotes.map((n) => `  - ${n}`));
  if (!sc) {
    if (r.limits) lines.push(``, `Fit limits ${+r.limits[0].toPrecision(8)} – ${+r.limits[1].toPrecision(8)} are set by build_gpx.py.`);
    if (r.background) lines.push(``, `Background: the refined curve, as GSAS-II 'lin interpolate' points (set by build_gpx.py, not refined).`);
  }
  if (sc && r.hklScale !== 1) {
    lines.push(``, `Intensities in ${dataName} are multiplied by ${r.hklScale} to fit SHELX HKLF4's fixed F8.2 columns;`, `only the scale factor absorbs this.`);
  }
  lines.push(``, `Refine first in GSAS-II: the histogram scale / phase fractions (not transferred).`);
  if (r.notExported.length) lines.push(``, `Not carried by these files (re-add in GSAS-II if needed): ${r.notExported.join(", ")}.`);
  if (r.magnetic) lines.push(``, `${name}.cif is a magnetic CIF: import it as a magnetic phase in GSAS-II.`);
  if (r.rawDataName) lines.push(``, `Your original data file is included verbatim as ${r.rawDataName} (the exact input;`, `${dataName} is the portable re-serialization the script imports).`);
  lines.push(``);
  return lines.join("\n");
}
