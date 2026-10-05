/**
 * Test-support readers for the Mn₃Sn mCIFs the mPDF real-data goldens use.
 * These are diffpy output: no symmetry at all (no symbol, no Hall symbol, no
 * operations) and all 16 atoms of the Ama2 cell listed, with one moment row
 * per Mn — label + 3 crystal-axis components, no symmetry to apply.
 */
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseCif } from "@/parsers/cif";

/**
 * The nuclear cell, read as P 1. A CIF with no symmetry is an error unless
 * the reader is told its atom list is the whole cell; that is true here, so
 * the tests say so. The structure only: the moment loop declares a `symmform`
 * column that no row fills, which a strict loop reader rejects.
 */
export function readMcifStructure(text: string, id: string): StructureModel {
  return parseCif(text, id, { spaceGroupSetting: "P 1" });
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
