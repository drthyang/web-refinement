/**
 * Bundled Mn₃Ga POWGEN 600 K time-of-flight neutron dataset — the default
 * example the workbench opens with. The observed pattern is embedded (a `?raw`
 * import) so it ships with the production build and needs no runtime fetch or
 * local `data/` folder. The data is published (Zhang et al., POWGEN long-scan,
 * 600 K, λ = 0.8 Å); the structure is the bundled P6₃/mmc model and difC is read
 * from the .gsa bank header.
 *
 * The real sample carries a rock-salt MnO impurity, so the example opens as a
 * two-phase (Mn₃Ga + MnO) refinement — the textbook multi-phase demo.
 */

import patternText from "@/examples/datasets/mn3ga_powgen_600k.dat?raw";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parsePowderData } from "@/parsers/powderData";
import { parseCif } from "@/parsers/cif";
import { exampleStructure } from "@/examples/mn3ga";

// From the PG3_45607.gsa bank header: "DIFC 22585.8" (POWGEN 600 K, λ = 0.8 Å).
const DIF_C = 22585.8;

// Rock-salt MnO (Fm-3m) — the common impurity phase in this Mn₃Ga sample. The
// H-M name alone resolves the full group from the built-in space-group table.
const MNO_CIF = `data_MnO
_pd_phase_name  MnO
_cell_length_a  4.446
_cell_length_b  4.446
_cell_length_c  4.446
_cell_angle_alpha  90
_cell_angle_beta   90
_cell_angle_gamma  90
_symmetry_space_group_name_H-M  "F m -3 m"
loop_
  _atom_site_type_symbol
  _atom_site_label
  _atom_site_fract_x
  _atom_site_fract_y
  _atom_site_fract_z
  _atom_site_occupancy
  _atom_site_U_iso_or_equiv
  Mn Mn1 0 0 0 1 0.006
  O  O1  0.5 0.5 0.5 1 0.006
`;

export interface Mn3GaPowgenExample {
  readonly structure: StructureModel;
  /** Additional crystallographic phases in the sample (here: the MnO impurity). */
  readonly extraPhases: StructureModel[];
  readonly pattern: PowderPattern;
  readonly instrument: InstrumentParameters;
}

let cached: Mn3GaPowgenExample | null = null;

/** The bundled Mn₃Ga + MnO POWGEN TOF example (parsed once, memoized). */
export function mn3gaPowgenExample(): Mn3GaPowgenExample {
  if (cached) return cached;
  const structure: StructureModel = { ...exampleStructure(), id: "mn3ga" };
  const mno: StructureModel = { ...parseCif(MNO_CIF, "mno"), id: "mno" };
  const pattern = parsePowderData(patternText, {
    id: "mn3ga-powder",
    name: "Mn₃Ga POWGEN 600 K (TOF, λ=0.8 Å)",
    xUnit: "tof",
    radiation: { kind: "neutron-tof" },
  });
  cached = { structure, extraPhases: [mno], pattern, instrument: { kind: "tof", difC: DIF_C } };
  return cached;
}
