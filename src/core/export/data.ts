/**
 * Diffraction-data writers for the export bundles: powder XYE, single-crystal
 * SHELX HKLF4 (GSAS-II), and FullProf single-crystal `.int`. Pure string
 * producers.
 */

import type { PowderPattern, SingleCrystalDataset, Radiation } from "@/core/diffraction/types";
import { writeFullProfInt } from "@/parsers/fullprofInt";

/** Wavelength for a radiation, or 0 for TOF (which has none). */
export function radiationWavelength(radiation: Radiation): number {
  return radiation.kind === "neutron-tof" ? 0 : radiation.wavelength;
}

/** Three-column X / Yobs / esd (GSAS-II XYE; also FullProf free-format readable). */
export function powderDataXye(pattern: PowderPattern): string {
  return (
    pattern.points
      .map((p) => `${p.x} ${p.yObs} ${p.sigma ?? Math.sqrt(Math.max(p.yObs, 1))}`)
      .join("\n") + "\n"
  );
}

/** SHELX HKLF4 (h k l F² σ, fixed 3I4,2F8.2), 000-terminated — GSAS-II single crystal. */
export function singleCrystalHkl(dataset: SingleCrystalDataset): string {
  const i4 = (n: number) => String(Math.round(n)).padStart(4);
  const f8 = (n: number) => n.toFixed(2).padStart(8);
  const lines = dataset.reflections.map((r) => `${i4(r.h)}${i4(r.k)}${i4(r.l)}${f8(r.iObs)}${f8(r.sigma ?? 0)}`);
  lines.push(`${i4(0)}${i4(0)}${i4(0)}${f8(0)}${f8(0)}`); // HKLF4 terminator
  return lines.join("\n") + "\n";
}

/** FullProf single-crystal `.int` (h k l F² σ, format 3i4,2f8.2). Delegates to
 *  the full-format writer with the historical minimal format (no cod column). */
export function singleCrystalInt(dataset: SingleCrystalDataset): string {
  return writeFullProfInt(dataset.reflections, {
    title: "Crystal",
    format: "(3i4,2f8.2)",
    wavelength: radiationWavelength(dataset.radiation),
  });
}
