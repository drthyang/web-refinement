/**
 * The program-convention translations of the FullProf / GSAS-II export: the
 * places where a value means something different on each side (FullProf Occ,
 * Caglioti units, the X/Y swap, GSAS-II σ² vs FWHM²), plus the refined-model
 * transfer (profile, background, fit range, every phase) of `refinementBundle`.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { structureToPcr, fullprofOccupancy } from "@/core/export/fullprof";
import { patchInstprm, buildGpxScript } from "@/core/export/gsas2";
import { powderDataFullProf, hklf4ScaleFactor, singleCrystalHkl } from "@/core/export/data";
import { refinementBundle, fullprofBundle } from "@/core/export/bundle";

// LaMnO3 (here in the standard P n m a setting) — the real FullProf template
// (LaMn50K, Pbnm) writes La/Mn/O1 at Occ 0.5 (m = 4 of 8) and O2 at 1.0.
const lamno3: StructureModel = {
  id: "lmo", name: "LaMnO3",
  cell: { a: 5.7497, b: 7.6693, c: 5.537, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: buildSpaceGroup(62),
  sites: [
    { label: "La", element: "La", position: [0.05114, 0.25, -0.00822], occupancy: 1, adp: { kind: "isotropic", bIso: 0.08 } },
    { label: "Mn", element: "Mn", position: [0, 0, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    { label: "O1", element: "O", position: [0.48752, 0.25, 0.07646], occupancy: 1, adp: { kind: "isotropic", bIso: 0.62 } },
    { label: "O2", element: "O", position: [0.30902, 0.03969, 0.72512], occupancy: 1, adp: { kind: "isotropic", bIso: 0.62 } },
  ],
};
const second: StructureModel = { ...lamno3, id: "imp", name: "Impurity" };

const cwPattern: PowderPattern = {
  id: "pat", name: "lmo", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 2.597 },
  points: Array.from({ length: 200 }, (_, i) => ({ x: 5 + i * 0.75, yObs: 100 + (i % 7) })),
};

const flags = (pcr: string, header: string): number[] => {
  const lines = pcr.split("\n");
  return lines[lines.findIndex((l) => l.startsWith(header)) + 1]!.trim().split(/\s+/).map(Number);
};
const after = (pcr: string, marker: string, offset = 1): number[] => {
  const lines = pcr.split("\n");
  return lines[lines.findIndex((l) => l.includes(marker)) + offset]!.trim().split(/\s+/).map(Number);
};

describe("FullProf .pcr conventions", () => {
  it("writes Occ = occupancy × m_site / m_general (FullProf, not CIF)", () => {
    expect(lamno3.sites.map((s) => fullprofOccupancy(lamno3, s))).toEqual([0.5, 0.5, 0.5, 1]);
    const pcr = structureToPcr(lamno3);
    expect(pcr).toMatch(/^Mn\s+Mn\s+0\.00000\s+0\.00000\s+0\.50000\s+0\.50000\s+0\.50000/m);
    expect(pcr).toMatch(/^O2\s+O\s+.*\s+1\.00000\s+0\s+0\s+0/m);
  });

  it("selects Job 1 for CW neutron, 0 for X-ray, and Ins = 10 for the XYDATA file", () => {
    expect(flags(structureToPcr(lamno3, { radiationKind: "neutron" }), "!Job")[0]).toBe(1);
    expect(flags(structureToPcr(lamno3, { radiationKind: "xray" }), "!Job")[0]).toBe(0);
    expect(flags(structureToPcr(lamno3), "!Ipr")[10]).toBe(10);
  });

  it("uses March–Dollase with Pref1 = 1 (no preferred orientation), never a 0 that divides", () => {
    const pcr = structureToPcr(lamno3);
    expect(flags(pcr, "!Job")[6]).toBe(1); // Nor = 1
    expect(after(pcr, "!  Pref1")[0]).toBe(1);
  });

  it("converts the Caglioti and Lorentzian terms into FullProf units (and swaps X/Y)", () => {
    const pcr = structureToPcr(lamno3, {
      caglioti: { u: 7677.8, v: -2778.9, w: 3981.6 }, // centideg² FWHM²
      lorentzian: { x: 4.826, y: 1.5 }, // GSAS-II X (size), Y (strain), centideg
      axial: { sl: 0.035, hl: 0.022 },
      zero: 0.10686,
    });
    const uvw = after(pcr, "!       U         V          W");
    expect(uvw[0]).toBeCloseTo(0.76778, 5);
    expect(uvw[1]).toBeCloseTo(-0.27789, 5);
    expect(uvw[2]).toBeCloseTo(0.39816, 5);
    expect(uvw[3]).toBeCloseTo(0.015, 6); // FullProf X (tanθ) ← GSAS-II Y
    expect(uvw[4]).toBeCloseTo(0.04826, 6); // FullProf Y (1/cosθ) ← GSAS-II X
    const asy = after(pcr, "!  Pref1");
    expect(asy[6]).toBeCloseTo(0.035, 5);
    expect(asy[7]).toBeCloseTo(0.022, 5);
    expect(after(pcr, "!  Zero    Code")[0]).toBeCloseTo(0.10686, 5);
  });

  it("writes one phase block per phase, with Nph and Nex consistent", () => {
    const pcr = structureToPcr(lamno3, {
      phases: [{ structure: lamno3, scale: 2 }, { structure: second, scale: 0.1 }],
      excluded: [[0, 10], [150, 160]],
    });
    const f = flags(pcr, "!Job");
    expect(f[2]).toBe(2); // Nph
    expect(f[4]).toBe(2); // Nex
    expect(pcr.match(/<--Space group symbol/g)).toHaveLength(2);
    expect(pcr).toContain("Phase #  2");
    expect(pcr).toContain("! Excluded regions");
  });

  it("writes a single-crystal job (Cry = 1, Irf = 4, no background) for reflection data", () => {
    const pcr = structureToPcr(lamno3, { singleCrystal: true, radiationKind: "neutron" });
    const f = flags(pcr, "!Job");
    expect(f[1]).toBe(0); // Npr
    expect(f[3]).toBe(0); // Nba
    expect(f[14]).toBe(1); // Cry
    expect(after(pcr, "!Nat Dis Ang")[7]).toBe(4); // Irf = 4 (F² list)
    expect(pcr).toContain("Scale, Extinction");
    expect(pcr).not.toContain("Background  for Pattern");
  });
});

describe("data files", () => {
  it("FullProf XYDATA has the keyword plus exactly five header lines", () => {
    const lines = powderDataFullProf(cwPattern).split("\n");
    expect(lines[0]).toBe("XYDATA");
    expect(lines.slice(1, 6).every((l) => l.startsWith("#"))).toBe(true);
    expect(lines[6]!.split(/\s+/)).toHaveLength(3);
  });

  it("rescales HKLF4 intensities that would overflow or vanish in F8.2", () => {
    const sc = (iObs: number): SingleCrystalDataset => ({
      id: "s", name: "s", radiation: { kind: "neutron", wavelength: 1 },
      reflections: [{ h: 1, k: 0, l: 0, iObs, sigma: iObs / 10 }],
    });
    expect(hklf4ScaleFactor(sc(250))).toBe(1);
    expect(hklf4ScaleFactor(sc(250000))).toBe(0.1);
    expect(hklf4ScaleFactor(sc(0.18))).toBe(1e5);
    expect(singleCrystalHkl(sc(0.18)).split("\n")[0]).toBe("   1   0   018000.00 1800.00");
  });
});

describe("GSAS-II pieces", () => {
  const instprm = [
    "#GSAS-II instrument parameter file; do not add/delete items!",
    "#extracted from a gpx",
    "Type:PNT",
    "2-theta:90.0",
    "Zero:-0.03",
    "difC:22579.8",
    "alpha:0.133",
    "sig-1:-569.4",
    "fltPath:63.183",
  ].join("\n");

  it("patches refined values into a single-bank .instprm, keeping every other line", () => {
    const out = patchInstprm(instprm, { Zero: 1.5, difC: 22585.1, "sig-1": 12 })!;
    expect(out.split("\n")).toEqual([
      "#GSAS-II instrument parameter file; do not add/delete items!",
      "#extracted from a gpx",
      "Type:PNT",
      "2-theta:90.0",
      "Zero:1.5",
      "difC:22585.1",
      "alpha:0.133",
      "sig-1:12",
      "fltPath:63.183",
    ]);
  });

  it("leaves a multi-bank .instprm alone", () => {
    expect(patchInstprm(`${instprm}\nType:PNT\n`, { Zero: 1 })).toBeUndefined();
  });

  it("build_gpx.py adds every phase and sets limits + a lin-interpolate background", () => {
    const py = buildGpxScript({
      gpxName: "a.gpx", cifFile: "a.cif", phaseName: "a", dataFile: "a.xye", instprmFile: "a.instprm",
      histogramKind: "powder", extraPhases: [{ cifFile: "b.cif", phaseName: "b" }],
      limits: [10, 120], background: [5, 4, 3],
    });
    expect(py).toContain("phase2 = gpx.add_phase('b.cif', phasename='b', fmthint='CIF')");
    expect(py).toContain("phases=[phase, phase2]");
    expect(py).toContain("hist.set_refinements({'Limits': [10, 120]})");
    expect(py).toContain("'type': 'lin interpolate'");
    expect(py).toContain("'coeffs': [5, 4, 3]");
  });
});

describe("refinementBundle carries the refined model, not just the structure", () => {
  const params: RefinementParameter[] = [
    { id: "scale", label: "s", kind: "scale", value: 3, initialValue: 1, fixed: false },
    { id: "bkg0", label: "b0", kind: "background", value: 40, initialValue: 1, fixed: false },
    { id: "bkg1", label: "b1", kind: "background", value: 10, initialValue: 0, fixed: false },
    { id: "profU", label: "U", kind: "profileU", value: 100, initialValue: 100, fixed: false },
    { id: "profV", label: "V", kind: "profileV", value: -50, initialValue: -50, fixed: false },
    { id: "profW", label: "W", kind: "profileW", value: 400, initialValue: 400, fixed: false },
    { id: "zero", label: "zero", kind: "zeroShift", value: 0.05, initialValue: 0, fixed: false },
    { id: "imp_a", label: "a", kind: "cellLength", value: 5.6, initialValue: 5.537, fixed: false },
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "pat" },
    { parameterId: "bkg0", kind: "background", targetId: "pat", targetKey: "0" },
    { parameterId: "bkg1", kind: "background", targetId: "pat", targetKey: "1" },
    { parameterId: "profU", kind: "profileU", targetId: "pat" },
    { parameterId: "profV", kind: "profileV", targetId: "pat" },
    { parameterId: "profW", kind: "profileW", targetId: "pat" },
    { parameterId: "zero", kind: "zeroShift", targetId: "pat" },
    { parameterId: "imp_a", kind: "cellLength", targetId: "imp", targetKey: "a" },
  ];
  const opts = { params, bindings, phases: [second], fitRange: { min: 20, max: 140 } };

  it("FullProf: profile, zero, refined background, excluded tails and the second phase", () => {
    const pcr = refinementBundle("fullprof", lamno3, cwPattern, opts).find((e) => e.name === "LaMnO3.pcr")!.data as string;
    expect(after(pcr, "!  Zero    Code")[0]).toBeCloseTo(0.05, 5);
    expect(after(pcr, "!       U         V          W")[0]).toBeCloseTo(0.01, 6);
    const f = flags(pcr, "!Job");
    expect(f[2]).toBe(2); // both phases
    expect(f[4]).toBe(2); // tails outside 20–140 excluded
    // Chebyshev 40 + 10·t over the data span, sampled from the first FITTED
    // point (x = 20) — never extrapolated into the excluded tails.
    const bkg = after(pcr, "Background  for Pattern");
    const xLast = 5 + 199 * 0.75;
    expect(bkg[0]).toBeCloseTo(20, 4);
    expect(bkg[1]).toBeCloseTo(40 + 10 * ((2 * (20 - 5)) / (xLast - 5) - 1), 3);
    expect(pcr).toMatch(/5\.600000\s+7\.669300/); // impurity's own refined a
  });

  it("GSAS-II: σ²-unit .instprm, a CIF per phase, limits and background in the script", () => {
    const e = refinementBundle("gsas2", lamno3, cwPattern, opts);
    expect(e.map((x) => x.name)).toEqual(expect.arrayContaining(["LaMnO3.cif", "Impurity.cif", "LaMnO3.instprm", "build_gpx.py"]));
    const inst = e.find((x) => x.name === "LaMnO3.instprm")!.data as string;
    expect(Number(inst.match(/^U:(.*)$/m)![1])).toBeCloseTo(100 / (8 * Math.log(2)), 8);
    expect(Number(inst.match(/^Zero:(.*)$/m)![1])).toBeCloseTo(0.05, 10);
    const py = e.find((x) => x.name === "build_gpx.py")!.data as string;
    expect(py).toContain("'Limits': [20, 140]");
    expect(py).toContain("'lin interpolate'");
  });

  it("names what neither program receives", () => {
    const withDisp = {
      ...opts,
      params: [...params, { id: "disp", label: "D", kind: "sampleDisplacement" as const, value: 1, initialValue: 0, fixed: false }],
      bindings: [...bindings, { parameterId: "disp", kind: "sampleDisplacement" as const, targetId: "pat" }],
    };
    const readme = refinementBundle("fullprof", lamno3, cwPattern, withDisp).find((e) => e.name === "README.txt")!.data as string;
    expect(readme).toContain("Not carried by this file");
    expect(readme).toContain("sample displacement");
  });

  it("a direct fullprofBundle call still works without a refined profile", () => {
    const e = fullprofBundle(lamno3, cwPattern);
    expect((e.find((x) => x.name === "LaMnO3.dat")!.data as string).startsWith("XYDATA")).toBe(true);
  });
});
