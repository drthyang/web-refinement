import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { RefinementParameter } from "@/core/refinement/types";
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

describe("verbatim original files", () => {
  const rawInstprm = { name: "powgen.instprm", text: "#GSAS-II instrument parameter file\nType:PNT\ndifC:22585.8\n" };
  const rawData = { name: "PG3_600K.dat", text: "XYDATA\n# Mantid\n3389.2 48.5 2.9\n" };

  it("GSAS-II uses the user's .instprm verbatim instead of regenerating it", () => {
    const e = gsas2Bundle(structure, powder, { rawInstrument: rawInstprm, rawData });
    expect(names(e)).toContain("powgen.instprm");
    expect(names(e)).not.toContain("MnO.instprm"); // not regenerated
    expect(e.find((x) => x.name === "powgen.instprm")!.data).toBe(rawInstprm.text); // byte-for-byte
    // build_gpx.py points at the verbatim instrument, and the original data ships too.
    expect((e.find((x) => x.name === "build_gpx.py")!.data as string)).toContain("'powgen.instprm'");
    expect(names(e)).toContain("PG3_600K.dat");
    expect(e.find((x) => x.name === "PG3_600K.dat")!.data).toBe(rawData.text);
  });

  it("a non-.instprm instrument file is shipped verbatim but not adopted as the instprm", () => {
    const irf = { name: "d1b.irf", text: "! FullProf resolution\nD2TOF ...\n" };
    const e = gsas2Bundle(structure, powder, { rawInstrument: irf });
    expect(names(e)).toContain("MnO.instprm"); // still generated
    expect(names(e)).toContain("d1b.irf"); // original shipped for reference
  });

  it("FullProf ships the verbatim originals alongside the generated .pcr + .dat", () => {
    const e = fullprofBundle(structure, powder, { rawInstrument: rawInstprm, rawData });
    expect(names(e)).toEqual(expect.arrayContaining(["MnO.pcr", "MnO.dat", "powgen.instprm", "PG3_600K.dat", "README.txt"]));
    expect(e.find((x) => x.name === "PG3_600K.dat")!.data).toBe(rawData.text);
  });

  it("a raw file colliding with a generated name is renamed, not clobbered", () => {
    const collide = { name: "MnO.dat", text: "verbatim original\n" };
    const e = fullprofBundle(structure, powder, { rawData: collide });
    const dat = e.filter((x) => x.name.endsWith(".dat"));
    expect(dat.map((x) => x.name)).toEqual(["MnO.dat", "original_MnO.dat"]);
    // Generated MnO.dat is the portable XYE, the verbatim keeps its content.
    expect(e.find((x) => x.name === "original_MnO.dat")!.data).toBe(collide.text);
  });
});

describe("FullProf TOF peak-shape carries the refined profile", () => {
  const tofPowder: PowderPattern = {
    id: "p", name: "MnO", xUnit: "tof", radiation: { kind: "neutron-tof" },
    points: [{ x: 14300, yObs: 100 }, { x: 20000, yObs: 120, sigma: 11 }, { x: 30000, yObs: 90 }],
  };
  const instrument = { kind: "tof", difC: 22585.8 } as const;
  const param = (id: string, value: number): RefinementParameter =>
    ({ id, label: id, kind: "tofProfile", value, initialValue: value, fixed: false });

  it("writes the refined tof_* coefficients into the .pcr Sig/alph/beta rows", () => {
    const params: RefinementParameter[] = [
      param("tof_sig0", 8.0), param("tof_sig1", 512.3), param("tof_alpha1", 1.9), param("tof_beta0", 0.028),
    ];
    const e = fullprofBundle(structure, tofPowder, { instrument, params });
    const pcr = (e.find((x) => x.name === "MnO.pcr")!.data as string).split("\n");
    const sig = pcr[pcr.findIndex((l) => l.includes("sigma^2 = Sig-2")) + 1]!.trim().split(/\s+/).map(Number);
    expect(sig[1]).toBeCloseTo(512.3, 3); // Sig-1 = refined value, not a seed
    expect(sig[2]).toBeCloseTo(8.0, 3); // Sig-0
    const bb = pcr[pcr.findIndex((l) => l.includes("alpha = alph0 + alph1/d")) + 1]!.trim().split(/\s+/).map(Number);
    expect(bb[3]).toBeCloseTo(0.028, 4); // beta0
    expect(bb[4]).toBeCloseTo(1.9, 4); // alph1
  });

  it("folds a refined isotropic TOF Mustrain into Sig-1", () => {
    // ε = 3000 µstrain → σ_T² adds (difC·ε)²·d² = (22585.8·3e-3)² to Sig-1.
    const params: RefinementParameter[] = [
      { id: "mustrainIso", label: "mustrain", kind: "mustrainIso", value: 3000, initialValue: 0, fixed: false },
    ];
    const e = fullprofBundle(structure, tofPowder, { instrument, params });
    const pcr = (e.find((x) => x.name === "MnO.pcr")!.data as string).split("\n");
    const sig = pcr[pcr.findIndex((l) => l.includes("sigma^2 = Sig-2")) + 1]!.trim().split(/\s+/).map(Number);
    expect(sig[1]).toBeCloseTo((22585.8 * 3000e-6) ** 2, 1);
  });
});
