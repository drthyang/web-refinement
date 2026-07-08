/**
 * Bundled Mn₃Ga POWGEN 600 K time-of-flight neutron dataset — the default
 * example the workbench opens with. The observed pattern is embedded (a `?raw`
 * import) so it ships with the production build and needs no runtime fetch or
 * local `data/` folder. The data is published (Zhang et al., POWGEN long-scan,
 * 600 K, λ = 0.8 Å); the structure is the bundled P6₃/mmc model and difC is read
 * from the .gsa bank header.
 */

import patternText from "@/examples/datasets/mn3ga_powgen_600k.dat?raw";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parsePowderData } from "@/parsers/powderData";
import { exampleStructure } from "@/examples/mn3ga";

// From the PG3_45607.gsa bank header: "DIFC 22585.8" (POWGEN 600 K, λ = 0.8 Å).
const DIF_C = 22585.8;

export interface Mn3GaPowgenExample {
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly instrument: InstrumentParameters;
}

let cached: Mn3GaPowgenExample | null = null;

/** The bundled Mn₃Ga POWGEN TOF example (parsed once, memoized). */
export function mn3gaPowgenExample(): Mn3GaPowgenExample {
  if (cached) return cached;
  const structure: StructureModel = { ...exampleStructure(), id: "mn3ga" };
  const pattern = parsePowderData(patternText, {
    id: "mn3ga-powder",
    name: "Mn₃Ga POWGEN 600 K (TOF, λ=0.8 Å)",
    xUnit: "tof",
    radiation: { kind: "neutron-tof" },
  });
  cached = { structure, pattern, instrument: { kind: "tof", difC: DIF_C } };
  return cached;
}
