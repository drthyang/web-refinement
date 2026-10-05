/**
 * Diffraction-data writers for the export bundles: powder XYE (GSAS-II), the
 * FullProf XYDATA variant (Ins = 10), single-crystal SHELX HKLF4 (GSAS-II), and
 * FullProf single-crystal `.int`. Pure string producers.
 */

import type { PowderPattern, SingleCrystalDataset, Radiation } from "@/core/diffraction/types";
import { writeFullProfInt } from "@/core/export/fullprofInt";

/** Wavelength for a radiation, or 0 for TOF (which has none). */
export function radiationWavelength(radiation: Radiation): number {
  return radiation.kind === "neutron-tof" ? 0 : radiation.wavelength;
}

function xyeRows(pattern: PowderPattern): string[] {
  return pattern.points.map((p) => `${p.x} ${p.yObs} ${p.sigma ?? Math.sqrt(Math.max(p.yObs, 1))}`);
}

/** Three-column X / Yobs / esd (GSAS-II XYE). */
export function powderDataXye(pattern: PowderPattern): string {
  return xyeRows(pattern).join("\n") + "\n";
}

/**
 * FullProf X / Y / σ data (Ins = 10): the `XYDATA` keyword followed by exactly
 * five header lines, then the three columns — the layout of the POWGEN files
 * FullProf reads (`data/POWGEN_examples/FullProf`).
 */
export function powderDataFullProf(pattern: PowderPattern, title?: string): string {
  const unit = pattern.xUnit === "tof" ? "Time-of-flight (us)" : pattern.xUnit === "twoTheta" ? "2-theta (deg)" : pattern.xUnit;
  const rad = pattern.radiation.kind === "neutron-tof"
    ? "neutron TOF"
    : `${pattern.radiation.kind}, lambda = ${pattern.radiation.wavelength} A`;
  const header = [
    "XYDATA",
    `# ${title ?? pattern.name} - exported by MATERIA Workbench`,
    `# Radiation: ${rad}`,
    `# X-axis: ${unit}`,
    `# Points: ${pattern.points.length}`,
    `# X              Yobs              Sigma`,
  ];
  return [...header, ...xyeRows(pattern)].join("\n") + "\n";
}

/**
 * Power-of-ten factor that fits single-crystal intensities into SHELX HKLF4's
 * fixed F8.2 columns: down when the largest |I| or σ would overflow 99999.99,
 * up when the data are so small that two decimals would erase them (max < 100).
 * 1 otherwise. Only the refined scale factor absorbs it.
 */
export function hklf4ScaleFactor(dataset: SingleCrystalDataset): number {
  let max = 0;
  for (const r of dataset.reflections) max = Math.max(max, Math.abs(r.iObs), Math.abs(r.sigma ?? 0));
  if (max <= 0 || !Number.isFinite(max)) return 1;
  if (max >= 99999.995) return 10 ** -Math.ceil(Math.log10(max / 99999.99));
  if (max < 100) return 10 ** Math.floor(Math.log10(99999.99 / max));
  return 1;
}

/** SHELX HKLF4 (h k l F² σ, fixed 3I4,2F8.2), 000-terminated — GSAS-II single
 *  crystal. Intensities are multiplied by {@link hklf4ScaleFactor}. */
export function singleCrystalHkl(dataset: SingleCrystalDataset): string {
  const f = hklf4ScaleFactor(dataset);
  const i4 = (n: number) => String(Math.round(n)).padStart(4);
  const f8 = (n: number) => n.toFixed(2).padStart(8);
  const lines = dataset.reflections.map((r) => `${i4(r.h)}${i4(r.k)}${i4(r.l)}${f8(r.iObs * f)}${f8((r.sigma ?? 0) * f)}`);
  lines.push(`${i4(0)}${i4(0)}${i4(0)}${f8(0)}${f8(0)}`); // HKLF4 terminator
  return lines.join("\n") + "\n";
}

/** FullProf single-crystal `.int` (h k l F² σ cod). The float columns are sized
 *  to the data (FullProf reads the declared Fortran format), so neither large
 *  counts overflow nor small intensities lose their digits. */
export function singleCrystalInt(dataset: SingleCrystalDataset): string {
  let max = 0;
  for (const r of dataset.reflections) max = Math.max(max, Math.abs(r.iObs), Math.abs(r.sigma ?? 0));
  const decimals = max >= 1e5 ? 2 : max >= 100 ? 3 : 5;
  const width = Math.max(10, (Math.floor(max) < 1 ? 1 : Math.floor(Math.log10(Math.floor(max))) + 1) + decimals + 3);
  return writeFullProfInt(dataset.reflections, {
    title: "Crystal",
    format: `(3i4,2f${width}.${decimals},i4)`,
    wavelength: radiationWavelength(dataset.radiation),
  });
}
