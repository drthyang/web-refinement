/**
 * Bundled default structure: the high-entropy tungstate (Co,Cu,Fe,Mn,Ni,Zn)WO₄,
 * wolframite-type, monoclinic P2/c — the atomic model that accompanies the
 * POWGEN 100 K time-of-flight neutron dataset in
 * `data/POWGEN_HighEntropy_100K/`.
 *
 * The six 3d cations are disordered on a single 2f site at occupancy ≈ 1/6 each
 * (the "high-entropy" A-site); W and the two O sites are ordered. This CIF is
 * embedded as text so the deployed static app always starts from a *real*
 * structure — never the self-consistent Mn₃Ga demo — even when the git-ignored
 * `data/` folder (which holds the observed pattern) is absent. When `data/` is
 * present, the app replaces this with the full POWGEN structure + pattern at
 * runtime (see `app/powgenData.ts`).
 */

import { parseCif } from "@/parsers/cif";
import type { StructureModel } from "@/core/crystal/types";

export const HIGH_ENTROPY_CIF = `data_Co1_Fe1_Mn1_Ni1_O1_W1_Zn1
_pd_phase_name  "Co1 Fe1 Mn1 Ni1 O1 W1 Zn1"
_cell_length_a  4.6757(7)
_cell_length_b  5.7010(10)
_cell_length_c  4.9367(9)
_cell_angle_alpha  90
_cell_angle_beta   89.312(11)
_cell_angle_gamma  90
_cell_volume  131.584(22)
_symmetry_cell_setting  monoclinic
_space_group_name_H-M_alt  "P 2/c"
_space_group_name_Hall  "-P 2yc"
_symmetry_Int_Tables_number  13
loop_
    _space_group_symop_id
    _space_group_symop_operation_xyz
     1  x,y,z
     2  -x,y,1/2-z
     3  -x,-y,-z
     4  x,-y,1/2+z
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
Co1    Co   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
W1     W    0.00000     0.15606     0.25000     1.0000     Uiso 0.0184     2
O1     O    0.24311     0.12375     0.91221     1.0000     Uiso 0.0127     4
O2     O    0.26068     0.38113     0.42162     1.0000     Uiso 0.0161     4
Fe1    Fe   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
Ni1    Ni   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
Mn1    Mn   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
Cu8    Cu   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
Zn1    Zn   0.50000     0.66166     0.25000     0.1670     Uiso 0.0191     2
`;

/** The bundled default structure: high-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄, P2/c. */
export function exampleStructure(): StructureModel {
  return parseCif(HIGH_ENTROPY_CIF, "highentropy");
}
