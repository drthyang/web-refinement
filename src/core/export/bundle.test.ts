import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { powderDataXye, singleCrystalHkl, singleCrystalInt } from "@/core/export/data";
import { fullprofBundle, gsas2Bundle } from "@/core/export/bundle";
import { zipStore } from "@/core/export/zip";

const structure: StructureModel = {
  id: "t", name: "MnO",
  cell: { a: 4.445, b: 4.445, c: 4.445, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "F m -3 m", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
};
const powder: PowderPattern = {
  id: "p", name: "MnO", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.5 },
  points: [{ x: 10, yObs: 100 }, { x: 10.05, yObs: 120, sigma: 11 }, { x: 10.1, yObs: 90 }],
};
const single: SingleCrystalDataset = {
  id: "s", name: "MnO", radiation: { kind: "neutron", wavelength: 1.0 },
  reflections: [{ h: 1, k: 1, l: 1, iObs: 250.5, sigma: 5.1 }, { h: 2, k: 0, l: 0, iObs: 88.2, sigma: 3.0 }],
};
const names = (e: { name: string }[]) => e.map((x) => x.name);

describe("data writers", () => {
  it("powder XYE has three columns per point", () => {
    const rows = powderDataXye(powder).trim().split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.split(/\s+/)).toHaveLength(3);
    expect(rows[1]).toBe("10.05 120 11"); // supplied sigma preserved
  });

  it("HKLF4 is fixed-width and 000-terminated", () => {
    const hkl = singleCrystalHkl(single).trimEnd().split("\n");
    expect(hkl[0]).toBe("   1   1   1  250.50    5.10");
    expect(hkl[hkl.length - 1]).toBe("   0   0   0    0.00    0.00");
  });

  it("FullProf .int carries the Crystal header + wavelength", () => {
    const int = singleCrystalInt(single).split("\n");
    expect(int[0]).toBe("Crystal");
    expect(int[1]).toBe("(3i4,2f8.2)");
    expect(int[2]).toBe("1.0000 0 0");
  });
});

describe("fullprofBundle", () => {
  it("powder → .pcr + .dat + README", () => {
    expect(names(fullprofBundle(structure, powder))).toEqual(["MnO.pcr", "MnO.dat", "README.txt"]);
  });
  it("single crystal → .pcr + .int + README", () => {
    expect(names(fullprofBundle(structure, single))).toEqual(["MnO.pcr", "MnO.int", "README.txt"]);
  });
});

describe("gsas2Bundle", () => {
  it("powder → cif + xye + instprm + build_gpx.py + README", () => {
    const e = gsas2Bundle(structure, powder);
    expect(names(e)).toEqual(["MnO.cif", "MnO.xye", "MnO.instprm", "build_gpx.py", "README.txt"]);
    const script = e.find((x) => x.name === "build_gpx.py")!.data as string;
    expect(script).toContain("gpx.add_powder_histogram('MnO.xye', 'MnO.instprm', phases=[phase])");
    expect(e.find((x) => x.name === "MnO.instprm")!.data).toContain("Type:PNC"); // CW neutron
  });

  it("single crystal → cif + hkl + build_gpx.py + README (no instprm)", () => {
    const e = gsas2Bundle(structure, single);
    expect(names(e)).toEqual(["MnO.cif", "MnO.hkl", "build_gpx.py", "README.txt"]);
    expect((e.find((x) => x.name === "build_gpx.py")!.data as string)).toContain("add_single_histogram('MnO.hkl'");
  });

  it("the assembled bundle zips into a valid archive", () => {
    const zip = zipStore(gsas2Bundle(structure, powder, { name: "My Sample" }));
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50); // valid zip
    // Name sanitized (space → underscore).
    expect(new TextDecoder().decode(zip)).toContain("My_Sample.cif");
  });
});
