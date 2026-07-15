/**
 * Export-bundle assembler: turns a refinement (structure + dataset + instrument
 * + refined parameters) into the set of files a user drops into FullProf or
 * GSAS-II. Pure — returns `ZipEntry[]`; the UI zips (via zipStore) and downloads.
 *
 * Two program-specific bundles (one click each):
 *  - FullProf: `<name>.pcr` + data (`.dat`/`.int`) + README
 *  - GSAS-II:  `<name>.cif` + `.instprm` (powder) + data (`.xye`/`.hkl`) +
 *              `build_gpx.py` + README
 */

import type { StructureModel } from "@/core/crystal/types";
import type { DiffractionDataset, Radiation } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import type { ZipEntry } from "@/core/export/zip";
import { structureToCif, type CifRefinementMeta } from "@/core/export/cif";
import { structureToPcr, type PcrExportOptions } from "@/core/export/fullprof";
import { instrumentToInstprm, buildGpxScript } from "@/core/export/gsas2";
import { powderDataXye, singleCrystalHkl, singleCrystalInt, radiationWavelength } from "@/core/export/data";

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
  /** The user's original instrument file (verbatim). When it is a GSAS-II
   *  `.instprm` it is used directly instead of regenerating from the (lossy)
   *  instrument model; otherwise it is shipped alongside as the exact source. */
  readonly rawInstrument?: { readonly name: string; readonly text: string };
  /** The user's original data file (verbatim), shipped alongside the portable
   *  re-serialized data so the exact input travels with the bundle. */
  readonly rawData?: { readonly name: string; readonly text: string };
}

function isSingleCrystal(dataset: DiffractionDataset): dataset is Extract<DiffractionDataset, { reflections: unknown }> {
  return "reflections" in dataset;
}

/** Pull the refined TOF peak-shape coefficients out of the parameter list so the
 *  `.pcr` carries the fitted profile rather than a generic seed. The refinement
 *  ids are `tof_<key>` (see buildStructureRefinement). When an isotropic TOF
 *  Mustrain was refined instead of σ₁², fold its σ_T² ≈ (difC·ε)²·d² contribution
 *  back into Sig-1 (ε = mustrainIso × 10⁻⁶) so the exported width isn't missing
 *  the sample-broadening the fit put there. */
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
    const eps = mustrain * 1e-6;
    shape.sig1 = (shape.sig1 ?? 0) + (instrument.difC * eps) ** 2;
  }
  return Object.keys(shape).length > 0 ? shape : undefined;
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

/** A minimal instrument when the caller doesn't supply full parameters. */
function deriveInstrument(radiation: Radiation): InstrumentParameters {
  if (radiation.kind === "neutron-tof") return { kind: "tof", difC: 0 };
  return {
    kind: "constantWavelength",
    wavelength: radiation.wavelength,
    radiationKind: radiation.kind === "xray" ? "xray" : "neutron",
  };
}

/** FullProf bundle: `.pcr` + data + README (+ verbatim originals when present). */
export function fullprofBundle(structure: StructureModel, dataset: DiffractionDataset, opts: BundleOptions = {}): ZipEntry[] {
  const name = sanitize(opts.name ?? structure.name);
  const sc = isSingleCrystal(dataset);
  const dataName = `${name}.${sc ? "int" : "dat"}`;
  const data = isSingleCrystal(dataset) ? singleCrystalInt(dataset) : powderDataXye(dataset);
  const wl = radiationWavelength(dataset.radiation);
  const powderRange = !sc ? powderDataRange(dataset as Extract<DiffractionDataset, { points: unknown }>) : undefined;
  const tofShape = tofShapeFromParams(opts.params, opts.instrument);
  const pcr = structureToPcr(structure, {
    title: name,
    datFile: dataName,
    ...(wl ? { wavelength: wl } : {}),
    ...(opts.instrument ? { instrument: opts.instrument } : {}),
    ...(powderRange ? { dataRange: powderRange.range, background: powderRange.background } : {}),
    ...(tofShape ? { tofShape } : {}),
  });
  const entries: ZipEntry[] = [
    { name: `${name}.pcr`, data: pcr },
    { name: dataName, data },
  ];
  // Ship the user's exact originals verbatim (never the .pcr's own names, to
  // avoid clobbering the portable generated files).
  const reserved = new Set([`${name}.pcr`, dataName]);
  const rawInstrName = addVerbatim(entries, opts.rawInstrument, reserved);
  const rawDataName = addVerbatim(entries, opts.rawData, reserved);
  entries.push({ name: "README.txt", data: fullprofReadme(name, sc, dataName, rawInstrName, rawDataName) });
  return entries;
}

/** Observed abscissa span + a windowed-minimum background estimate for the
 *  `.pcr` (FullProf linearly interpolates the anchor points). Real background
 *  from the data beats a flat placeholder as a re-refinement starting point. */
