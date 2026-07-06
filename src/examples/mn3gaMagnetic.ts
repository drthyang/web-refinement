/**
 * Bundled magnetic example: the 30 K monoclinic magnetic structure of Mn₃Ga
 * (BNS group P2₁'/m') from the GSAS-II validation data. Embedded as mCIF text so
 * the deployed app can demonstrate magnetic refinement, with a synthetic
 * single-crystal dataset built from the refined moments.
 */

import { parseMagneticCif } from "@/parsers/cif";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { generateReflections } from "@/core/diffraction/reflections";
import { magneticComparison } from "@/core/workflow/magnetic";

export const MN3GA_MAGNETIC_MCIF = `data_Mn3Ga_monoclinic_merged
_pd_phase_name  Mn3Ga_monoclinic_merged
_cell_length_a  5.420057
_cell_length_b  4.33961
_cell_length_c  5.322369
_cell_angle_alpha  90
_cell_angle_beta   60.6939
_cell_angle_gamma  90
_cell_volume  109.165
_symmetry_cell_setting  monoclinic
_parent_space_group.name_H-M_alt  "P 21/m"
_space_group_magn.name_BNS  "P 21'/m'"
_space_group.magn_point_group  2'/m'
loop_
    _space_group_symop_magn_operation.id
    _space_group_symop_magn_operation.xyz
     1  x,y,z,+1
     2  -x,1/2+y,-z,-1
     3  -x,-y,-z,+1
     4  x,1/2-y,z,-1
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
Mn1_0  Mn   0.34332     0.25000     0.83329     0.994      Uiso 0.004      2
Mn2_1  Mn   0.84235     0.25000     0.33484     0.989      Uiso 0.004      2
Mn3_2  Mn   0.84395     0.25000     0.83426     0.983      Uiso 0.002      2
Ga1    Ga   0.33884     0.25000     0.32892     1.005      Uiso 0.002      2
loop_
   _atom_site_moment.label
   _atom_site_moment.crystalaxis_x
   _atom_site_moment.crystalaxis_y
   _atom_site_moment.crystalaxis_z
Mn1_0  -1.57657   0.0000  -1.34917
Mn2_1  -2.77619   0.0000  2.82225
Mn3_2  2.71668    0.0000  -2.21750
Ga1    0.0000     0.0000  0.0000
`;

const NEUTRON = { kind: "neutron" as const, wavelength: 1.54 };

export interface MagneticExample {
  readonly structure: StructureModel;
  readonly magnetic: MagneticModel;
}

export function exampleMagnetic(): MagneticExample {
  const { structure, magnetic } = parseMagneticCif(MN3GA_MAGNETIC_MCIF, "mn3ga-mag");
  if (!magnetic) throw new Error("Bundled magnetic example failed to parse");
  return { structure, magnetic };
}

/** Moment-component + scale parameters for the magnetic example. */
export function magneticParameters(magnetic: MagneticModel): RefinementParameter[] {
  const params: RefinementParameter[] = [
    { id: "scaleN", label: "nuclear scale", kind: "scale", value: 1, initialValue: 1, fixed: true },
    { id: "scaleM", label: "magnetic scale", kind: "magneticScale", value: 1, initialValue: 1, fixed: true },
  ];
  for (const m of magnetic.moments) {
    params.push(
      { id: `${m.siteLabel}_mx`, label: `${m.siteLabel} mₐ (μB)`, kind: "momentX", value: m.components[0], initialValue: m.components[0], fixed: false },
      { id: `${m.siteLabel}_mz`, label: `${m.siteLabel} m꜀ (μB)`, kind: "momentZ", value: m.components[2], initialValue: m.components[2], fixed: false },
    );
  }
  return params;
}

export function magneticBindings(magnetic: MagneticModel): ParameterBinding[] {
  const bindings: ParameterBinding[] = [
    { parameterId: "scaleN", kind: "scale", targetId: "mn3ga-mag-data" },
    { parameterId: "scaleM", kind: "magneticScale", targetId: "mn3ga-mag-data" },
  ];
  for (const m of magnetic.moments) {
    bindings.push(
      { parameterId: `${m.siteLabel}_mx`, kind: "momentX", targetId: magnetic.id, targetKey: m.siteLabel },
      { parameterId: `${m.siteLabel}_mz`, kind: "momentZ", targetId: magnetic.id, targetKey: m.siteLabel },
    );
  }
  return bindings;
}

/** Synthetic single-crystal dataset (nuclear + magnetic) from the refined model. */
export function buildMagneticDataset(ex: MagneticExample): SingleCrystalDataset {
  const reflections = generateReflections(ex.structure.cell, ex.structure.spaceGroup, 1.2, 5.0).slice(0, 24);
  const truthParams = magneticParameters(ex.magnetic);
  const dataset: SingleCrystalDataset = {
    id: "mn3ga-mag-data",
    name: "Mn₃Ga 30 K synthetic (nuclear + magnetic)",
    radiation: NEUTRON,
    reflections: reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: 0 })),
  };
  const rows = magneticComparison(ex.structure, ex.magnetic, dataset, truthParams, magneticBindings(ex.magnetic));
  return {
    ...dataset,
    reflections: rows.map((r) => ({ h: r.h, k: r.k, l: r.l, iObs: r.iTotal, sigma: Math.sqrt(Math.abs(r.iTotal)) + 0.05 })),
  };
}
