import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { parseCif, parseCifNumber } from "@/parsers/cif";
import { cellVolume } from "@/core/crystal/unitCell";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { dataExists, readData } from "@/testSupport/data";

const HEX_600K = "Mn3GaHexagonal_structure_600K_Final.cif";
const HEX_393K = "isothermal_hex/cifs/PG3_59283_393K.cif";
const has600 = dataExists(HEX_600K);
const has393 = dataExists(HEX_393K);

describe("parseCifNumber", () => {
  it("strips the esd in parentheses", () => {
    expect(parseCifNumber("5.41317(8)")).toBeCloseTo(5.41317, 5);
    expect(parseCifNumber("110.7594(18)")).toBeCloseTo(110.7594, 4);
    expect(parseCifNumber("90")).toBe(90);
  });
});

describe("parseCif — anisotropic ADP loop", () => {
  it("attaches _atom_site_aniso_U_ij tensors to Uani sites", () => {
    const model = parseCif(`data_test
_cell_length_a  10
_cell_length_b  10
_cell_length_c  10
_cell_angle_alpha  90
_cell_angle_beta   90
_cell_angle_gamma  90
loop_
  _space_group_symop_operation_xyz
  'x,y,z'
loop_
  _atom_site_label
  _atom_site_type_symbol
  _atom_site_fract_x
  _atom_site_fract_y
  _atom_site_fract_z
  _atom_site_occupancy
  _atom_site_adp_type
  _atom_site_U_iso_or_equiv
  Nb1 Nb 0 0 0 1 Uani 0.002
  Se1 Se 0.25 0.25 0.25 1 Uiso 0.003
loop_
  _atom_site_aniso_label
  _atom_site_aniso_U_11
  _atom_site_aniso_U_22
  _atom_site_aniso_U_33
  _atom_site_aniso_U_12
  _atom_site_aniso_U_13
  _atom_site_aniso_U_23
  Nb1 0.002 0.003 0.004 0.0001 0.0002 0.0003
`);
    const nb = model.sites.find((s) => s.label === "Nb1")!;
    expect(nb.adp.kind).toBe("anisotropic");
    if (nb.adp.kind === "anisotropic") expect(nb.adp.uAniso).toEqual([0.002, 0.003, 0.004, 0.0001, 0.0002, 0.0003]);
    const se = model.sites.find((s) => s.label === "Se1")!;
    expect(se.adp.kind).toBe("isotropic");
  });
});

// Read only when present; the `as StructureModel` is safe because the tests in
// this suite are skipped (never dereference `model`) when the file is absent.
describe.skipIf(!has600)("parseCif — GSAS-II Mn₃Ga hexagonal (600 K)", () => {
  const model = (has600 ? parseCif(readData(HEX_600K), "mn3ga") : null) as StructureModel;

  it("reads the unit cell", () => {
    expect(model.cell.a).toBeCloseTo(5.42215, 5);
    expect(model.cell.c).toBeCloseTo(4.375658, 5);
    expect(model.cell.gamma).toBe(120);
  });

  it("cell volume matches the CIF's own _cell_volume (111.408 Å³)", () => {
    expect(cellVolume(model.cell)).toBeCloseTo(111.408, 2);
  });

  it("reads the space group and all 24 symmetry operations", () => {
    expect(model.spaceGroup.hermannMauguin).toContain("P 63/m m c");
    expect(model.spaceGroup.operations).toHaveLength(24);
  });

  it("reads the two atom sites with occupancies and positions", () => {
    expect(model.sites).toHaveLength(2);
    const mn = model.sites.find((s) => s.label === "Mn1")!;
    expect(mn.element).toBe("Mn");
    expect(mn.position[0]).toBeCloseTo(0.16393, 5);
    expect(mn.occupancy).toBeCloseTo(0.978, 3);
    // U_iso 0.0142 → B_iso = 8π²·U_iso.
    expect(mn.adp.kind).toBe("isotropic");
  });

  it("derived multiplicities match the CIF's stated values (Mn1=6, Ga1=2)", () => {
    const ops = model.spaceGroup.operations;
    const mn = model.sites.find((s) => s.label === "Mn1")!;
    const ga = model.sites.find((s) => s.label === "Ga1")!;
    expect(siteMultiplicity(ops, mn.position)).toBe(mn.multiplicity ?? 6);
    expect(siteMultiplicity(ops, ga.position)).toBe(ga.multiplicity ?? 2);
    expect(mn.multiplicity).toBe(6);
    expect(ga.multiplicity).toBe(2);
  });
});

