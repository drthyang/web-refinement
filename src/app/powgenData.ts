/**
 * Runtime loader for the real POWGEN high-entropy dataset that lives in the
 * git-ignored `data/` folder. In development the Vite `serve-local-data` plugin
 * exposes `data/` over HTTP, so the app fetches the structure, TOF pattern, and
 * instrument on startup and opens *real data* instead of a synthetic demo. On a
 * production build (or any environment where `data/` is absent) every fetch
 * 404s, `loadPowgenDefault` resolves to `null`, and the app keeps its bundled
 * high-entropy structure. Nothing here throws.
 *
 * The POWGEN pattern is time-of-flight neutron data; the engine profile-fits
 * constant-wavelength only, so it loads **view-only** until TOF profile
 * refinement lands (roadmap M1).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parsePowderData } from "@/parsers/powderData";
import { detectDataFormat } from "@/parsers/detectFormat";

const DIR = "data/POWGEN_HighEntropy_100K";
const CIF = "100K_HR_Co1_Fe1_Mn1_Ni1_O1_W1_Zn1.cif";
const INSTPRM = "GSAS2_2025B_HighRes_60HzB3_CWL2p665.instprm";
const DAT = "PG3_61133-3.dat";

const STRUCTURE_ID = "powgen";
const PATTERN_ID = "powgen-powder";

export interface LoadedPowgen {
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly instrument: InstrumentParameters;
  /** True when the pattern is TOF (currently view-only in the engine). */
  readonly isTof: boolean;
}

/** Fetch a text file, returning null on any non-OK response or network error. */
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
 * Attempt to load the bundled-in-`data/` POWGEN high-entropy dataset. Resolves to
 * a fully parsed structure + pattern + instrument, or `null` when the data is not
 * reachable (production, or a checkout without the local `data/` folder).
 */
export async function loadPowgenDefault(): Promise<LoadedPowgen | null> {
  const root = `${import.meta.env.BASE_URL}${DIR}`;
  const [cifText, instText, datText] = await Promise.all([
    fetchText(`${root}/${CIF}`),
    fetchText(`${root}/${INSTPRM}`),
    fetchText(`${root}/${DAT}`),
  ]);
  if (cifText === null || datText === null) return null;

  try {
    const structure: StructureModel = { ...parseCif(cifText, STRUCTURE_ID), id: STRUCTURE_ID };
    const instrument = instText !== null ? parseInstrumentParameters(instText) : { kind: "tof" as const, difC: 22600 };
    const fmt = detectDataFormat({ text: datText, filename: DAT, instrument });
    const pattern = parsePowderData(datText, {
      id: PATTERN_ID,
      name: "POWGEN high-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄ 100 K",
      xUnit: fmt.xUnit,
      radiation: fmt.radiation,
    });
    if (pattern.points.length < 3) return null;
    return { structure, pattern, instrument, isTof: fmt.xUnit === "tof" };
  } catch {
    return null;
  }
}
