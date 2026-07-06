/**
 * Bundled example: the Mn₃Ga hexagonal structure (P6₃/mmc) from the GSAS-II
 * validation data. Embedded as CIF text so the deployed static app has a real
 * structure to work with out of the box, plus a synthetic neutron powder
 * pattern generated from it.
 */

import { parseCif } from "@/parsers/cif";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { powderCurves } from "@/core/workflow/powder";
import { singleCrystalComparison } from "@/core/workflow/singleCrystal";
import { generateReflections } from "@/core/diffraction/reflections";

export const MN3GA_CIF = `data_Mn3Ga
_pd_phase_name  Mn3Ga
_cell_length_a  5.42215
_cell_length_b  5.42215
_cell_length_c  4.375658
_cell_angle_alpha  90
_cell_angle_beta   90
_cell_angle_gamma  120
_cell_volume  111.408
_symmetry_cell_setting  hexagonal
_symmetry_space_group_name_H-M  "P 63/m m c"
loop_
    _space_group_symop_id
    _space_group_symop_operation_xyz
     1  x,y,z
     2  x-y,x,1/2+z
     3  -y,x-y,z
     4  -x,-y,1/2+z
     5  y-x,-x,z
     6  y,y-x,1/2+z
     7  y-x,y,z
     8  -x,y-x,1/2+z
     9  -y,-x,z
    10  x-y,-y,1/2+z
    11  x,x-y,z
    12  y,x,1/2+z
    13  -x,-y,-z
    14  y-x,-x,1/2-z
    15  y,y-x,-z
    16  x,y,1/2-z
    17  x-y,x,-z
    18  -y,x-y,1/2-z
    19  x-y,-y,-z
    20  x,x-y,1/2-z
    21  y,x,-z
    22  y-x,y,1/2-z
    23  -x,y-x,-z
    24  -y,-x,1/2-z
loop_
   _atom_site_label
   _atom_site_type_symbol
   _atom_site_fract_x
   _atom_site_fract_y
   _atom_site_fract_z
   _atom_site_occupancy
   _atom_site_adp_type
   _atom_site_U_iso_or_equiv
   _atom_site_site_symmetry_multiplicity
Mn1    Mn   0.16393     0.32775     0.25000     0.978(9)   Uiso 0.0142     6
Ga1    Ga   0.33330     0.66670     0.75000     1.005(8)   Uiso 0.0093     2
`;

export function exampleStructure(): StructureModel {
  return parseCif(MN3GA_CIF, "mn3ga");
}

const NEUTRON = { kind: "neutron" as const, wavelength: 1.54 };

/** Bindings for a scale + peak-width powder refinement of the example. */
export function examplePowderBindings(datasetId: string): ParameterBinding[] {
  return [
    { parameterId: "scale", kind: "scale", targetId: datasetId },
    { parameterId: "width", kind: "peakWidth", targetId: datasetId },
    { parameterId: "cell_a", kind: "cellLength", targetId: "mn3ga", targetKey: "a" },
    { parameterId: "cell_c", kind: "cellLength", targetId: "mn3ga", targetKey: "c" },
  ];
}

export function examplePowderParameters(): RefinementParameter[] {
  const structure = exampleStructure();
  return [
    { id: "scale", label: "scale", kind: "scale", value: 80, initialValue: 80, min: 0, fixed: false },
    { id: "width", label: "peak FWHM (°2θ)", kind: "peakWidth", value: 0.5, initialValue: 0.5, min: 0.05, fixed: true },
    { id: "cell_a", label: "a (Å)", kind: "cellLength", value: structure.cell.a, initialValue: structure.cell.a, fixed: true },
    { id: "cell_c", label: "c (Å)", kind: "cellLength", value: structure.cell.c, initialValue: structure.cell.c, fixed: true },
  ];
}

/**
 * Build a synthetic powder pattern (2θ, neutron) from the example structure at a
 * known scale, with Poisson-like noise-free intensities. Useful as a working
 * demonstration and as the "observed" data for a self-consistent refinement.
 */
export function examplerPowderPattern(): PowderPattern {
  const structure = exampleStructure();
  const grid = Array.from({ length: 500 }, (_, i) => 12 + (i * 108) / 500);
  const empty: PowderPattern = {
    id: "mn3ga-powder",
    name: "Mn₃Ga synthetic neutron (λ=1.54 Å)",
    xUnit: "twoTheta",
    radiation: NEUTRON,
    wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const truthParams = examplePowderParameters().map((p) =>
    p.id === "scale" ? { ...p, value: 80 } : p,
  );
  const curves = powderCurves(structure, empty, truthParams, examplePowderBindings("mn3ga-powder"));
  return {
    ...empty,
    points: grid.map((x, i) => {
      const y = curves.yCalc[i] ?? 0;
      return { x, yObs: y + 2, sigma: Math.sqrt(Math.max(y, 1)) + 1 };
    }),
  };
}

/** Build a synthetic single-crystal dataset from the example structure. */
export function exampleSingleCrystalDataset(): SingleCrystalDataset {
  const structure = exampleStructure();
  const reflections = generateReflections(structure.cell, structure.spaceGroup, 1.0, 5.0).slice(0, 20);
  const params: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: 5, initialValue: 5, fixed: false },
  ];
  const bindings: ParameterBinding[] = [{ parameterId: "scale", kind: "scale", targetId: "mn3ga-sx" }];
  const comparison = singleCrystalComparison(
    structure,
    { id: "mn3ga-sx", name: "sx", radiation: NEUTRON, reflections: reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: 0 })) },
    params,
    bindings,
  );
  return {
    id: "mn3ga-sx",
    name: "Mn₃Ga synthetic single crystal",
    radiation: NEUTRON,
    reflections: comparison.map((c) => ({
      h: c.h,
      k: c.k,
      l: c.l,
      iObs: c.iCalc,
      sigma: Math.sqrt(Math.abs(c.iCalc)) + 1,
    })),
  };
}
