import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { parseCif, parseCifNumber, parseTypeSymbol } from "@/parsers/cif";
import { siteIonId } from "@/core/magnetic/magneticIons";
import { EIGHT_PI_SQUARED } from "@/core/crystal/adp";
import { cellVolume } from "@/core/crystal/unitCell";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { buildSpaceGroup, SpaceGroupSettingError } from "@/core/crystal/spaceGroups";
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

describe("parseCif — isotropic displacement parameter column", () => {
  const cifWith = (adpHeader: string, adpValue: string): string => `data_test
_cell_length_a  4
_cell_length_b  4
_cell_length_c  4
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
  _atom_site_occupancy${adpHeader}
  Mn1 Mn 0 0 0 1${adpValue}
`;

  it("reads _atom_site_B_iso_or_equiv verbatim (it is already B, not U)", () => {
    const model = parseCif(cifWith("\n  _atom_site_B_iso_or_equiv", " 0.47"));
    const mn = model.sites[0]!;
    expect(mn.adp.kind).toBe("isotropic");
    if (mn.adp.kind === "isotropic") expect(mn.adp.bIso).toBeCloseTo(0.47, 12);
  });

  it("converts _atom_site_U_iso_or_equiv with B = 8π²U", () => {
    const model = parseCif(cifWith("\n  _atom_site_U_iso_or_equiv", " 0.006"));
    const mn = model.sites[0]!;
    if (mn.adp.kind === "isotropic") expect(mn.adp.bIso).toBeCloseTo(8 * Math.PI * Math.PI * 0.006, 12);
  });

  // Precedence when a file carries both and both are populated: U is the
  // refined quantity in the modern dialects, so a stale/bogus B column must
  // never win. (Salvaged from an independent pass at this fix in the
  // elated-albattani worktree, which pinned the same rule.)
  it("prefers U_iso over B_iso when both columns carry a value", () => {
    const model = parseCif(cifWith("\n  _atom_site_U_iso_or_equiv\n  _atom_site_B_iso_or_equiv", " 0.01 999"));
    const mn = model.sites[0]!;
    if (mn.adp.kind === "isotropic") expect(mn.adp.bIso).toBeCloseTo(EIGHT_PI_SQUARED * 0.01, 10);
  });

  it("falls back to the B column when this row's U_iso is the CIF null marker", () => {
    const model = parseCif(cifWith("\n  _atom_site_U_iso_or_equiv\n  _atom_site_B_iso_or_equiv", " ? 0.8"));
    const mn = model.sites[0]!;
    if (mn.adp.kind === "isotropic") expect(mn.adp.bIso).toBeCloseTo(0.8, 12);
  });

  // No column at all: B_iso = 0 is a MISSING ADP, not a cold one. The parser
  // must not invent a default — callers warn instead (see zeroAdpWarning).
  it("leaves B_iso = 0 when the loop carries no ADP column", () => {
    const model = parseCif(cifWith("", ""));
    const mn = model.sites[0]!;
    expect(mn.adp.kind).toBe("isotropic");
    if (mn.adp.kind === "isotropic") expect(mn.adp.bIso).toBe(0);
  });
});

