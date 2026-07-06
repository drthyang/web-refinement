import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCif, parseCifNumber } from "@/parsers/cif";
import { cellVolume } from "@/core/crystal/unitCell";
import { siteMultiplicity } from "@/core/crystal/symmetry";

const dataDir = resolve(process.cwd(), "data");
const read = (p: string): string => readFileSync(resolve(dataDir, p), "utf8");

describe("parseCifNumber", () => {
  it("strips the esd in parentheses", () => {
    expect(parseCifNumber("5.41317(8)")).toBeCloseTo(5.41317, 5);
    expect(parseCifNumber("110.7594(18)")).toBeCloseTo(110.7594, 4);
    expect(parseCifNumber("90")).toBe(90);
  });
});

describe("parseCif — GSAS-II Mn₃Ga hexagonal (600 K)", () => {
  const model = parseCif(read("Mn3GaHexagonal_structure_600K_Final.cif"), "mn3ga");

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

describe("parseCif — GSAS-II refined series CIF (hex 393 K)", () => {
  const model = parseCif(read("isothermal_hex/cifs/PG3_59283_393K.cif"), "hex-393");

  it("reads the refined cell with esd notation stripped", () => {
    expect(model.cell.a).toBeCloseTo(5.41317, 5);
    expect(model.cell.c).toBeCloseTo(4.36462, 5);
  });

  it("cell volume matches the CIF value 110.7594 Å³", () => {
    expect(cellVolume(model.cell)).toBeCloseTo(110.7594, 2);
  });
});
