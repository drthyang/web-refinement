/**
 * Runtime loader for the real Mn₃Ga POWGEN 600 K time-of-flight neutron dataset
 * in the git-ignored `data/` folder. Like {@link loadPowgenDefault} this only
 * succeeds in development (the Vite `serve-local-data` plugin exposes `data/`);
 * in production every fetch 404s and the app keeps its bundled structure.
 *
 * The dataset's CIF is empty on disk, so the structure comes from the bundled
 * `MN3GA_CIF` (the same P6₃/mmc model, validated against GSAS-II Fc² in
 * neutronSfValidation.test.ts). The TOF calibration constant difC is read from
 * the `.gsa` bank header (there is no `.instprm` in the folder).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parseCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { MN3GA_CIF } from "@/examples/mn3ga";

const DIR = "data/Mn3Ga_POWGEN_600K";
const DAT = "PG3_45607-1.dat";
const STRUCTURE_ID = "mn3ga";
const PATTERN_ID = "mn3ga-powder";

// From the PG3_45607.gsa bank header: "Total flight path 63.18m, tth 90deg,
// DIFC 22585.8". POWGEN long-scan 600 K, λ = 0.8 Å.
const DIF_C = 22585.8;

export interface LoadedMn3Ga {
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly instrument: InstrumentParameters;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Attempt to load the bundled-in-`data/` Mn₃Ga POWGEN TOF dataset. Resolves to a
 * parsed structure + TOF pattern + instrument, or `null` when the data is not
 * reachable (production, or a checkout without the local `data/` folder).
 */
export async function loadMn3GaPowgen(): Promise<LoadedMn3Ga | null> {
  const datText = await fetchText(`${import.meta.env.BASE_URL}${DIR}/${DAT}`);
  if (datText === null) return null;
  try {
    const structure: StructureModel = { ...parseCif(MN3GA_CIF, STRUCTURE_ID), id: STRUCTURE_ID };
    const pattern = parsePowderData(datText, {
      id: PATTERN_ID,
      name: "Mn₃Ga POWGEN 600 K (TOF, λ=0.8 Å)",
      xUnit: "tof",
      radiation: { kind: "neutron-tof" },
    });
    if (pattern.points.length < 3) return null;
    return { structure, pattern, instrument: { kind: "tof", difC: DIF_C } };
  } catch {
    return null;
  }
}
