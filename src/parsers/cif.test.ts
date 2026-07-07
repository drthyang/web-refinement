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
