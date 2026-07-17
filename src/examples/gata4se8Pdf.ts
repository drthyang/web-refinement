/**
 * The bundled PDF demo: GaTa4Se8 (lacunar spinel) room-temperature X-ray PDF
 * from NSLS-II 28-ID, fitted with the cubic F-4̄3m average structure — the
 * real-space sibling of the Mn₃Ga Rietveld demo. Ships a CONVERGED snapshot
 * (Rw ≈ 8.12 % over 1.5–28 Å; anisotropic ADPs + δ1/δ2 correlated motion +
 * refined Qdamp/Qbroad) so the demo opens on a finished refinement.
 * Regenerate the snapshot if the engine or the bundled data changes.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { parseCif } from "@/parsers/cif";
import { parsePdfData } from "@/parsers/pdfData";
import { GATA4SE8_CIF, GATA4SE8_GR } from "@/examples/gata4se8PdfData";

export interface GaTa4Se8PdfExample {
  readonly structure: StructureModel;
  readonly pattern: PdfPattern;
  /** Converged values (id → value), applied after the spec rebuild. */
  readonly refinedParams: Record<string, number>;
  /** The demo's fit window (Å). */
  readonly fitRange: { readonly min: number; readonly max: number };
}

const REFINED_PARAMS: Record<string, number> = {
  "pdfScale": 0.08841345878634771,
  "qdamp": 0.04140937804507563,
  "qbroad": 0.023277299927715506,
  "delta1": 0.941085579980636,
  "delta2": 1.621115413684193,
  "spdiameter": 0,
  "sratio": 1,
  "rcut": 0,
  "cell_a": 10.368304954883838,
  "U_Ga1_0": 0.010622129581449325,
  "U_Ta1_0": 0.0070680036554367056,
  "U_Ta1_1": 0.0005820235085419343,
  "U_Se1_0": 0.009535822060206573,
  "U_Se1_1": 0.0001984359326557625,
  "U_Se2_0": 0.00968962814917445,
  "U_Se2_1": 0.0009243800880817326,
  "pos_Ta1_0": 0,
  "pos_Se1_0": 0,
  "pos_Se2_0": 0,
  "occ_Ga1": 1,
  "occ_Ta1": 1,
  "occ_Se1": 1,
  "occ_Se2": 1
};

let cached: GaTa4Se8PdfExample | null = null;

export function gata4se8PdfExample(): GaTa4Se8PdfExample {
  if (cached) return cached;
  const structure: StructureModel = { ...parseCif(GATA4SE8_CIF, "gata4se8"), name: "GaTa4Se8" };
  const pattern = parsePdfData(GATA4SE8_GR, { id: "gata4se8-pdf", name: "GaTa4Se8 299 K X-ray PDF (28-ID)" });
  cached = { structure, pattern, refinedParams: REFINED_PARAMS, fitRange: {"min":1.5,"max":28} };
  return cached;
}