describe.skipIf(!has393)("parseCif — GSAS-II refined series CIF (hex 393 K)", () => {
  const model = (has393 ? parseCif(readData(HEX_393K), "hex-393") : null) as StructureModel;

  it("reads the refined cell with esd notation stripped", () => {
    expect(model.cell.a).toBeCloseTo(5.41317, 5);
    expect(model.cell.c).toBeCloseTo(4.36462, 5);
  });

  it("cell volume matches the CIF value 110.7594 Å³", () => {
    expect(cellVolume(model.cell)).toBeCloseTo(110.7594, 2);
  });
});

/**
 * Real-world CIF quirks that used to break loading (regression for the ICSD /
 * FullProf-style NiTe2O5 file): multiple `data_` blocks, `?` (unknown) in a
 * numeric field, and the `_atom_site_thermal_displace_type` spelling of the
 * ADP-type tag. Kept inline so it runs without the gitignored data/ fixtures.
 */
const MULTIBLOCK_QUIRKY_CIF = `data_blockA
_cell_length_a 8.868
_cell_length_b 12.126
_cell_length_c 8.452
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P n m a'
_symmetry_Int_Tables_number 62
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
-x,-y,-z
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_thermal_displace_type
_atom_site_u_iso_or_equiv
Te1 Te+0 0.8512(4) 0.4868(5) 0.1604(5) 1.000 Uani ?
Ni1 Ni+0 0.5177(9) 0.1229(8) 0.9853(10) 1.000 Uani ?
loop_
_atom_site_aniso_label
_atom_site_aniso_U_11
_atom_site_aniso_U_22
_atom_site_aniso_U_33
_atom_site_aniso_U_12
_atom_site_aniso_U_13
_atom_site_aniso_U_23
Te1 0.0067(2) 0.0050(7) 0.0069(2) 0 0 0
Ni1 0.0076(4) 0.006(1) 0.0073(4) 0 0 0
data_blockB
_cell_length_a 9.999
_cell_length_b 9.999
_cell_length_c 9.999
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Zz1 Zz 0 0 0
`;

describe("parseCif — multi-block + quirky ADP fields (NiTe2O5 regression)", () => {
  const model = parseCif(MULTIBLOCK_QUIRKY_CIF);

  it("loads the first structural block without throwing on '?'", () => {
    expect(model.sites.length).toBe(2);
    expect(model.spaceGroup.hermannMauguin).toBe("P n m a");
  });

  it("takes the cell from the same block as the atoms (no cross-block merge)", () => {
    // blockA's a = 8.868, not blockB's 9.999.
    expect(model.cell.a).toBeCloseTo(8.868, 3);
  });

  it("recognises _atom_site_thermal_displace_type and keeps the anisotropic U tensor", () => {
    const te1 = model.sites.find((s) => s.label === "Te1")!;
    expect(te1.adp.kind).toBe("anisotropic");
    if (te1.adp.kind === "anisotropic") {
      expect(te1.adp.uAniso[0]).toBeCloseTo(0.0067, 4);
      expect(te1.adp.uAniso[2]).toBeCloseTo(0.0069, 4);
    }
    expect(model.sites.every((s) => s.adp.kind === "anisotropic")).toBe(true);
  });
});

describe("parseCifNumber null markers", () => {
  it("still throws on genuinely malformed numbers", () => {
    expect(() => parseCifNumber("abc")).toThrow();
  });
});
