/**
 * Test-support reader for the `_atom_site_moment` loop of an explicit-P1 mCIF
 * (no BNS operations — parseMagneticCif carries no magnetic model for these,
 * the moment rows being exactly label + 3 crystal-axis components with no
 * symmetry to apply). Used by the Mn₃Sn mPDF real-data goldens.
 */
import type { Vec3 } from "@/core/math/types";

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
