/**
 * Test-support readers for the Mn₃Sn mCIFs the mPDF real-data goldens use.
 * They are diffpy.mpdf output: all 16 atoms of the Ama2 cell, no symmetry at
 * all (read as P 1, the CIF default), no BNS operations, and one moment row per
 * Mn — label + 3 crystal-axis components, no symmetry to apply.
 */
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseCif } from "@/parsers/cif";

/**
 * The nuclear cell. Read with parseCif, not parseMagneticCif: the moment loop
 * declares a `symmform` column that no row fills, which a strict loop reader
 * rejects, and the moments come from {@link readMcifMomentLoop} anyway.
 */
export function readMcifStructure(text: string, id: string): StructureModel {
  return parseCif(text, id);
}

export function readMcifMomentLoop(text: string): Map<string, Vec3> {
  const moments = new Map<string, Vec3>();
  let inLoop = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^_atom_site_moment\.label/i.test(line)) inLoop = true;
    if (!inLoop || line.startsWith("_") || line === "" || line.toLowerCase() === "loop_") continue;
    const toks = line.split(/\s+/);
    if (toks.length < 4) continue;
    const v = toks.slice(1, 4).map(Number);
    if (v.every(Number.isFinite)) moments.set(toks[0]!, v as [number, number, number]);
  }
  return moments;
}