describe("parseCif — space group from H-M name only (no symop loop)", () => {
  // A CIF that names the group but lists no symmetry operations (e.g. the 11-BM
  // NAC file) must resolve the full group from the built-in table, not silently
  // fall back to P1 — that collapse gave wrong |F|² and an unfittable pattern.
  it("resolves 'I 21 3' (#199) to all 24 operations", () => {
    const model = parseCif(`data_nac
_cell_length_a  10.2514
_cell_length_b  10.2514
_cell_length_c  10.2514
_cell_angle_alpha  90
_cell_angle_beta   90
_cell_angle_gamma  90
_symmetry_space_group_name_H-M  "I 21 3"
loop_
  _atom_site_type_symbol
  _atom_site_label
  _atom_site_fract_x
  _atom_site_fract_y
  _atom_site_fract_z
  _atom_site_occupancy
  Al Al1 0.24768 0.24768 0.24768 1.0
`);
    expect(model.spaceGroup.number).toBe(199);
    expect(model.spaceGroup.operations).toHaveLength(24);
  });

  const cifWith = (symmetry: string, cell = "10 10 10 90 90 90", atoms = "Al Al1 0 0 0 1.0"): string => {
    const [a, b, c, al, be, ga] = cell.split(" ");
    return `data_x
_cell_length_a  ${a}
_cell_length_b  ${b}
_cell_length_c  ${c}
_cell_angle_alpha  ${al}
_cell_angle_beta   ${be}
_cell_angle_gamma  ${ga}
${symmetry}
loop_
  _atom_site_type_symbol
  _atom_site_label
  _atom_site_fract_x
  _atom_site_fract_y
  _atom_site_fract_z
  _atom_site_occupancy
  ${atoms}
`;
  };

  it("rejects an unknown symbol instead of falling back to P1", () => {
    expect(() => parseCif(cifWith(`_symmetry_space_group_name_H-M  "Zz 99 9"`))).toThrow(/CIF space group: Unknown space group "Zz 99 9"/);
  });

  it("reads a CIF with no symmetry at all as P 1 (the CIF default x,y,z) and says so", () => {
    const warnings: string[] = [];
    const model = parseCif(cifWith("", undefined, "Al Al1 0 0 0 1.0\n  Al Al2 0.5 0.5 0 1.0"), "p1", { onWarning: (w) => warnings.push(w) });
    expect(model.spaceGroup.number).toBe(1);
    expect(model.spaceGroup.operations.map((o) => o.xyz)).toEqual(["x,y,z"]);
    expect(model.sites).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/read as P 1/);
    // `?` and `.` are no symmetry either; a file that does carry symmetry warns nothing.
    expect(parseCif(cifWith(`_symmetry_space_group_name_H-M  ?`)).spaceGroup.number).toBe(1);
    const quiet: string[] = [];
    parseCif(cifWith(`_symmetry_space_group_name_H-M  'P 1'`), "p1", { onWarning: (w) => quiet.push(w) });
    expect(quiet).toEqual([]);
    // A symbol, number or setting the reader cannot resolve stays an error, not P 1.
    expect(() => parseCif(cifWith(`_symmetry_Int_Tables_number  x`))).toThrow(/No space-group information/);
    expect(() => parseCif(cifWith(""), "p1", { spaceGroupSetting: "F d -3 m:2" })).toThrow(/No space-group information/);
  });

  it("rejects 'F d -3 m' without operations: origin choice 1 or 2 must be stated", () => {
    let err: unknown;
    try {
      parseCif(cifWith(`_symmetry_space_group_name_H-M  'F d -3 m'`, "5.431 5.431 5.431 90 90 90", "Si Si1 0.125 0.125 0.125 1.0"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpaceGroupSettingError);
    expect((err as SpaceGroupSettingError).candidates.map((c) => c.symbol)).toEqual(["F d -3 m:1", "F d -3 m:2"]);
    // A number alone is just as ambiguous.
    expect(() => parseCif(cifWith(`_space_group_IT_number  227`))).toThrow(SpaceGroupSettingError);
  });

  it("expands origin-2 coordinates correctly when the setting is explicit", () => {
    const si = "Si Si1 0.125 0.125 0.125 1.0";
    for (const symmetry of [
      `_symmetry_space_group_name_H-M  'F d -3 m:2'`,
      `_symmetry_space_group_name_H-M  'F d -3 m Z'`, // ICSD
      `_space_group_name_H-M_alt  'F d -3 m'
_space_group_name_Hall  '-F 4vw 2vw 3'`,
    ]) {
      const model = parseCif(cifWith(symmetry, "5.431 5.431 5.431 90 90 90", si));
      expect(model.spaceGroup.hermannMauguin, symmetry).toBe("F d -3 m:2");
      expect(siteMultiplicity(model.spaceGroup.operations, model.sites[0]!.position), symmetry).toBe(8);
    }
    // Explicit operations stay authoritative and need no symbol at all.
    const ops = buildSpaceGroup("F d -3 m:2").operations.map((o) => `  '${o.xyz}'`).join("\n");
    const withOps = parseCif(cifWith(`_symmetry_space_group_name_H-M  'F d -3 m'\nloop_\n  _symmetry_equiv_pos_as_xyz\n${ops}`, "5.431 5.431 5.431 90 90 90", si));
    expect(siteMultiplicity(withOps.spaceGroup.operations, withOps.sites[0]!.position)).toBe(8);
  });

  it("takes the user's choice among the settings an ambiguous symbol fits", () => {
    const text = cifWith(`_symmetry_space_group_name_H-M  'F d -3 m'`, "5.431 5.431 5.431 90 90 90", "Si Si1 0.125 0.125 0.125 1.0");
    const o2 = parseCif(text, "si", { spaceGroupSetting: "F d -3 m:2" });
    expect(o2.spaceGroup.hermannMauguin).toBe("F d -3 m:2");
    expect(siteMultiplicity(o2.spaceGroup.operations, o2.sites[0]!.position)).toBe(8);
    expect(parseCif(text, "si", { spaceGroupSetting: "F d -3 m:1" }).spaceGroup.hermannMauguin).toBe("F d -3 m:1");
    // A choice the CIF's symbol does not fit is refused.
    expect(() => parseCif(text, "si", { spaceGroupSetting: "F m -3 m" })).toThrow(/not one the space group fits/);
  });

  it("decides hexagonal vs rhombohedral axes of an R group from the cell", () => {
    const hex = parseCif(cifWith(`_symmetry_space_group_name_H-M  'R -3 m'`, "4.9 4.9 12.1 90 90 120"));
    expect(hex.spaceGroup.hermannMauguin).toBe("R -3 m:H");
    expect(hex.spaceGroup.operations).toHaveLength(36);
    const rh = parseCif(cifWith(`_symmetry_space_group_name_H-M  'R -3 m'`, "5.2 5.2 5.2 57 57 57"));
    expect(rh.spaceGroup.hermannMauguin).toBe("R -3 m:R");
    expect(rh.spaceGroup.operations).toHaveLength(12);
  });

  it("rejects a Hall symbol or number that contradicts the H-M symbol", () => {
    expect(() => parseCif(cifWith(`_symmetry_space_group_name_H-M  'F d -3 m:1'\n_symmetry_space_group_name_Hall  '-F 4vw 2vw 3'`))).toThrow(/contradicts/);
    expect(() => parseCif(cifWith(`_symmetry_space_group_name_H-M  'P n m a'\n_symmetry_Int_Tables_number  14`))).toThrow(/contradicts/);
  });

  it("resolves a non-standard setting by its own symbol, not by its number", () => {
    // Previously the number won and "P 1 21/n 1" was built as P 1 21/c 1.
    const model = parseCif(cifWith(`_symmetry_space_group_name_H-M  'P 1 21/n 1'\n_symmetry_Int_Tables_number  14`, "5 6 7 90 101 90"));
    expect(model.spaceGroup.hermannMauguin).toBe("P 1 21/n 1");
    expect(model.spaceGroup.operations.map((o) => o.xyz)).toContain("-x+1/2,y+1/2,-z+1/2");
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

describe("atom types: charges kept, labels resolved case-insensitively", () => {
  const atoms = (header: string, rows: string): string => `data_x
_cell_length_a 5
_cell_length_b 5
_cell_length_c 5
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P 1'
loop_
${header}
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
${rows}
`;

  it("keeps the charge of a type symbol as the oxidation state", () => {
    expect(parseTypeSymbol("Fe3+")).toEqual({ element: "Fe", oxidationState: 3 });
    expect(parseTypeSymbol("Fe+3")).toEqual({ element: "Fe", oxidationState: 3 });
    expect(parseTypeSymbol("O2-")).toEqual({ element: "O", oxidationState: -2 });
    expect(parseTypeSymbol("O-2")).toEqual({ element: "O", oxidationState: -2 });
    expect(parseTypeSymbol("Na+")).toEqual({ element: "Na", oxidationState: 1 });
    expect(parseTypeSymbol("Cl-")).toEqual({ element: "Cl", oxidationState: -1 });
    expect(parseTypeSymbol("Mn")).toEqual({ element: "Mn" });
    expect(parseTypeSymbol("FE")).toEqual({ element: "Fe" });
    expect(parseTypeSymbol("D")).toEqual({ element: "D" });
    // A fractional charge is no tabulated oxidation state.
    expect(parseTypeSymbol("Fe2.5+")).toEqual({ element: "Fe" });
    // Not an element: an error, not a guess ("Wat" used to become "Wa").
    expect(() => parseTypeSymbol("Wat")).toThrow(/not an element symbol/);
    expect(() => parseTypeSymbol("OH-")).toThrow(/not an element symbol/);
  });

  it("puts the oxidation state on the site, where it picks the magnetic ion", () => {
    const model = parseCif(atoms("_atom_site_label\n_atom_site_type_symbol", "Fe1 Fe3+ 0 0 0\nO1 O2- 0.5 0.5 0.5\nMn1 Mn 0.25 0.25 0.25"));
    expect(model.sites.map((x) => [x.element, x.oxidationState])).toEqual([["Fe", 3], ["O", -2], ["Mn", undefined]]);
    expect(siteIonId(model.sites[0]!)).toBe("Fe3"); // was "Fe2": the 3+ was stripped
  });

  it("resolves upper-case labels to two-letter elements when there is no type symbol", () => {
    const model = parseCif(atoms("_atom_site_label", "FE1 0 0 0\nCA1 0.5 0 0\nC12 0 0.5 0\nOW1 0 0 0.5\nCa2 0.5 0.5 0\nD1 0.5 0 0.5"));
    expect(model.sites.map((x) => x.element)).toEqual(["Fe", "Ca", "C", "O", "Ca", "D"]);
  });

  it("falls back to the label when the type symbol is the CIF null '?'", () => {
    const model = parseCif(atoms("_atom_site_label\n_atom_site_type_symbol", "SR1 ? 0 0 0"));
    expect(model.sites[0]!.element).toBe("Sr");
  });
});