function powderDataRange(
  dataset: { readonly points: readonly { readonly x: number; readonly yObs: number }[] },
): { range: readonly [number, number]; background: readonly (readonly [number, number])[] } | undefined {
  const pts = dataset.points;
  if (pts.length < 2) return undefined;
  const xMin = pts[0]!.x;
  const xMax = pts[pts.length - 1]!.x;
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
  return { range: [xMin, xMax], background };
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

/** GSAS-II bundle: `.cif` + `.instprm` (powder) + data + build_gpx.py + README. */
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
  const reserved = new Set([`${name}.cif`, dataName, `${name}.gpx`, "build_gpx.py", "README.txt"]);

  // The instrument model is lossy (difC/λ + a few widths, not the full TOF peak
  // shape), so when the user loaded a real GSAS-II `.instprm` we ship it verbatim
  // and point the build script at it; otherwise we generate one from the model.
  let instprmFile: string | undefined;
  let verbatimInstprm = false;
  if (!sc) {
    if (opts.rawInstrument && isInstprm(opts.rawInstrument.name, opts.rawInstrument.text)) {
      instprmFile = sanitizeFilename(opts.rawInstrument.name) || `${name}.instprm`;
      while (reserved.has(instprmFile)) instprmFile = `original_${instprmFile}`;
      reserved.add(instprmFile);
      entries.push({ name: instprmFile, data: opts.rawInstrument.text });
      verbatimInstprm = true;
    } else {
      instprmFile = `${name}.instprm`;
      reserved.add(instprmFile);
      entries.push({ name: instprmFile, data: instrumentToInstprm(opts.instrument ?? deriveInstrument(dataset.radiation)) });
    }
  }
  entries.push({
    name: "build_gpx.py",
    data: buildGpxScript({
      gpxName: `${name}.gpx`,
      cifFile: `${name}.cif`,
      phaseName: name,
      dataFile: dataName,
      histogramKind: sc ? "single" : "powder",
      ...(instprmFile ? { instprmFile } : {}),
      ...(sc ? { dataFmthint: "HKLF" } : {}),
    }),
  });
  // Ship the exact originals too: the instrument only when it wasn't already
  // adopted verbatim above, and the data always (alongside the portable .xye/.hkl).
  const rawInstrName = verbatimInstprm ? instprmFile : addVerbatim(entries, opts.rawInstrument, reserved);
  const rawDataName = addVerbatim(entries, opts.rawData, reserved);
  entries.push({ name: "README.txt", data: gsas2Readme(name, sc, dataName, instprmFile, verbatimInstprm, rawInstrName, rawDataName) });
  return entries;
}

function fullprofReadme(name: string, sc: boolean, dataName: string, rawInstrName?: string, rawDataName?: string): string {
  const lines = [
    `FullProf bundle for ${name} — generated by MATERIA Workbench.`,
    ``,
    `Files:`,
    `  ${name}.pcr   control + phase (cell, space group, atoms). Open in FullProf/WinPLOTR.`,
    `  ${dataName}   ${sc ? "single-crystal reflections (h k l F² σ)" : "powder data (2θ/TOF, Yobs, esd)"}.`,
  ];
  if (rawInstrName) lines.push(`  ${rawInstrName}   your original instrument file, verbatim (e.g. point the .pcr Irf at it, or cross-check).`);
  if (rawDataName) lines.push(`  ${rawDataName}   your original data file, verbatim (the exact input; ${dataName} is the portable re-serialization).`);
  lines.push(
    ``,
    `Refined values are written; refinement flags are 0 (a reproducible model).`,
    sc ? `` : `Confirm the data-format code (Ins) in the .pcr matches your FullProf setup.`,
    ``,
  );
  return lines.join("\n");
}

function gsas2Readme(
  name: string,
  sc: boolean,
  dataName: string,
  instprmFile?: string,
  verbatimInstprm?: boolean,
  rawInstrName?: string,
  rawDataName?: string,
): string {
  const instImport = sc || !instprmFile ? "" : `, ${instprmFile} (instrument)`;
  const lines = [
    `GSAS-II bundle for ${name} — generated by MATERIA Workbench.`,
    ``,
    `Option A — GUI: import ${name}.cif (phase)${instImport} and ${dataName} (data).`,
    `Option B — script: run  python build_gpx.py  (needs GSAS-II installed) to`,
    `           assemble ${name}.gpx directly via GSASIIscriptable.`,
    ``,
    `The .gpx is a GSAS-II internal (pickled) project, so it is built by the`,
    `script rather than written directly.`,
  ];
  if (verbatimInstprm) {
    lines.push(``, `Instrument: ${instprmFile} is your original .instprm, used verbatim (not`, `regenerated) — the exact peak-shape profile you loaded.`);
  }
  if (rawInstrName && !verbatimInstprm) lines.push(``, `Your original instrument file is included verbatim as ${rawInstrName} for reference.`);
  if (rawDataName) lines.push(``, `Your original data file is included verbatim as ${rawDataName} (the exact input;`, `${dataName} is the portable re-serialization the script imports).`);
  lines.push(``);
  return lines.join("\n");
}
